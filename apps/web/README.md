# @aquadesk/web

Aqua Desk 웹앱 — Next.js 14 App Router. 모든 인터랙티브 UI(로비/꾸미기/상점/낚시/도감 + 공유 뷰어).
공유 게임 규칙/타입은 [`@aquadesk/game-spec`](../../packages/game-spec)을 import한다(중복 정의 금지, GUARDRAILS §1.6).

## 빠른 시작

루트에서 워크스페이스 설치 후 웹 dev 서버 실행:

```bash
npm install            # repo root (npm workspaces)
npm run dev -w apps/web # → http://localhost:3000 (/ → /lobby 리다이렉트)
```

### 환경 변수

`.env.local.example`을 복사해 채운다(커밋 금지):

```bash
cp apps/web/.env.local.example apps/web/.env.local   # PowerShell: Copy-Item ...
```

| 변수 | 설명 |
|------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 프로젝트 URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon public key (RLS 전제) |

> ★ service role 키는 **여기에 두지 않는다**. Edge Function 환경변수 전용(GUARDRAILS §7, §10).
> `NEXT_PUBLIC_*`는 빌드 시 클라 번들에 인라인되므로 anon key만 허용한다.

## 스크립트

| 명령 | 설명 |
|------|------|
| `npm run dev -w apps/web` | 개발 서버 |
| `npm run build -w apps/web` | 프로덕션 빌드 |
| `npm run start -w apps/web` | 빌드 결과 서빙 |
| `npm run lint -w apps/web` | ESLint (next/core-web-vitals) |
| `npm run typecheck -w apps/web` | `tsc --noEmit` |

## 구조

```
apps/web/
  app/
    layout.tsx                 # safe-area(네이티브 WebView) + 메타
    page.tsx                   # / → /lobby redirect
    lobby/page.tsx             # 재화·썸네일·퀵액션 (W1)
    decorate/page.tsx          # 슬롯 배치 → aquariums.slots upsert (W2)
    shop/page.tsx              # 카탈로그 + purchase_item + daily-shop-roll (W3)
    fishing/page.tsx           # Pixi + optimistic + 멱등 resolve (W4)
    dex/page.tsx               # 도감 SELECT-only (W5)
    aquarium/[token]/page.tsx  # 공유 read-only 뷰어 (P1, user_id 미노출)
  components/page-shell.tsx
  lib/
    supabase/client.ts         # anon key 클라(NEXT_PUBLIC_*)
    supabase/rpc.ts            # 서버권위 RPC/Edge 래퍼(직접 테이블 write 금지)
    bridge/index.ts            # window.AquaDesk 래퍼(game-spec 타입 + minBridgeVersion + 실패콜백)
  middleware.ts                # UA 'AquaDesk-Android' → 네이티브 모드 헤더
```

## 서버 권위 원칙 (필독 — GUARDRAILS §1, §9, §10)

- 경제·수집·결제·토큰 상태는 **클라가 직접 쓰지 않는다.** 모든 증감은 `lib/supabase/rpc.ts`의
  SECURITY DEFINER RPC(`feed_fish`, `start_fishing`, `purchase_item` …) 또는
  service-role Edge Function(`fishing-resolve`, `verify-receipt` …) 경유다.
- 클라는 **자기 행 SELECT만** 한다. 예외: `aquariums.slots`와 `profiles.{display_name,settings}`는
  owner UPDATE 허용(보호 컬럼은 guard 트리거가 복원).
- **낙관적 UI는 표시용**일 뿐 권위는 항상 서버 RPC 결과. `conflict`(version CAS 불일치) 응답 시
  스냅샷 refresh 후 재시도(GUARDRAILS §1.5).
- 멱등키: 낚시 = `fishing_sessions.id`, 결제 = `purchases(platform, receipt)`.
- 공유는 불투명 `share_token` + `get_shared_aquarium` 전용. `user_id`는 URL/응답에 노출 금지.

## 네이티브 브리지 / 세션 (R8)

- `lib/bridge/index.ts`는 `window.AquaDesk`를 `minBridgeVersion` 협상 + 실패 콜백(`BridgeError`)으로 감싼다.
- 토큰 refresh의 단일 주체는 **네이티브**다. 웹은 resume 시 `getAuthSession()`으로 네이티브 세션을
  읽어 재사용하고 독립 refresh를 하지 않는다(설계서/04 §2.1).
- `middleware.ts`는 UA `AquaDesk-Android`를 감지해 응답에 `x-aquadesk-native` 헤더를 부여한다
  (safe-area/브리지 활성화 힌트).
