# Aqua Desk

도트 수족관 **라이브 배경** + 하이브리드 앱(웹 UI + 네이티브 셸). 수집·꾸미기·낚시·상점.
**Cozy/Zen** 노선(죽음 없음), **Android-first**(iOS는 위젯 + 미러).

> 코드를 쓰기 전 반드시 [GUARDRAILS.md](./GUARDRAILS.md)(단일 진실원)와 [설계서/](./설계서/)를 읽는다.
> 충돌 시 우선순위: **GUARDRAILS > 설계서 > 기획서**. 결정을 바꾸려면 먼저 GUARDRAILS를 고친 뒤 코드를 고친다.

## 프로토타입 현황 (v0.1 초안)

**웹 코어 루프 전부 와이어링 완료**(서버 권위 패턴). build·typecheck·game-spec(29/29)·**DB 스모크(17/17)** 모두 green.

- **DB SQL 계층**: Docker 없이 **embedded Postgres로 실제 실행 검증**(`npm run db:smoke`) — 마이그·가입 트리거·RPC·RLS·GUC 보호 트리거 실증. (이 과정에서 `feed_fish`/`collect_offline`의 `aquarium_id` 모호성 런타임 버그를 발견·수정.)
- **미검증(인프라 제약)**: 웹↔GoTrue(인증)↔PostgREST **end-to-end 라이브 왕복**. Supabase CLI는 설치돼 있으나 `supabase start`는 **Docker 필요**(미설치 + 관리자 권한 없음 → Docker Desktop 설치 불가). 실행하려면 Docker 또는 **hosted Supabase 프로젝트**가 필요하다(아래 실행 안내).

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
| `apps/android`, `apps/ios` | ⬜ 자리표시(추후) |

**알려진 한계/추후**: ① 꾸미기 `slots` owner-write는 `version`을 못 올려 네이티브 sync는 `updated_at` 기반이거나 향후 `save_slots` RPC 필요 ② `purchase_item` 멱등키·`grant-ad-reward` 일일제한은 프로토 TODO ③ `daily-shop-roll` 미연결(상점은 카탈로그 직접 조회) ④ 네이티브/iOS 미구현.

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

# 2) 환경변수: 예시 복사 후 값 채우기 (커밋 금지)
cp .env.example .env.local
#   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY 채움
#   SUPABASE_SERVICE_ROLE_KEY 는 Edge Function 환경변수에만 (클라 금지)
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
npm run dev -w apps/web          # 웹 개발 서버
npm test -w packages/game-spec   # game-spec(경제/FSM) parity 테스트벡터
```

## 로컬 데이터베이스 (Supabase)

```bash
supabase db reset   # 마이그레이션 전체 재적용 + seed (로컬)
supabase start      # 로컬 스택 기동
```

마이그레이션은 선언적 SQL로만 적용한다(수동 콘솔 변경 금지). 함수/RPC는 `create or replace ...`로 멱등 작성. 상세는 [설계서/05 §4.5](./설계서/05-프로토타입-스코프-및-순서.md).

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
