-- ════════════════════════════════════════════════════════════════════════
-- 20260725120000_grant_ad_reward_rpc.sql
-- grant-ad-reward의 [멱등검사 → 일일한도 → 지급 → 로그]를 단일 DEFINER RPC
-- (=단일 트랜잭션)로 원자화. 리뷰 확정 결함 2건 해소:
--  ① 비원자: Edge에서 로그 선기록 후 지급 실패(500) 시 로그 잔존 → 한도 소진 +
--     동일 nonce 재시도가 409로 거부되어 보상 영구 유실
--     → 재전송(nonce 재사용)은 저장된 기존 결과를 그대로 재반환(fishing-resolve식 멱등).
--  ② 레이스: stamina select→update 2왕복 사이에 start_fishing/동시 광고가 끼면
--     lost-update → 단일 UPDATE(LEAST(cap, stamina+1)) + 유저별 advisory lock.
-- 경제 상수 SoT = packages/game-spec economy.ts AD_REWARD — 아래 값은 미러(동기화 주석).
-- ════════════════════════════════════════════════════════════════════════

-- 멱등 재반환용 처리 결과 저장 컬럼.
alter table aquadesk.ad_reward_log add column if not exists result jsonb;

-- ★service_role 전용: 클라가 이 RPC를 직접 호출하면 Edge의 SSV 검증을 우회하게 되므로
--   authenticated/anon 실행 권한을 제거한다. 사용자 신원은 Edge가 JWT에서 해석해
--   target_user로 전달한다(클라 전달값 불신 원칙은 Edge 계층에서 보장 — GUARDRAILS §1.3).
create or replace function aquadesk.grant_ad_reward(target_user uuid, kind text, nonce text)
returns jsonb
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
declare
  v_uid    uuid := target_user;
  v_limit  int;
  v_today  int;
  v_prev   jsonb;
  v_stam   int;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  -- kind별 1일 한도 (미러 — SoT: game-spec AD_REWARD.dailyLimit).
  v_limit := case kind
    when 'stamina'      then 5
    when 'offline_x2'   then 1
    when 'shop_refresh' then 1
    else null
  end;
  if v_limit is null then
    raise exception 'invalid_kind' using errcode = 'P0001';
  end if;

  -- 유저 단위 직렬화: count→insert 한도 검사의 동시성 구멍 제거(트랜잭션 종료 시 해제).
  perform pg_advisory_xact_lock(hashtext(v_uid::text || ':ad_reward'));

  -- 멱등: 같은 (user, nonce)는 저장된 기존 결과를 그대로 재반환(재전송-안전 — §1.4).
  select l.result into v_prev
  from ad_reward_log l
  where l.user_id = v_uid and l.nonce = grant_ad_reward.nonce;
  if found then
    return coalesce(v_prev, jsonb_build_object('status', 'ok', 'granted', false))
           || jsonb_build_object('idempotent', true);
  end if;

  -- 일일 한도(UTC 일 기준).
  select count(*) into v_today
  from ad_reward_log l
  where l.user_id = v_uid
    and l.kind = grant_ad_reward.kind
    and l.day = (now() at time zone 'utc')::date;
  if v_today >= v_limit then
    return jsonb_build_object('status', 'daily_limit_reached');
  end if;

  -- 지급. stamina: 단일 UPDATE로 원자(cap 5 / 패스 7 — start_fishing과 동일 패턴).
  if kind = 'stamina' then
    update wallets w
    set stamina = least(
          (case when p.aqua_pass_until is not null and p.aqua_pass_until > now() then 7 else 5 end),
          w.stamina + 1   -- +1 = AD_REWARD.staminaReward 미러
        )
    from profiles p
    where w.user_id = v_uid and p.id = v_uid
    returning w.stamina into v_stam;

    if v_stam is null then
      raise exception 'no_wallet' using errcode = 'P0001';
    end if;
    v_result := jsonb_build_object('status', 'ok', 'kind', kind, 'granted', true, 'stamina', v_stam);
  else
    -- offline_x2 / shop_refresh: 토큰성 적립은 스키마 확장 후(TODO) — 수락만 기록.
    v_result := jsonb_build_object('status', 'ok', 'kind', kind, 'granted', false, 'pending', true);
  end if;

  -- 로그 = 멱등 키 + 저장 결과. 지급과 같은 트랜잭션 → 실패 시 전체 롤백(고아 행 없음).
  insert into ad_reward_log (user_id, kind, nonce, day, result)
  values (v_uid, kind, grant_ad_reward.nonce, (now() at time zone 'utc')::date, v_result);

  return v_result;
end;
$$;

-- 0005 default privileges가 함수 execute를 anon/authenticated에 자동 부여하므로 명시 회수.
revoke execute on function aquadesk.grant_ad_reward(uuid, text, text) from public, anon, authenticated;
grant execute on function aquadesk.grant_ad_reward(uuid, text, text) to service_role;
