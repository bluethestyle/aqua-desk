# supabase/functions — Edge Functions (Deno, service role)

Aqua Desk 의 **서버 권위(Server Authority)** Edge Function 모음. 경제·수집·결제·토큰 상태는
클라가 직접 쓰지 않으며(GUARDRAILS §1.1), 모든 증감은 `SECURITY DEFINER` RPC 또는 여기
service-role Edge Function 으로만 수행한다.

> 단일 진실원: [`../../GUARDRAILS.md`](../../GUARDRAILS.md) (§4.3 함수표 / §6 product_id / §7 시크릿).
> 설계 상세: [`../../설계서/04-웹앱-백엔드-설계.md`](../../설계서/04-웹앱-백엔드-설계.md) §5.

## 함수 목록 (kebab-case URL)

| 함수 | URL | 입력 | 책임 | 멱등/제한 |
|------|-----|------|------|-----------|
| `fishing-resolve` | `/fishing-resolve` | `(session_id uuid, skill jsonb)` | session 미consumed 검증 → 종/`size_pct` 결정 → `fish_instances` insert + `dex_entries` upsert + `consumed=true` | **멱등 키 = `fishing_sessions.id`** (이미 consumed 면 기존 reward 반환) |
| `daily-shop-roll` | `/daily-shop-roll` | `()` | `date + user_id` seed 로 일일 6슬롯 결정적 생성(진열만; 구매는 `purchase_item` RPC) | date+user 결정적 |
| `verify-receipt` | `/verify-receipt` | `(platform text, receipt text)` | 영수증 검증(스텁) → `purchases(platform,receipt)` UNIQUE 멱등 insert → 상품ID별 지급(`pearls`/items/coins) → `verified=true` | **멱등 키 = `purchases(platform,receipt)`** |
| `grant-ad-reward` | `/grant-ad-reward` | `(kind text)` | 리워드 광고 보상 서버 지급(`stamina`/`offline_x2`/`shop_refresh`) | kind별 1일 횟수 제한 + SSV (자리) |

`_shared/supabase.ts` — service-role 클라이언트 생성 + CORS/JSON 헬퍼. **클라 번들에서 import 금지**.

## 서버 권위 / 보안 규약 (어기면 리뷰 거부)

- **service role 키는 Edge Function 환경변수(`SUPABASE_SERVICE_ROLE_KEY`)에만** 존재한다.
  클라 번들(`apps/web`, `apps/android`)·로그·스냅샷·딥링크 어디에도 절대 노출 금지(GUARDRAILS §7 / §10).
- 이 함수들은 `auth.role()='service_role'` 이므로 RLS 를 우회하고, 보호 컬럼 GUC
  플래그(`app.authority_write`)는 **불필요**하다(GUARDRAILS §4.2 / §4.3 "(svc)").
  > 대조: `SECURITY DEFINER` RPC 는 `auth.role()='authenticated'` 이므로 보호 컬럼 쓰기 전
  > `set_config('app.authority_write','on',true)` 가 필요하다. Edge Function 은 다르다.
- "누구의 행을 쓸지"는 클라가 보낸 `user_id` 를 신뢰하지 않고 **Authorization Bearer JWT**
  에서 해석한다(`getUserId(req)` — GUARDRAILS §1.3). 응답에 `user_id` 를 절대 포함하지 않는다.

## 환경변수

Supabase Edge 런타임이 기본 주입한다(별도 설정 불필요한 경우가 많음).

| 키 | 용도 |
|----|------|
| `SUPABASE_URL` | 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role 키 (RLS 우회) — **클라 노출 절대 금지** |

추가 시크릿(영수증/SSV 실연동 시)은 `supabase secrets set` 으로 주입:

```bash
# 예시 (실연동 단계 — 현재는 스텁이라 미사용)
supabase secrets set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=...      # verify-receipt (play)
supabase secrets set APPLE_APP_STORE_KEY=...                   # verify-receipt (appstore)
supabase secrets set ADMOB_SSV_PUBLIC_KEYS_URL=...             # grant-ad-reward SSV
```

## 로컬 실행

```bash
# 전제: supabase CLI 설치 + 로컬 스택 기동 (마이그레이션+seed: GUARDRAILS §8)
supabase start

# 단일 함수 서빙(핫리로드)
supabase functions serve fishing-resolve --no-verify-jwt   # 로컬 디버그용

# 호출 예시 (로컬)
curl -i -X POST http://127.0.0.1:54321/functions/v1/fishing-resolve \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"<uuid>","skill":{"castPerfect":true,"timeInZone":0.95}}'
```

## 배포

```bash
# 개별 배포
supabase functions deploy fishing-resolve
supabase functions deploy daily-shop-roll
supabase functions deploy verify-receipt
supabase functions deploy grant-ad-reward

# 또는 전체 일괄 배포
supabase functions deploy
```

> `_shared/` 디렉토리(언더스코어 prefix)는 함수가 아니라 공유 모듈이므로 개별 배포 대상이
> 아니다. import 경로(`../_shared/supabase.ts`)로 각 함수에 번들된다.

## 구현 자리(TODO) 요약

각 `index.ts` 상단/본문의 `TODO(구현 자리)` 주석 참조:

- `fishing-resolve`: 종 결정·`size_pct`·희귀 보정은 게임 규칙 SoT 인 `@aquadesk/game-spec`
  로 위임 예정(현재는 §6 공식 의도를 인라인한 임시 구현). 어항 만석/다중 어항 선택 UX.
- `daily-shop-roll`: `shop_refresh` 리롤 회차 seed 반영, 슬롯 가중치/필터.
- `verify-receipt`: Google Play / App Store 실제 영수증 검증, `starter_pack` 한정 장식 item_id,
  `aqua_pass` 구독 갱신/만료 webhook.
- `grant-ad-reward`: 광고 SSV 서명 검증(공개키), kind별 1일 횟수 제한 저장(테이블/RPC),
  `offline_x2`/`shop_refresh` 토큰성 보상 적립/소비.
