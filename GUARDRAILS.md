# Aqua Desk — 개발 가드레일 (Single Source of Truth)

> 이 문서는 **코드·스키마·문서가 어긋나지 않도록** 하는 단일 계약서다.
> 코드를 쓰기 전 반드시 이 문서와 [`설계서/`](설계서/)를 읽는다. 충돌 시 우선순위: **GUARDRAILS > 설계서 > 기획서**.
> 결정을 바꾸려면 *먼저 이 문서를 고치고* 그다음 코드를 바꾼다.

---

## 0. 한눈에

- **무엇**: 홈/잠금 배경의 도트 수족관 라이브 배경 + 하이브리드 앱(웹 UI + 네이티브 셸). 수집·꾸미기·낚시·상점.
- **노선**: Cozy/Zen(죽음 없음). Android-first, iOS는 위젯+미러.
- **스택**: Kotlin(WallpaperService+GL ES2.0) · Next.js(Vercel) · Supabase(Postgres/RLS/Auth/Storage/Edge) · PixiJS · `packages/game-spec`(공유 TS).

---

## 1. 절대 원칙 (위반 = 리뷰 거부)

1. **서버 권위(Server Authority)**: 경제·수집·결제·토큰 상태는 **클라가 직접 쓰지 않는다**. 모든 증감은 `SECURITY DEFINER` 함수 또는 service-role Edge Function으로만. 클라는 **자기 행 SELECT**만.
2. **`SECURITY DEFINER` ≠ `service_role`**: DEFINER 함수도 `auth.role()`은 호출자(`authenticated`)다. 보호 컬럼을 쓰는 DEFINER RPC는 쓰기 직전 `perform set_config('app.authority_write','on', true);`를 호출해야 guard 트리거를 통과한다.
3. **`user_id`를 클라/URL에 노출 금지**: 공유는 불투명 `share_token` + RPC(`get_shared_aquarium`) 전용.
4. **낙관적 UI는 표시용**: 권위는 항상 서버 RPC 결과. 낚시 멱등키 = `fishing_sessions.id`, 결제 멱등키 = `purchases(platform,receipt)`.
5. **version CAS**: 모든 상태변경 RPC는 `UPDATE ... WHERE id=? AND version=?` → 0행이면 `conflict` 반환 → 클라 refresh. (last-write-wins 금지)
6. **게임 규칙의 SoT는 `packages/game-spec`**: 경제 상수·FSM·스냅샷 타입은 여기 한 곳. 웹/네이티브/문서가 이를 참조(중복 정의 금지).

---

## 2. 레포 구조 (monorepo, npm workspaces)

```
/ (repo root)
  apps/
    web/         # Next.js App Router (Vercel) — 모든 인터랙티브 UI
    android/     # Kotlin: 얇은 셸 + WallpaperService + 위젯 (P0, 추후)
    ios/         # Swift: WidgetKit + WKWebView 미러 (P1, 추후)
  packages/
    game-spec/   # 순수 TS: 스냅샷 타입 + 경제 상수 + FSM + 공식 + 테스트벡터 (I/O 없음)
  supabase/
    migrations/  # 0001_schema → 0002_rls → 0003_triggers → 0004_functions
    functions/   # Edge Functions (Deno): fishing-resolve, daily-shop-roll, verify-receipt, grant-ad-reward
    seed.sql     # 카탈로그 시드
  기획서/  설계서/  GUARDRAILS.md  CLAUDE.md
```

---

## 3. 명명 규약 (어기면 정합 깨짐)

| 대상 | 규약 | 예 |
|------|------|----|
| DB 테이블·컬럼 | `snake_case` | `fish_instances`, `coin_rate_bonus` |
| Postgres RPC(SECURITY DEFINER) | `snake_case` | `feed_fish`, `send_heart`, `start_fishing` |
| Edge Function(Deno, URL 호출) | `kebab-case` | `fishing-resolve`, `daily-shop-roll`, `verify-receipt`, `grant-ad-reward` |
| TS 타입/인터페이스 | `PascalCase` | `AquariumSnapshot`, `FishSnapshot` |
| TS 변수/함수 | `camelCase` | `regenStamina`, `coinPerHour` |
| 파일/디렉토리 | `kebab-case` | `fishing-fsm.ts` |
| 네이티브 컴포넌트 | `PascalCase` 단일명 | `QuickActionService`(❌ BackgroundService), `AquariumWallpaperService` |
| 딥링크 scheme | `aquadesk://` | `aquadesk://aquarium/{token}` |

---

## 4. 서버 권위 — RLS·트리거·RPC 계약 (단일 진실원)

설계 상세는 [설계서/02](설계서/02-데이터-모델.md)·[설계서/04 §5](설계서/04-웹앱-백엔드-설계.md). 구현은 이 표를 정확히 따른다.

### 4.1 RLS 분류
- **권위 테이블 (클라 SELECT-only, WRITE 정책 없음=거부)**: `wallets`, `inventory`, `dex_entries`, `purchases`, `gifts`, `fish_instances`(어항 소유 EXISTS join), `fishing_sessions`.
- **토큰 테이블 (정책 없음=직접 SELECT/INSERT 거부, RPC/Edge 전용)**: `share_tokens`, `ad_reward_log`(service-role Edge 전용).
- **사용자 편집 (열 제한 owner write)**: `aquariums`(클라는 `slots`만 — 단, **신규 코드는 `save_slots` RPC 사용**: version CAS가 걸려 네이티브 sync가 version 비교로 갱신을 감지한다. 직접 UPDATE는 하위호환 유지), `profiles`(클라는 `display_name`·`settings`만). 나머지 보호 컬럼은 guard 트리거가 복원.
- **카탈로그 (public read)**: `themes`, `items`, `fish_species`, `fishing_spots`, `synergies`.

### 4.2 보호 컬럼 + GUC 트리거 패턴 (★자주 틀림)
- 보호 컬럼: `aquariums.{theme_id,water_quality,version,rating,last_collected_at}`, `profiles.aqua_pass_until`.
- guard 트리거는 `app_is_server_write()`(= 세션 GUC `app.authority_write='on'` **또는** `auth.role()='service_role'`)일 때만 변경 허용.
- 보호 컬럼을 쓰는 **DEFINER RPC는 반드시** 첫 줄에 `perform set_config('app.authority_write','on', true);` (트랜잭션 한정).

### 4.3 함수/RPC 목록 — 시그니처 고정 (변경 시 이 표부터 수정)

| 이름 | 종류 | 시그니처 | GUC 필요 | 책임 |
|------|------|----------|:---:|------|
| `start_fishing` | RPC(DEF) | `start_fishing(spot_id text) → uuid` | – | lazy 스태미나 재생→`-1`→`fishing_sessions` insert→`session_id` |
| `fishing-resolve` | Edge(svc) | `(session_id uuid, skill jsonb)` | (svc) | 종/`size_pct` 결정, `fish_instances`+`dex` 쓰기, `consumed=true`, 멱등 |
| `feed_fish` | RPC(DEF) | `feed_fish(aquarium_id uuid)` | ✔ | `hunger`↑ + `version` CAS |
| `clean_aquarium` | RPC(DEF) | `clean_aquarium(aquarium_id uuid)` | ✔ | `water_quality`=1 + `version` CAS |
| `collect_offline` | RPC(DEF) | `collect_offline(aquarium_id uuid) → bigint` | ✔ | 오프라인 코인 적립 + `last_collected_at` |
| `purchase_item` | RPC(DEF) | `purchase_item(item_id text)` | – | 가격 원자 차감 + `inventory` upsert |
| `set_aquarium_theme` | RPC(DEF) | `set_aquarium_theme(aquarium_id uuid, theme_id text)` | ✔ | 소유/프리미엄 검증 후 `theme_id` |
| `save_slots` | RPC(DEF) | `save_slots(aquarium_id uuid, slots jsonb, expected_version int) → jsonb` | ✔ | slots 저장 + `version` CAS(슬롯 캡 5 검증) |
| `daily-shop-roll` | Edge | `()` | (svc) | `date+user` seed 6슬롯 |
| `verify-receipt` | Edge(svc) | `(platform text, receipt text)` | (svc) | 영수증 검증, `purchases` UNIQUE 멱등, 지급 |
| `issue_share_token` | RPC(DEF) | `issue_share_token(aquarium_idx int) → text` | – | 16자+ 토큰만 반환 |
| `get_shared_aquarium` | RPC(DEF) | `get_shared_aquarium(token text) → jsonb` | – | read-only 스냅샷, `user_id` 미반환 |
| `send_heart` | RPC(DEF) | `send_heart(to_token text)` | – | 토큰→user, 자기선물 차단, 일 5회 |
| `claim_gifts` | RPC(DEF) | `claim_gifts() → int` | – | hearts 적립, 100→1000 coins 환산 |
| `grant_ad_reward` | RPC(**svc 전용**) | `grant_ad_reward(target_user uuid, kind text, nonce text) → jsonb` | – | [멱등→한도→지급→로그] 단일 트랜잭션. 재전송(nonce 재사용)=저장된 결과 재반환. **authenticated 실행 회수**(Edge SSV 게이트 우회 방지). 상수 SoT=game-spec `AD_REWARD` |
| `grant-ad-reward` | Edge(svc) | `(kind text, ssv jsonb)` | (svc) | JWT 해석+SSV 검증(스텁 — 프로덕션 전 서명검증 교체) 후 `grant_ad_reward` RPC 위임 |

> ✔ = 보호 컬럼 쓰기 → `set_config('app.authority_write','on',true)` 선행 필수. (svc) = service-role Edge라 GUC 불필요.

---

## 5. 데이터 계약

- **`AquariumSnapshot` 등 모든 공유 타입의 SoT = `packages/game-spec/src/types.ts`.** 웹/네이티브/문서는 이를 import/참조한다.
- 스프라이트 state enum: `idle | swim | scatter | peek | yawn | sulk`. (불만족 = `satisfied=false` 파생)
- `FishSnapshot.x/y`는 **초기 배치 힌트**(서버 시드). 런타임 위치 권위는 네이티브 FSM.
- **브리지 API**(`window.AquaDesk`): `applySnapshot`, `requestSnapshot`, `previewWallpaper`, `setAuthSession`, `getAuthSession`, `clearAuthSession`, `setLowPower`. 모든 호출은 실패 콜백 + `minBridgeVersion` 협상 포함.
- **딥링크**: `aquadesk://sync-complete?version=N`, `aquadesk://aquarium/{shareToken}`, `aquadesk://login`.

---

## 6. 경제 상수 (초기값 — `packages/game-spec/src/economy.ts`에 구현, 튜닝 대상)

| 항목 | 값 |
|------|----|
| 스태미나 | 기본 cap **5**, 아쿠아 패스 **+2(=7)**. 재생 **+1 / 30분**. 낚시 1회 **−1** |
| 오프라인 코인 | 어종당 `10 × growth_stage` coin/h × `(1+coin_rate_bonus)`, 캡 **6h**(무료) / **24h**(패스) |
| 하트→코인 | **100 hearts → 1000 coins** (claim 시 자동) |
| 낚시 스킬 | 캐스팅 Perfect → 희귀확률 **+10%p**; reeling time-in-zone **≥0.9** → `size_pct` 상위 **10%** |
| 도감 버프 | 세트 완성 → `coin_rate_bonus += 0.05`. 인플레 방지: 어항2/3·장식가 비례 상향 |
| 슬롯 | 시작 **5**, 확장은 레벨/상점. 어항2 해금 = 도감 **80%** + 코인 |
| 성장 | 4단계, 먹이+시간 |

**IAP 상품 ID / 가격** (`verify-receipt` product_id):
| product_id | 가격(₩) | 지급 |
|------------|--------|------|
| `pearl_pack_10` | 1,200 | 진주 10 |
| `pearl_pack_50` | 5,500 | 진주 50(+9%) |
| `pearl_pack_115` | 12,000 | 진주 115(+15%) |
| `pearl_pack_260` | 25,000 | 진주 260(+30%) |
| `pearl_pack_540` | 49,000 | 진주 540(+35%) |
| `starter_pack` | 2,900 | 진주 30 + 한정 장식 + 코인(첫구매 1회) |
| `theme_*`(핵심) | 진주 50~80 | 테마 해금 |
| `theme_*`(한정) | 진주 120~150 | 한정 테마 |
| `hero_fish_*` | 진주 400 | 신화 어종 확정 분양 |
| `aqua_pass`(구독) | 월 1,900 | 오프라인 24h·자동관리·스태미나+2·프리미엄 슬롯 |

---

## 7. 환경 / 시크릿

- 웹(Vercel): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`만 클라 노출. **service role 키는 클라/번들/로그에 절대 금지** — Edge Function 환경변수(`SUPABASE_SERVICE_ROLE_KEY`)에만.
- 루트 `.env.example`에 키 이름만(값 없이). `.env*`는 커밋 금지(.gitignore).
- 네이티브: 세션 refresh token은 **Android Keystore / iOS Keychain** 암호화 저장. R8 단일 refresh 주체 = 네이티브.

---

## 8. 마이그레이션 / 시드

- 순서: `0001_schema.sql` → `0002_rls.sql` → `0003_triggers.sql` → `0004_functions.sql` → `seed.sql`.
- 로컬: `supabase db reset`(전체 재적용+seed) / 배포: `supabase db push`. CI에서 적용.
- 새 변경은 새 번호 파일로 추가(기존 파일 in-place 편집 금지, 배포 후).

---

## 9. 클라이언트 규약

- **웹**: 상태변경은 `supabase.rpc('feed_fish', {...})` 등 RPC 호출. 직접 `from('wallets').update()` 금지. `conflict` 응답 시 스냅샷 refresh 후 재시도. 낙관적 UI는 표시만.
- **네이티브**: IPC = **동일 프로세스 + ContentProvider 기반 `ContentObserver`**(LocalBroadcast 금지). 비가시 시 `AnimQueue` 적재→`onVisibilityChanged(true)` flush. 위젯/알림 먹이도 `feed_fish` RPC 경유(토큰 없으면 버튼 비활성+앱 열기).
- **위젯 webp**: 웹앱이 저장 시 Canvas로 생성→Storage 업로드(Edge/native 합성 금지).

---

## 10. 금지 목록 (Do NOT)

- ❌ 클라에서 `wallets/inventory/dex_entries/fish_instances/purchases/gifts/fishing_sessions` 직접 INSERT/UPDATE.
- ❌ 보호 컬럼 쓰는 RPC에서 `set_config('app.authority_write',...)` 누락.
- ❌ `SECURITY DEFINER`면 service_role이라고 가정.
- ❌ 공유 URL/응답에 `user_id` 포함.
- ❌ `LocalBroadcast`로 wallpaper IPC.
- ❌ React Native 도입(얇은 네이티브 셸 유지).
- ❌ 경제 상수/타입을 game-spec 밖에서 중복 정의.
- ❌ service role 키를 클라 번들/Next public env에 노출.

---

## 11. 빌드 순서 / 현재 상태

빌드 순서(설계서 05): **B(스키마/RLS/함수/시드) → W(로비/꾸미기) → A(배경·인증·위젯) → 상점 → 낚시 → 도감 → iOS**.

현재 스캐폴드 범위(프로토타입 시작): `packages/game-spec`, `supabase/`(migrations·functions·seed), `apps/web`(라우트 스텁), 루트 워크스페이스 설정. `apps/android`·`apps/ios`는 자리표시(추후).
