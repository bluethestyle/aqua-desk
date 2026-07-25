-- ════════════════════════════════════════════════════════════════════════
-- 0005_grants.sql — aquadesk 스키마 권한
-- SoT: GUARDRAILS.md §4 (서버 권위)
-- ════════════════════════════════════════════════════════════════════════
-- Supabase 기본 ACL은 public 스키마만 커버한다. 격리한 aquadesk 스키마는 PostgREST가
-- 쓰는 anon/authenticated 롤에 명시적으로 권한을 줘야 한다(코스 권한). 실제 접근 제어는
-- RLS(0002)가 행 단위로 게이트한다 — 권위 테이블은 쓰기 정책이 없어 거부된다.
-- ════════════════════════════════════════════════════════════════════════

grant usage on schema aquadesk to anon, authenticated, service_role;

grant select on all tables in schema aquadesk to anon, authenticated;
-- 쓰기 권한(코스)은 부여하되 RLS가 행 단위로 막는다(권위 테이블=쓰기 정책 없음=거부,
-- aquariums.slots/profiles 일부만 owner-write 정책 허용).
grant insert, update, delete on all tables in schema aquadesk to authenticated;
grant all on all tables in schema aquadesk to service_role;

grant execute on all functions in schema aquadesk to anon, authenticated, service_role;
grant usage, select on all sequences in schema aquadesk to authenticated, service_role;

-- 이후 추가되는 객체에도 기본 권한 적용.
alter default privileges in schema aquadesk grant select on tables to anon, authenticated;
alter default privileges in schema aquadesk grant insert, update, delete on tables to authenticated;
alter default privileges in schema aquadesk grant execute on functions to anon, authenticated, service_role;
