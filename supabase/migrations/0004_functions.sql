-- ════════════════════════════════════════════════════════════════════════
-- 0004_functions.sql — 서버 권위 RPC (SECURITY DEFINER)
-- SoT: GUARDRAILS.md §4.3 (시그니처 고정) + §6 (경제 상수)
--      + 설계서/02-데이터-모델.md §4 + 설계서/04-웹앱-백엔드-설계.md §5
-- ════════════════════════════════════════════════════════════════════════
set search_path = aquadesk, extensions, public;
-- 규칙:
--  · 모든 상태변경 RPC는 version CAS: UPDATE ... WHERE id=? AND version=?
--    → 0행이면 'conflict' 반환(jsonb) → 클라 refresh. (last-write-wins 금지)
--  · 보호 컬럼을 쓰는 RPC(feed_fish/clean_aquarium/collect_offline/
--    set_aquarium_theme)는 ★첫 줄에 perform set_config('app.authority_write','on',true).
--  · SECURITY DEFINER + 적절한 grant execute to authenticated.
--  · GUARDRAILS §3: RPC 명명은 snake_case.
-- ════════════════════════════════════════════════════════════════════════

-- ── 경제 상수 (game-spec SoT 미러; 튜닝 시 game-spec과 동기화) ──────────
-- 스태미나: cap 5 (패스 +2 = 7), 재생 +1 / 30분, 낚시 1회 -1
-- 오프라인: 어종당 10 × growth_stage coin/h × (1+coin_rate_bonus), cap 6h(무료)/24h(패스)
-- 하트→코인: 100 hearts → 1000 coins (claim 시 자동)
-- send_heart: 대상별 일 5회

-- ════════════════════════════════════════════════════════════════════════
-- start_fishing(spot_id text) → uuid
--   lazy 스태미나 재생(stamina_updated_at 기준 +1/30분, cap) → -1 →
--   fishing_sessions insert → session_id. 부족 시 거부(exception).
--   ※ 보호 컬럼 미사용(wallets는 권위 테이블이나 보호 컬럼 트리거 없음). GUC 불필요.
-- ════════════════════════════════════════════════════════════════════════
create or replace function start_fishing(spot_id text)
returns uuid
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
declare
  v_uid          uuid := auth.uid();
  v_cap          int;
  v_regen        int;
  v_new_stamina  int;
  v_now          timestamptz := now();
  v_session_id   uuid;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  -- spot 존재 검증.
  if not exists (select 1 from fishing_spots fs where fs.id = spot_id) then
    raise exception 'unknown_spot' using errcode = 'P0001';
  end if;

  -- lazy 재생 계산 + 차감을 한 UPDATE에서 원자적으로 수행.
  -- cap = 5 + (패스 보유 시 2). regen = floor(경과분/30).
  update wallets w
  set
    stamina = (
      least(
        (case when p.aqua_pass_until is not null and p.aqua_pass_until > v_now then 7 else 5 end),
        w.stamina + floor(extract(epoch from (v_now - w.stamina_updated_at)) / 1800.0)::int
      )
    ) - 1,
    stamina_updated_at = v_now
  from profiles p
  where w.user_id = v_uid
    and p.id = v_uid
    -- 재생 반영 후 스태미나가 1 이상이어야 차감 가능(부족 시 0행 → 거부).
    and least(
          (case when p.aqua_pass_until is not null and p.aqua_pass_until > v_now then 7 else 5 end),
          w.stamina + floor(extract(epoch from (v_now - w.stamina_updated_at)) / 1800.0)::int
        ) >= 1
  returning w.stamina into v_new_stamina;

  if v_new_stamina is null then
    raise exception 'insufficient_stamina' using errcode = 'P0001';
  end if;

  insert into fishing_sessions(user_id, spot_id)
  values (v_uid, spot_id)
  returning id into v_session_id;

  return v_session_id;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- feed_fish(aquarium_id uuid)  [보호 컬럼 → GUC 필수]
--   hunger↑ (어항 내 물고기) + version CAS. 소유 검증.
-- ════════════════════════════════════════════════════════════════════════
create or replace function feed_fish(aquarium_id uuid)
returns jsonb
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
declare
  v_uid     uuid := auth.uid();
  v_ver     int;
  v_new_ver int;
begin
  -- ★보호 컬럼(aquariums.version 등) 쓰기 → guard 트리거 통과를 위해 첫 줄에 설정.
  perform set_config('app.authority_write', 'on', true);

  if v_uid is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  -- 소유 검증 + 현재 version 잠금.
  select a.version into v_ver
  from aquariums a
  where a.id = aquarium_id and a.user_id = v_uid
  for update;

  if v_ver is null then
    raise exception 'not_found_or_forbidden' using errcode = '42501';
  end if;

  -- 어항 내 물고기 hunger 회복(1.0 cap), last_fed_at 갱신.
  update fish_instances fi
  set hunger = least(1.0, fi.hunger + 0.5),
      last_fed_at = now()
  where fi.aquarium_id = feed_fish.aquarium_id;   -- 파라미터를 함수명으로 한정(컬럼명 모호 해소)

  -- version CAS: UPDATE ... WHERE id=? AND version=?
  update aquariums a
  set version = a.version + 1,
      updated_at = now()
  where a.id = aquarium_id and a.version = v_ver
  returning a.version into v_new_ver;

  if v_new_ver is null then
    return jsonb_build_object('status', 'conflict');
  end if;

  return jsonb_build_object('status', 'ok', 'version', v_new_ver);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- clean_aquarium(aquarium_id uuid)  [보호 컬럼 → GUC 필수]
--   water_quality = 1.0 + version CAS. 소유 검증.
-- ════════════════════════════════════════════════════════════════════════
create or replace function clean_aquarium(aquarium_id uuid)
returns jsonb
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
declare
  v_uid     uuid := auth.uid();
  v_ver     int;
  v_new_ver int;
begin
  perform set_config('app.authority_write', 'on', true);

  if v_uid is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  select a.version into v_ver
  from aquariums a
  where a.id = aquarium_id and a.user_id = v_uid
  for update;

  if v_ver is null then
    raise exception 'not_found_or_forbidden' using errcode = '42501';
  end if;

  -- version CAS + water_quality 회복.
  update aquariums a
  set water_quality = 1.0,
      version = a.version + 1,
      updated_at = now()
  where a.id = aquarium_id and a.version = v_ver
  returning a.version into v_new_ver;

  if v_new_ver is null then
    return jsonb_build_object('status', 'conflict');
  end if;

  return jsonb_build_object('status', 'ok', 'version', v_new_ver);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- collect_offline(aquarium_id uuid) → bigint  [보호 컬럼 → GUC 필수]
--   오프라인 코인 적립 + last_collected_at 갱신. version CAS.
--   적립 = Σ(어종당 10 × growth_stage) × capped_hours × (1+coin_rate_bonus)
--   cap: 6h(무료) / 24h(패스). 반환 = 적립 코인(bigint).
-- ════════════════════════════════════════════════════════════════════════
create or replace function collect_offline(aquarium_id uuid)
returns bigint
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
declare
  v_uid        uuid := auth.uid();
  v_ver        int;
  v_new_ver    int;
  v_last       timestamptz;
  v_now        timestamptz := now();
  v_cap_hours  numeric;
  v_hours      numeric;
  v_base_rate  numeric;       -- Σ 10 × growth_stage (coin/h, 버프 전)
  v_bonus      real;
  v_earned     bigint;
begin
  perform set_config('app.authority_write', 'on', true);

  if v_uid is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  -- 소유 검증 + version + last_collected_at 잠금.
  select a.version, a.last_collected_at into v_ver, v_last
  from aquariums a
  where a.id = aquarium_id and a.user_id = v_uid
  for update;

  if v_ver is null then
    raise exception 'not_found_or_forbidden' using errcode = '42501';
  end if;

  -- 캡(패스 24h / 무료 6h).
  select case
           when p.aqua_pass_until is not null and p.aqua_pass_until > v_now then 24
           else 6
         end
    into v_cap_hours
  from profiles p where p.id = v_uid;

  -- 경과 시간(시간 단위), 캡 적용.
  v_hours := least(v_cap_hours, extract(epoch from (v_now - v_last)) / 3600.0);
  if v_hours < 0 then
    v_hours := 0;
  end if;

  -- 어종당 10 × growth_stage 합산.
  select coalesce(sum(10 * fi.growth_stage), 0)
    into v_base_rate
  from fish_instances fi
  where fi.aquarium_id = collect_offline.aquarium_id;   -- 파라미터를 함수명으로 한정(모호 해소)

  -- coin_rate_bonus(도감/시너지 버프).
  select w.coin_rate_bonus into v_bonus from wallets w where w.user_id = v_uid;

  v_earned := floor(v_base_rate * v_hours * (1 + coalesce(v_bonus, 0)))::bigint;

  -- version CAS + last_collected_at 갱신(보호 컬럼).
  update aquariums a
  set last_collected_at = v_now,
      version = a.version + 1,
      updated_at = v_now
  where a.id = aquarium_id and a.version = v_ver
  returning a.version into v_new_ver;

  if v_new_ver is null then
    -- 충돌: 코인 미적립(클라가 refresh 후 재시도). 음수로 충돌 신호.
    return -1::bigint;
  end if;

  -- 코인 적립(권위 테이블 wallets — 보호 컬럼 없음, DEFINER가 RLS 우회).
  if v_earned > 0 then
    update wallets w
    set coins = w.coins + v_earned
    where w.user_id = v_uid;
  end if;

  return v_earned;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- purchase_item(item_id text)
--   가격(price_coin/price_pearl) 원자 차감 + inventory upsert.
--   ※ wallets는 권위 테이블이나 보호 컬럼 트리거 없음 → GUC 불필요.
-- ════════════════════════════════════════════════════════════════════════
create or replace function purchase_item(item_id text)
returns jsonb
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
declare
  v_uid    uuid := auth.uid();
  v_coin   int;
  v_pearl  int;
  v_ok     boolean := false;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  select i.price_coin, i.price_pearl into v_coin, v_pearl
  from items i where i.id = item_id;

  if not found then
    raise exception 'unknown_item' using errcode = 'P0001';
  end if;

  -- 가격 통화 결정: pearl 가격이 있으면 진주, 아니면 코인. (둘 다 없으면 거부)
  if v_pearl is not null then
    -- 진주 원자 차감(조건부 차감 = CAS).
    update wallets w
    set pearls = w.pearls - v_pearl
    where w.user_id = v_uid and w.pearls >= v_pearl;
    v_ok := found;
  elsif v_coin is not null then
    update wallets w
    set coins = w.coins - v_coin
    where w.user_id = v_uid and w.coins >= v_coin;
    v_ok := found;
  else
    raise exception 'item_not_purchasable' using errcode = 'P0001';
  end if;

  if not v_ok then
    return jsonb_build_object('status', 'insufficient_funds');
  end if;

  -- inventory upsert(+1).
  insert into inventory(user_id, item_id, qty)
  values (v_uid, item_id, 1)
  on conflict (user_id, item_id)
  do update set qty = inventory.qty + 1;

  return jsonb_build_object('status', 'ok', 'item_id', item_id);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- set_aquarium_theme(aquarium_id uuid, theme_id text)  [보호 컬럼 → GUC 필수]
--   소유 검증 + 프리미엄 테마는 인벤토리(items.type='theme') 보유 검증 후
--   theme_id 변경. version CAS.
-- ════════════════════════════════════════════════════════════════════════
create or replace function set_aquarium_theme(aquarium_id uuid, theme_id text)
returns jsonb
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
declare
  v_uid       uuid := auth.uid();
  v_ver       int;
  v_new_ver   int;
  v_premium   boolean;
  v_owned     boolean;
begin
  perform set_config('app.authority_write', 'on', true);

  if v_uid is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  -- 테마 존재 + 프리미엄 여부.
  select t.is_premium into v_premium from themes t where t.id = theme_id;
  if not found then
    raise exception 'unknown_theme' using errcode = 'P0001';
  end if;

  -- 소유 검증 + version 잠금.
  select a.version into v_ver
  from aquariums a
  where a.id = aquarium_id and a.user_id = v_uid
  for update;

  if v_ver is null then
    raise exception 'not_found_or_forbidden' using errcode = '42501';
  end if;

  -- 프리미엄 테마면 해당 테마 스킨 아이템 보유(inventory) 검증.
  if v_premium then
    select exists (
      select 1
      from inventory inv
      join items it on it.id = inv.item_id
      where inv.user_id = v_uid
        and it.type = 'theme'
        and it.theme_id = set_aquarium_theme.theme_id
        and inv.qty > 0
    ) into v_owned;

    if not v_owned then
      return jsonb_build_object('status', 'theme_not_owned');
    end if;
  end if;

  -- version CAS + theme_id 변경(보호 컬럼).
  update aquariums a
  set theme_id = set_aquarium_theme.theme_id,
      version = a.version + 1,
      updated_at = now()
  where a.id = aquarium_id and a.version = v_ver
  returning a.version into v_new_ver;

  if v_new_ver is null then
    return jsonb_build_object('status', 'conflict');
  end if;

  return jsonb_build_object('status', 'ok', 'version', v_new_ver, 'theme_id', set_aquarium_theme.theme_id);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- issue_share_token(aquarium_idx int) → text
--   16자+ 불투명 토큰 생성·저장, 토큰만 반환. (user_id 미노출)
--   ※ share_tokens는 RPC 전용(정책 없음). DEFINER가 RLS 우회.
-- ════════════════════════════════════════════════════════════════════════
create or replace function issue_share_token(aquarium_idx int)
returns text
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
declare
  v_uid   uuid := auth.uid();
  v_token text;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  -- 어항 소유 검증.
  if not exists (
    select 1 from aquariums a
    where a.user_id = v_uid and a.idx = aquarium_idx
  ) then
    raise exception 'not_found_or_forbidden' using errcode = '42501';
  end if;

  -- 불투명 토큰: 24자 base64url(16바이트보다 큼 → 16자+ 요건 충족).
  v_token := translate(encode(gen_random_bytes(18), 'base64'), '+/=', 'xyz');

  insert into share_tokens(token, user_id, aquarium_idx, expires_at)
  values (v_token, v_uid, aquarium_idx, now() + interval '30 days');

  return v_token;   -- ★토큰만 반환(user_id 절대 미반환)
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- get_shared_aquarium(token text) → jsonb
--   만료 검사 후 read-only 스냅샷 반환. ★user_id 절대 미반환.
-- ════════════════════════════════════════════════════════════════════════
create or replace function get_shared_aquarium(token text)
returns jsonb
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
declare
  v_user_id  uuid;
  v_idx      int;
  v_aq       aquariums%rowtype;
  v_fish     jsonb;
begin
  -- 토큰 → user 매핑(내부 처리, 외부 미노출).
  select st.user_id, st.aquarium_idx into v_user_id, v_idx
  from share_tokens st
  where st.token = get_shared_aquarium.token
    and (st.expires_at is null or st.expires_at > now());

  if v_user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select a.* into v_aq
  from aquariums a
  where a.user_id = v_user_id and a.idx = v_idx;

  if v_aq.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- 물고기 스냅샷(배경 렌더 경량 포맷, user_id 없음).
  -- ★FishSnapshot 계약(@aquadesk/game-spec types.ts)과 일치: bodyType 포함, x/y는 초기 배치 힌트.
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',          fi.id,
      'speciesId',   fi.species_id,
      'bodyType',    fs.body_type,
      'nickname',    fi.nickname,
      'nature',      fi.nature,
      'growthStage', fi.growth_stage,
      'sizePct',     fi.size_pct,
      'satisfied',   (fi.hunger > 0 and v_aq.water_quality > 0.3),
      -- x/y: 초기 배치 힌트(서버 시드). 런타임 위치 권위는 네이티브 FSM(GUARDRAILS §5).
      'x',           round((abs(hashtext(fi.id::text)) % 1000) / 1000.0, 4),
      'y',           round((abs(hashtext(fi.id::text || ':y')) % 1000) / 1000.0, 4)
    )
  ), '[]'::jsonb)
  into v_fish
  from fish_instances fi
  join fish_species fs on fs.id = fi.species_id
  where fi.aquarium_id = v_aq.id;

  -- ★user_id를 절대 포함하지 않는 read-only 스냅샷.
  -- 'status' 외 필드는 AquariumSnapshot 계약(game-spec types.ts)과 일치.
  return jsonb_build_object(
    'status',       'ok',
    'version',      v_aq.version,
    'themeId',      v_aq.theme_id,
    'dayNight',     coalesce((select p.settings->>'dayNight' from profiles p where p.id = v_user_id), 'auto'),
    'waterQuality', v_aq.water_quality,
    'slots',        v_aq.slots,
    'fish',         v_fish,
    'pendingAnims', '[]'::jsonb
  );
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- send_heart(to_token text)
--   토큰→대상 user 해석, 자기선물 차단, 대상별 일 5회 레이트리밋, gifts insert.
-- ════════════════════════════════════════════════════════════════════════
create or replace function send_heart(to_token text)
returns jsonb
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
declare
  v_from   uuid := auth.uid();
  v_to     uuid;
  v_today  int;
begin
  if v_from is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  -- 토큰 → 대상 user(불투명, 외부 미노출).
  select st.user_id into v_to
  from share_tokens st
  where st.token = send_heart.to_token
    and (st.expires_at is null or st.expires_at > now());

  if v_to is null then
    return jsonb_build_object('status', 'invalid_token');
  end if;

  -- ★자기선물 차단.
  if v_to = v_from then
    return jsonb_build_object('status', 'self_gift_blocked');
  end if;

  -- 대상별 일 5회 레이트리밋(같은 from→to, 오늘 보낸 하트 수).
  select count(*) into v_today
  from gifts g
  where g.to_user_id = v_to
    and g.from_user_id = v_from
    and g.type = 'heart'
    and g.created_at >= date_trunc('day', now());

  if v_today >= 5 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  insert into gifts(to_user_id, from_user_id, type, qty)
  values (v_to, v_from, 'heart', 1);

  return jsonb_build_object('status', 'ok');
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- claim_gifts() → int
--   미수령 gifts → wallets.hearts 적립 + claimed=true.
--   hearts 임계(100) 도달 시 claim 내에서 코인 환산(100 hearts → 1000 coins).
--   반환 = 이번에 수령한 하트 수.
-- ════════════════════════════════════════════════════════════════════════
create or replace function claim_gifts()
returns int
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
declare
  v_uid     uuid := auth.uid();
  v_claimed int;
  v_hearts  int;
  v_convert int;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  -- 미수령 하트 합산 + claimed 처리(원자).
  with c as (
    update gifts g
    set claimed = true
    where g.to_user_id = v_uid
      and g.claimed = false
      and g.type = 'heart'
    returning g.qty
  )
  select coalesce(sum(qty), 0) into v_claimed from c;

  if v_claimed = 0 then
    return 0;
  end if;

  -- hearts 적립.
  update wallets w
  set hearts = w.hearts + v_claimed
  where w.user_id = v_uid
  returning w.hearts into v_hearts;

  -- 하트→코인 자동 환산: 100 hearts → 1000 coins (가능한 만큼 반복).
  v_convert := v_hearts / 100;   -- 정수 나눗셈
  if v_convert > 0 then
    update wallets w
    set hearts = w.hearts - (v_convert * 100),
        coins  = w.coins  + (v_convert * 1000)
    where w.user_id = v_uid;
  end if;

  return v_claimed;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 권한: 익명/일반 사용자(authenticated)가 RPC를 호출할 수 있게 grant.
-- (DEFINER 함수가 RLS를 우회해 권위 쓰기를 수행한다. 직접 테이블 쓰기는 여전히 거부.)
-- get_shared_aquarium은 비로그인 뷰어(anon)도 호출 가능해야 한다(공유 링크).
-- ════════════════════════════════════════════════════════════════════════
grant execute on function start_fishing(text)                  to authenticated;
grant execute on function feed_fish(uuid)                      to authenticated;
grant execute on function clean_aquarium(uuid)                 to authenticated;
grant execute on function collect_offline(uuid)               to authenticated;
grant execute on function purchase_item(text)                  to authenticated;
grant execute on function set_aquarium_theme(uuid, text)       to authenticated;
grant execute on function issue_share_token(int)               to authenticated;
grant execute on function get_shared_aquarium(text)            to authenticated, anon;
grant execute on function send_heart(text)                     to authenticated;
grant execute on function claim_gifts()                        to authenticated;
