-- ════════════════════════════════════════════════════════════════════════
-- 0003_triggers.sql — 부트스트랩 + 컬럼 보호 트리거
-- SoT: GUARDRAILS.md §4.2 + 설계서/02-데이터-모델.md §3
-- ════════════════════════════════════════════════════════════════════════
set search_path = aquadesk, extensions, public;

-- ── 세션 권위 플래그 게이트 ──────────────────────────────────────────────
-- app_is_server_write():
--   세션 GUC app.authority_write='on' (보호 컬럼 쓰는 DEFINER RPC가 직전 설정)
--   OR auth.role()='service_role' (service-role Edge Function은 플래그 없이 통과).
-- ★중요(GUARDRAILS §1.2): SECURITY DEFINER ≠ service_role.
--   DEFINER 함수도 auth.role()은 호출자(authenticated)다. 따라서 보호 컬럼을 쓰는
--   DEFINER RPC는 쓰기 직전 perform set_config('app.authority_write','on',true)가 필요.
create or replace function app_is_server_write() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.authority_write', true), 'off') = 'on'
      or auth.role() = 'service_role';
$$;

-- ── 신규 사용자 부트스트랩 ───────────────────────────────────────────────
-- 회원 가입(auth.users insert) 시 profiles·wallets·기본 어항·환영 물고기를 자동 생성.
-- (앱이 동작하려면 어항이 최소 1개 필요하고 — fishing-resolve도 어항을 전제 —,
--  클라는 aquariums INSERT 권한이 없으므로 부트스트랩에서 만든다. INSERT라 guard
--  트리거(BEFORE UPDATE)는 발화하지 않는다.)
create or replace function handle_new_user() returns trigger
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
declare
  v_aq_id uuid;
begin
  insert into profiles(id) values (new.id)
    on conflict (id) do nothing;
  insert into wallets(user_id) values (new.id)
    on conflict (user_id) do nothing;

  -- 기본 어항 #1 (theme_id='deepsea' = seed 무료 기본 테마).
  insert into aquariums(user_id, idx, theme_id) values (new.id, 1, 'deepsea')
    on conflict (user_id, idx) do nothing
    returning id into v_aq_id;

  -- 환영 물고기 1마리(가장 낮은 id의 common 종). 시드가 없으면 조용히 생략.
  if v_aq_id is not null then
    insert into fish_instances (aquarium_id, species_id, nature, growth_stage, hunger, size_pct)
    select v_aq_id, fs.id, 'curious', 1, 1.0, 0.5
    from fish_species fs
    where fs.rarity = 'common'
    order by fs.id
    limit 1;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ── profiles 보호: aqua_pass_until은 서버만 변경 가능 ────────────────────
create or replace function guard_profiles() returns trigger
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
begin
  if not app_is_server_write() then
    new.aqua_pass_until := old.aqua_pass_until;   -- 보호 필드 복원
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard on profiles;
create trigger profiles_guard before update on profiles
  for each row execute function guard_profiles();

-- ── aquariums 보호: theme_id/water_quality/version/rating/last_collected_at ──
create or replace function guard_aquariums() returns trigger
language plpgsql security definer
set search_path = aquadesk, extensions, public as $$
begin
  if not app_is_server_write() then
    new.theme_id          := old.theme_id;        -- set_aquarium_theme RPC로만
    new.water_quality     := old.water_quality;
    new.version           := old.version;
    new.rating            := old.rating;
    new.last_collected_at := old.last_collected_at;
  end if;
  return new;
end;
$$;

drop trigger if exists aquariums_guard on aquariums;
create trigger aquariums_guard before update on aquariums
  for each row execute function guard_aquariums();

-- ════════════════════════════════════════════════════════════════════════
-- 클라이언트는 aquariums.slots 와 profiles.{display_name,settings}만 실효
-- 변경 가능. 그 외 보호 컬럼은 guard 트리거가 원값으로 되돌린다.
-- ════════════════════════════════════════════════════════════════════════
