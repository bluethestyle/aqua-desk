-- ════════════════════════════════════════════════════════════════════════
-- 20260725090000_save_slots_ad_reward_log.sql
-- 1) save_slots RPC — slots 저장을 version CAS와 함께 수행(GUARDRAILS §1.5).
--    기존 owner-write(UPDATE aquariums.slots)는 하위호환으로 유지하되 신규 코드는
--    이 RPC를 쓴다 — version이 올라가므로 네이티브 sync가 version 비교만으로
--    갱신을 감지할 수 있다(README 알려진 한계 ① 해소).
-- 2) ad_reward_log — grant-ad-reward 일 횟수 제한 + SSV nonce 재사용 차단.
-- SoT: GUARDRAILS §4.3 표(같은 커밋에서 갱신). 테이블명은 aquadesk. 정규화.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1) save_slots(aquarium_id uuid, slots jsonb, expected_version int) → jsonb
create or replace function aquadesk.save_slots(aquarium_id uuid, slots jsonb, expected_version int)
returns jsonb
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
declare
  v_uid     uuid := auth.uid();
  v_new_ver int;
begin
  -- version 은 보호 컬럼 — guard 트리거 통과용 GUC (GUARDRAILS §4.2).
  perform set_config('app.authority_write', 'on', true);

  if v_uid is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  -- 형태 검증: 배열 + 슬롯 캡(시작 5칸 — game-spec SLOTS.startCount 와 정합).
  if slots is null or jsonb_typeof(slots) <> 'array' then
    raise exception 'invalid_slots' using errcode = 'P0001';
  end if;
  if jsonb_array_length(slots) > 5 then
    return jsonb_build_object('status', 'slot_cap_exceeded');
  end if;

  update aquariums a
  set slots      = save_slots.slots,
      version    = a.version + 1,
      updated_at = now()
  where a.id = save_slots.aquarium_id
    and a.user_id = v_uid
    and a.version = save_slots.expected_version
  returning a.version into v_new_ver;

  if v_new_ver is null then
    -- 소유 행은 있는데 0행 = version 불일치 → conflict(클라 refresh 후 재시도).
    if exists (
      select 1 from aquariums a
      where a.id = save_slots.aquarium_id and a.user_id = v_uid
    ) then
      return jsonb_build_object('status', 'conflict');
    end if;
    raise exception 'not_found_or_forbidden' using errcode = '42501';
  end if;

  return jsonb_build_object('status', 'ok', 'version', v_new_ver);
end;
$$;

grant execute on function aquadesk.save_slots(uuid, jsonb, int) to authenticated;

-- ── 2) ad_reward_log — service-role 전용(클라 정책 없음 = 전면 거부)
create table if not exists aquadesk.ad_reward_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references aquadesk.profiles(id) on delete cascade,
  kind       text not null check (kind in ('stamina', 'offline_x2', 'shop_refresh')),
  nonce      text not null,
  day        date not null default (now() at time zone 'utc')::date,
  created_at timestamptz not null default now(),
  -- SSV nonce 재사용(중복/재전송 콜백) 차단 — 멱등 거부의 키.
  unique (user_id, nonce)
);

create index if not exists ad_reward_log_daily_idx
  on aquadesk.ad_reward_log (user_id, kind, day);

alter table aquadesk.ad_reward_log enable row level security;
-- 정책을 부여하지 않는다 — 클라 직접 SELECT/INSERT 전면 거부.
-- 접근은 service-role Edge(grant-ad-reward)만 (0005 코스 권한은 RLS 정책 부재로 무력).

-- 0005 의 default privileges 에는 service_role 테이블 권한이 없다 → 명시 부여 필수.
grant all on table aquadesk.ad_reward_log to service_role;
