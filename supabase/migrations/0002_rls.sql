-- ════════════════════════════════════════════════════════════════════════
-- 0002_rls.sql — Row Level Security (서버 권위)
-- SoT: GUARDRAILS.md §4.1 + 설계서/02-데이터-모델.md §2
-- ════════════════════════════════════════════════════════════════════════
-- RLS는 SELECT 권한과 WRITE 권한을 분리한다.
-- 권위 테이블은 클라가 '자기 행 SELECT만' 가능하고 쓰기 정책은 부여하지 않는다(=거부).
-- 모든 합법적 쓰기는 SECURITY DEFINER 함수 / service-role Edge Function이 수행한다.
-- ════════════════════════════════════════════════════════════════════════
set search_path = aquadesk, extensions, public;

-- ── 카탈로그: public read ──────────────────────────────────────────────
alter table themes        enable row level security;
alter table items         enable row level security;
alter table fish_species  enable row level security;
alter table fishing_spots enable row level security;
alter table synergies     enable row level security;

create policy themes_read        on themes        for select using (true);
create policy items_read         on items         for select using (true);
create policy fish_species_read  on fish_species  for select using (true);
create policy fishing_spots_read on fishing_spots for select using (true);
create policy synergies_read     on synergies     for select using (true);
-- (카탈로그 쓰기 정책 미부여 = 클라 쓰기 거부. 서버/관리자 전용.)

-- ── 권위 테이블: 자기 행 SELECT만 (쓰기 정책 없음 = 클라 거부) ─────────────
alter table wallets     enable row level security;
alter table inventory   enable row level security;
alter table dex_entries enable row level security;
alter table purchases   enable row level security;

create policy wallets_read   on wallets     for select using (auth.uid() = user_id);
create policy inventory_read on inventory   for select using (auth.uid() = user_id);
create policy dex_read       on dex_entries for select using (auth.uid() = user_id);
create policy purchases_read on purchases   for select using (auth.uid() = user_id);
-- (INSERT/UPDATE/DELETE 정책 미부여 = 클라 쓰기 거부. 쓰기는 SECURITY DEFINER 함수가 수행.)

-- gifts: 받은 선물만 SELECT (쓰기 정책 없음 → send_heart/claim_gifts RPC)
alter table gifts enable row level security;
create policy gifts_read on gifts for select using (auth.uid() = to_user_id);

-- fishing_sessions: 자기 세션 SELECT만 (쓰기 정책 없음 → start_fishing/fishing-resolve)
alter table fishing_sessions enable row level security;
create policy fishing_sessions_read on fishing_sessions for select using (auth.uid() = user_id);

-- ── fish_instances: user_id 없음 → 어항 소유 EXISTS join으로 SELECT ──────
alter table fish_instances enable row level security;
create policy fish_read on fish_instances for select using (
  exists (
    select 1 from aquariums a
    where a.id = fish_instances.aquarium_id
      and a.user_id = auth.uid()
  )
);
-- (INSERT/UPDATE/DELETE 정책 미부여 = 클라 거부. 쓰기는 SECURITY DEFINER 함수가 수행.)

-- ── share_tokens: 정책 없음 = 모든 직접 SELECT/INSERT 거부 ───────────────
alter table share_tokens enable row level security;
-- 정책을 부여하지 않는다. issue_share_token / get_shared_aquarium RPC(SECURITY DEFINER)로만 접근.

-- ── aquariums: 소유자 SELECT + slots만 클라 UPDATE ──────────────────────
alter table aquariums enable row level security;
create policy aquariums_read on aquariums
  for select using (auth.uid() = user_id);
create policy aquariums_update_slots on aquariums
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- theme_id/water_quality/version/rating/last_collected_at 변경은
-- 컬럼 단위 guard 트리거로 보호(0003_triggers.sql).

-- ── profiles: 소유자 SELECT + display_name/settings만 클라 UPDATE ────────
alter table profiles enable row level security;
create policy profiles_read on profiles
  for select using (auth.uid() = id);
create policy profiles_update_self on profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
-- aqua_pass_until 변경은 BEFORE UPDATE guard 트리거로 차단(0003_triggers.sql).

-- ════════════════════════════════════════════════════════════════════════
-- 권위 테이블의 쓰기 정책이 존재하지 않으므로 anon 키 클라이언트의 모든
-- INSERT/UPDATE/DELETE는 RLS에서 거부된다. 합법적 쓰기는 모두
-- 0004_functions.sql 의 SECURITY DEFINER 함수가 담당한다.
-- ════════════════════════════════════════════════════════════════════════
