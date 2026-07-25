# Aqua Desk

도트 수족관 **라이브 배경** + 하이브리드 앱(웹 UI + 네이티브 셸). 수집·꾸미기·낚시·상점.
**Cozy/Zen** 노선(죽음 없음), **Android-first**(iOS는 위젯 + 미러).

> 코드를 쓰기 전 반드시 [GUARDRAILS.md](./GUARDRAILS.md)(단일 진실원)와 [설계서/](./설계서/)를 읽는다.
> 충돌 시 우선순위: **GUARDRAILS > 설계서 > 기획서**. 결정을 바꾸려면 먼저 GUARDRAILS를 고친 뒤 코드를 고친다.

## 프로토타입 현황 (v0.1 초안)

**웹 코어 루프 전부 와이어링 완료**(서버 권위 패턴). build·typecheck·game-spec(29/29)·**DB 스모크(17/17)**·**E2E(30/30)** 모두 green.

- **DB SQL 계층**: Docker 없이 **embedded Postgres로 실제 실행 검증**(`npm run db:smoke`) — 마이그·가입 트리거·RPC·RLS·GUC 보호 트리거 실증. (이 과정에서 `feed_fish`/`collect_offline`의 `aquarium_id` 모호성 런타임 버그를 발견·수정.)
- **Hosted Supabase 연동 완료(2026-07)**: 프로젝트 `aqua-desk`(서울 `ap-northeast-2`, PG17)에 마이그레이션·시드·Edge Functions 4종 배포. 웹↔GoTrue(익명 인증)↔PostgREST↔Edge **end-to-end 라이브 왕복 검증 완료**.
- **E2E(Playwright)**: 디바이스 프로파일 **android(Pixel 7)·ios(iPhone 14 WebKit)·desktop** × 코어 루프 10테스트 = 30/30 green (`npm run test:e2e -w apps/web`). 이 과정에서 클라 버그 2건 발견·수정 — ① RPC 거부 jsonb status(`insufficient_funds` 등)를 래퍼가 삼켜 가짜 성공 표시 → `expectOkStatus()` 일괄 검사, ② 첫 로드 시 동시 `ensureSession()`으로 익명 가입 2회 레이스 → in-flight 프라미스 단일화.

| 영역 | 상태 |
|------|------|
| `packages/game-spec` | ✅ 타입·경제상수·공식·낚시 FSM (테스트 29/29) |
| `supabase` 마이그/RLS/트리거/함수/시드 | ✅ **embedded Postgres 실행 검증 17/17** (서버권위 RLS·GUC 트리거·RPC 10종·Edge 4종). `npm run db:smoke` |
| 로비 `/lobby` | ✅ 익명세션→SELECT→AquariumCanvas→feed/clean/collect RPC 왕복 + conflict 재시도 |
| 낚시 `/fishing` | ✅ start_fishing(스태미나 게이트)→FSM 미니게임→fishing-resolve(멱등) |
| 꾸미기 `/decorate` | ✅ slots owner-write 저장 + 테마변경 RPC + 미리보기 |
| 상점 `/shop` | ✅ 카탈로그 + purchase_item RPC + 인벤토리, IAP 사다리(스텁) |
| 도감 `/dex` | ✅ 희귀도 티어 그리드 + 완성도 + 버프 안내 |
| 공유 뷰어 `/aquarium/[token]` | ✅ get_shared_aquarium read-only(user_id 비노출) + send_heart |
| 계정 `/account` | ✅ 게스트→정식 전환(진행 승계) · 이메일 로그인 · 로그아웃 |
| E2E (`apps/web/e2e`) | ✅ Playwright 3 프로파일(android/ios/desktop) — UI 플로우 + API 계약(save_slots CAS·광고 한도) |
| CI (`.github/workflows/ci.yml`) | ✅ typecheck·game-spec·build + E2E 매트릭스 |
| `apps/android`, `apps/ios` | ⬜ 자리표시(추후) |

**알려진 한계/추후**: ① `purchase_item` 클라 멱등키(더블클릭은 busy 가드로만 방지) ② `grant-ad-reward` SSV는 형식 검증 스텁(서명 검증은 프로덕션 전 교체 — 일일한도·nonce 멱등은 구현됨) ③ `offline_x2`/`shop_refresh` 광고 보상은 토큰성 적립 미구현(수락만) ④ 네이티브(Android 배경/셸)·iOS 미구현.

**해소됨(2026-07-25)**: ~~slots version 미증가~~ → `save_slots` RPC(version CAS), ~~daily-shop-roll 미연결~~ → 상점 "오늘의 상점" 6슬롯, ~~광고 일일제한 없음~~ → `ad_reward_log`(한도+nonce 멱등), 계정 페이지(게스트→정식 전환·로그인·로그아웃) 추가.

## 핵심 원칙 (요약 — 상세는 GUARDRAILS)

- **서버 권위(Server Authority)**: 경제·수집·결제·토큰 상태는 클라가 직접 쓰지 않는다. 모든 증감은 `SECURITY DEFINER` 함수 또는 service-role Edge Function으로만. 클라는 자기 행 SELECT만.
- **version CAS**: 모든 상태변경 RPC는 `UPDATE ... WHERE id=? AND version=?` (불일치=conflict→클라 refresh). last-write-wins 금지.
- **단일 진실원**: 경제 상수·FSM·스냅샷 타입의 SoT = [`packages/game-spec`](./packages/game-spec/) (`@aquadesk/game-spec`). 중복 정의 금지.
- **시크릿 경계**: `NEXT_PUBLIC_*`에는 anon key만. `SUPABASE_SERVICE_ROLE_KEY`는 Edge Function 환경변수 전용(클라 번들/로그 노출 금지).

## 모노레포 구조 (npm workspaces)

```
/ (repo root)
  apps/
    web/         # Next.js (App Router, Vercel) — 모든 인터랙티브 UI. @aquadesk/game-spec import
    android/     # Kotlin: 얇은 셸 + WallpaperService(GL ES 2.0) + 위젯 (자리표시, 추후)
    ios/         # Swift: WidgetKit + WKWebView 미러 (자리표시, P1)
  packages/
    game-spec/   # 순수 TS (@aquadesk/game-spec): 스냅샷 타입 + 경제 상수 + FSM + 테스트벡터 (I/O 없음)
  supabase/
    migrations/  # 선언적 SQL 마이그레이션 (사전식 정렬 = 적용 순서)
    functions/   # Edge Functions (Deno, service-role 전용)
    seed.sql     # 카탈로그 시드 (멱등 upsert)
  기획서/  설계서/  GUARDRAILS.md  CLAUDE.md
```

워크스페이스 글롭: `apps/*`, `packages/*`. 루트는 `private: true`, `engines.node >= 20`.

## 사전 요구사항

- **Node.js 20+** (`engines.node >= 20`)
- **npm** (워크스페이스)
- 로컬 DB용 **Supabase CLI** (선택)

## 셋업

```bash
# 1) 의존성 설치 (워크스페이스 전체)
npm install

# 2) 환경변수: 예시 복사 후 값 채우기 (커밋 금지 — .gitignore 처리됨)
#    Next.js가 읽는 위치는 apps/web/.env.local 이다.
cp .env.example apps/web/.env.local
#   NEXT_PUBLIC_SUPABASE_URL       = https://<project-ref>.supabase.co
#   NEXT_PUBLIC_SUPABASE_ANON_KEY  = sb_publishable_... (신형 publishable 키가 anon 자리)
#   SUPABASE_SERVICE_ROLE_KEY(sb_secret_...)는 어디에도 넣지 않는다 —
#   hosted Edge 런타임이 자동 주입(클라/레포 금지, GUARDRAILS §7)
```

## 실행 / 개발 명령 (루트)

| 명령 | 동작 |
|------|------|
| `npm run dev` | 웹 개발 서버 (`apps/web`) |
| `npm run build` | 전체 워크스페이스 빌드 (`--if-present`) |
| `npm test` | 전체 워크스페이스 테스트 (`--if-present`) |
| `npm run typecheck` | 전체 워크스페이스 타입체크 (`--if-present`) |

개별 워크스페이스 타깃 예시:

```bash
npm run dev -w apps/web           # 웹 개발 서버
npm test -w packages/game-spec    # game-spec(경제/FSM) parity 테스트벡터
npm run test:e2e -w apps/web      # Playwright E2E (android/ios/desktop 3 프로파일)
npm run test:e2e -w apps/web -- --project=android   # 프로파일 하나만
```

> E2E는 hosted Supabase에 실제로 붙는다. 테스트마다 새 익명 유저를 만들어 격리하므로
> auth rate limit(`anonymous_users`)은 개발용으로 300/h 상향돼 있다(config.toml).

## 데이터베이스 (Supabase)

**Hosted(현재 사용 중)** — 프로젝트 `aqua-desk`(서울). CLI는 루트 devDependency(`npx supabase`):

```bash
npx supabase login                            # 최초 1회 (브라우저)
npx supabase link --project-ref <ref>         # 최초 1회 (DB 비밀번호 프롬프트)
npx supabase db push --include-seed           # 마이그레이션 + 카탈로그 시드 적용
npx supabase functions deploy --use-api       # Edge Functions 배포 (Docker 불필요)
npx supabase config push                      # config.toml → 원격 동기화 (Auth/API 설정)
```

- **원격 Auth/API 설정의 SoT는 `supabase/config.toml`** — 대시보드에서 수동 변경하면 다음 `config push`가 덮어쓴다. 설정 변경은 config.toml 수정 → push.
- `aquadesk` 스키마 노출은 마이그레이션(`20260724120000_set_pgrst_db_schemas.sql`)로 고정 — 새 프로젝트에도 `db push`만으로 재현된다.
- 원격 시드는 배치 실행이라 `set search_path`가 무시된다 → seed.sql 테이블명은 `aquadesk.` 정규화 유지.

**로컬(Docker 필요, 선택)**:

```bash
npx supabase start      # 로컬 스택 기동
npx supabase db reset   # 마이그레이션 전체 재적용 + seed (로컬)
```

마이그레이션은 선언적 SQL로만 적용한다(수동 콘솔 변경 금지). 함수/RPC는 `create or replace ...`로 멱등 작성. 상세는 [설계서/05 §4.5](./설계서/05-프로토타입-스코프-및-순서.md).

## 배포 (Vercel)

GitHub 리포(`bluethestyle/aqua-desk`) 연동 기준:

1. Vercel **New Project → Import** 후 **Root Directory = `apps/web`** 지정 (모노레포 핵심 설정. Next.js 자동 감지, 루트 lockfile로 워크스페이스 설치).
2. **Environment Variables** (Production/Preview 공통):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable 키)
   - ⚠️ `SUPABASE_SERVICE_ROLE_KEY`/`sb_secret_*`은 **절대 등록하지 않는다** (Edge Function 전용, GUARDRAILS §7)
3. (권장) Function Region **`icn1`(Seoul)** — Supabase 서울 리전과 근접.
4. 배포 후 [supabase/config.toml](./supabase/config.toml)의 `[auth] site_url`·`additional_redirect_urls`를 배포 도메인으로 갱신 → `npx supabase config push`. (익명 인증만 쓰는 동안은 영향 없지만 이메일/OAuth 도입 전 필수.)
5. 프로덕션 전환 전 점검: Edge CORS `*` → 배포 도메인 제한, auth rate limit 재조정, 이메일 확인 정책 결정.

## 문서

- **[GUARDRAILS.md](./GUARDRAILS.md)** — 단일 진실원: 원칙·명명·RLS/RPC 계약·경제 상수·금지목록 (최우선)
- [CLAUDE.md](./CLAUDE.md) — 작업 가이드 요약
- [설계서/](./설계서/) — 엔지니어링 설계
  - [01-시스템-아키텍처](./설계서/01-시스템-아키텍처.md)
  - [02-데이터-모델](./설계서/02-데이터-모델.md)
  - [03-네이티브-안드로이드-설계](./설계서/03-네이티브-안드로이드-설계.md)
  - [04-웹앱-백엔드-설계](./설계서/04-웹앱-백엔드-설계.md)
  - [05-프로토타입-스코프-및-순서](./설계서/05-프로토타입-스코프-및-순서.md)
- [기획서/](./기획서/) — 제품 기획 (컨셉·BM·메타)
