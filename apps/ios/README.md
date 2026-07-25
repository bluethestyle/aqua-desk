# apps/ios — Aqua Desk iOS 셸 (P1, 자리표시 / 추후 구현)

> 상태: **자리표시(placeholder)**. 실제 Swift 소스는 아직 없다.
> 단일 진실원은 루트 [`GUARDRAILS.md`](../../GUARDRAILS.md).
> iOS는 프로토타입 후순위(P1)로, Android 배경([설계서/03](../../설계서/03-네이티브-안드로이드-설계.md))이 핵심 차별점이다.

---

## 한 줄 요약

**Swift WidgetKit + WKWebView 미러, P1 — 추후 구현.**

- iOS는 라이브 배경(라이브 월페이퍼)을 제공하지 않는다(플랫폼 제약). 대신:
  - **WidgetKit** 위젯: `snapshots/{userId}/{idx}.webp` 표시 + 딥링크(액션은 앱 열기 경유, 위젯 직접 RPC 없음).
  - **WKWebView 미러**: 웹앱(`apps/web`)을 풀스크린으로 띄워 어항을 미러링(인터랙티브 UI는 웹 단일 소스).
- React Native 도입 금지 — 얇은 네이티브 셸 유지(GUARDRAILS §10).

---

## 계약 정합(드리프트 금지 — GUARDRAILS와 글자 그대로 일치)

- **서버 권위**: 경제·수집·결제 상태는 클라가 직접 쓰지 않는다. 모든 상태 변경은 서버 RPC(`feed_fish` / `clean_aquarium` 등) 경유(GUARDRAILS §1).
- **공유 타입/경제 상수 SoT**: [`@aquadesk/game-spec`](../../packages/game-spec). 경제 상수/타입을 iOS에서 중복 정의하지 않는다(GUARDRAILS §10).
- **토큰 저장/갱신**: refresh token은 **iOS Keychain** 암호화 저장(GUARDRAILS §7). 웹앱은 네이티브 세션을 재사용(웹 독립 refresh 금지).
- **딥링크 scheme**: `aquadesk://` — `aquadesk://sync-complete?version=N`, `aquadesk://aquarium/{shareToken}`, `aquadesk://login`.
- **브리지 API**(`window.AquaDesk`): `applySnapshot` / `requestSnapshot` / `previewWallpaper`(no-op 가능) / `setAuthSession` / `getAuthSession` / `clearAuthSession` / `setLowPower`. 각 호출은 실패 콜백 + `minBridgeVersion` 협상 포함.
- **위젯 webp**: 웹앱이 `Canvas`로 생성해 Storage `snapshots/{userId}/{idx}.webp`에 업로드한 자원을 **표시만** 한다(Edge/native 합성 금지).
- **env / 시크릿**: `NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_ANON_KEY`만 웹뷰 사용. `SUPABASE_SERVICE_ROLE_KEY`는 Edge 전용 — 네이티브/번들/로그 금지(GUARDRAILS §7, §10).

---

## 빌드 진입점 메모 (추후 구현 — 자리표시)

```
apps/ios/
  AquaDesk.xcodeproj         # TODO: Xcode 프로젝트(앱 타깃 + Widget Extension 타깃)
  AquaDesk/                  # TODO: 앱 타깃 — WKWebView 미러 호스트 + JS 브리지(WKScriptMessageHandler)
  AquaDeskWidget/            # TODO: WidgetKit Extension — TimelineProvider + snapshot webp 표시
  Shared/                    # TODO: Keychain 래퍼, 딥링크(aquadesk://) 라우팅, App Group(위젯 ↔ 앱 공유)
```

> TODO: 위 모든 파일/타깃은 미구현 자리표시다. 빌드 순서(설계서 05): B → W → A → 상점 → 낚시 → 도감 → **iOS(= 이 패키지, P1 마지막)**.
