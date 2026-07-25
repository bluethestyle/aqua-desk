-- PostgREST에 aquadesk 스키마 노출 (GUARDRAILS: 게임 테이블·RPC는 전부 aquadesk).
-- 대시보드 Exposed schemas와 동일한 효과를 in-database 설정으로 고정 —
-- 새 프로젝트에 db push만 해도 노출이 재현된다. config.toml [api].schemas와 정합 유지.
alter role authenticator set pgrst.db_schemas = 'public, graphql_public, aquadesk';
notify pgrst, 'reload config';
