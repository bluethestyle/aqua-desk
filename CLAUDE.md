# CLAUDE.md — Aqua Desk

Aqua Desk = 도트 수족관 **라이브 배경** + 하이브리드 앱(웹 UI + 네이티브 셸). 수집·꾸미기·낚시·상점. Cozy/Zen 노선, Android-first.

## 코드 작성 전 필독
1. **[GUARDRAILS.md](GUARDRAILS.md)** — 단일 계약서(원칙·명명·RLS/RPC·경제 상수·금지목록). **충돌 시 최우선.**
2. [설계서/](설계서/) — 엔지니어링 설계(아키텍처·데이터모델·네이티브·웹/백엔드·스코프).
3. [기획서/](기획서/) — 제품 기획(컨셉·BM·메타).

## 절대 규칙 (요약 — 상세는 GUARDRAILS)
- **서버 권위**: 경제·수집·결제·토큰은 클라 직접 쓰기 금지. RPC/Edge(service-role)로만. 클라는 자기 행 SELECT만.
- **`SECURITY DEFINER` ≠ `service_role`**: 보호 컬럼 쓰는 DEFINER RPC는 `set_config('app.authority_write','on',true)` 선행.
- **version CAS**(last-write-wins 금지), 멱등키(`fishing_sessions.id`/`purchases UNIQUE`).
- `user_id` URL/클라 노출 금지(불투명 share_token). 게임 상수/타입 SoT = `packages/game-spec`.
- 명명: 테이블·RPC `snake_case`, Edge Function `kebab-case`, TS 타입 `PascalCase`, 파일 `kebab-case`.

## 레포 구조
`apps/web`(Next.js) · `apps/android`(Kotlin, 추후) · `apps/ios`(Swift, 추후) · `packages/game-spec`(공유 TS) · `supabase/`(migrations·functions·seed).

## 명령 (스캐폴드 후)
- 설치: `npm install` (워크스페이스)
- 웹 개발: `npm run dev -w apps/web`
- game-spec 테스트: `npm test -w packages/game-spec`
- DB 로컬: `supabase db reset` (스키마+시드 재적용)

> 결정을 바꾸려면 **먼저 GUARDRAILS.md를 고치고** 코드를 바꾼다.
