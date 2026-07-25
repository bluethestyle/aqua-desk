# apps/android — Aqua Desk 네이티브 셸 (P0, 자리표시 / 추후 구현)

> 상태: **자리표시(placeholder)**. 실제 Kotlin 소스는 아직 없다.
> 단일 진실원은 루트 [`GUARDRAILS.md`](../../GUARDRAILS.md), 네이티브 설계 상세는
> [`설계서/03-네이티브-안드로이드-설계.md`](../../설계서/03-네이티브-안드로이드-설계.md).
> 이 README는 설계서 03의 모듈 맵 요약 + 빌드 진입점 메모만 담는다.

---

## 한 줄 요약

**Kotlin WallpaperService + GL ES2.0, 단일프로세스 ContentObserver IPC, Keystore, feed_fish RPC 경유 — 추후 구현.**

- 얇은 네이티브 셸(WebView 미러 + 라이브 배경 + 위젯)만 담당. React Native 도입 금지(GUARDRAILS §10).
- 경제·수집·결제 상태는 클라가 직접 쓰지 않는다. 모든 상태 변경은 서버 RPC(`feed_fish` / `clean_aquarium` 등) 경유(서버 권위, GUARDRAILS §1).
- **최소 SDK: API 29(Android 10), OpenGL ES 2.0.** `RenderEffect`/AGSL(API 31/33+)는 회피 → 스프라이트 파티클 + GL 셰이더로 대체.

---

## 모듈 맵 (설계서 03 §1 요약)

| 모듈 | 책임 |
|------|------|
| `AquariumWallpaperService` | Surface 생명주기, GL 컨텍스트, FPS/가시성 제어 |
| `GLRenderer` | OpenGL ES 2.0 렌더 루프, 레이어 합성, 셰이더 패스(LUT / Theme FX / Day-Night) |
| `SpriteEngine` | 아틀라스 컷, 프레임 tick(논리 12fps), 패럴랙스 |
| `FishFSM` | `idle / swim / scatter / peek / yawn / sulk` 상태 + 성격 가중치 (런타임 위치 권위) |
| `ShaderGate` | 기기 상태 → 셰이더/FPS 정책(30/15/0) |
| `TouchController` | `onTouchEvent` → ripple 파티클(3프레임 스프라이트) |
| `AnimQueue` | ★비가시 큐잉 — `pendingAnims` 재생 제어(가시 복귀 시 flush) |
| `LocalCacheStore` | `snapshot.json` + 스프라이트 번들 R/W (읽기 캐시, 권위 없음) |
| `SyncWorker` | WorkManager 주기 pull(15~30분 + resume 즉시), **네이티브 단일 refresh 주체**(R8) |
| `AuthStore` | **Android Keystore** 기반 암호화 refresh token 저장 |
| `AquariumWidgetProvider` | RemoteViews 위젯 + 버튼 `PendingIntent`(비로그인 시 비활성) |
| `QuickActionService` | 위젯/알림 액션 → **`feed_fish` / `clean_aquarium` RPC 호출(서버 권위)** + optimistic 캐시 + IPC |
| `CacheSignalProvider` | **ContentProvider** — 캐시 변경 통지 URI 노출(`ContentObserver` 대상) |
| `WallpaperBus` | **ContentObserver 래퍼** — `CacheSignalProvider` URI 구독/통지(LocalBroadcast 제거) |
| `WebAppActivity` | Fullscreen `WebView` + JS Bridge(UA에 `AquaDesk-Android`) |
| `BridgeModule` | `applySnapshot` / `requestSnapshot` / `previewWallpaper` / `setAuthSession` / `getAuthSession` / `clearAuthSession` / `setLowPower` |

> **단일 프로세스 원칙**: 위 컴포넌트는 `AndroidManifest.xml`에서 `android:process`를 **지정하지 않는다**(기본 = 앱 메인 프로세스). 제조사 절전/메모리 정책으로 위젯/서비스가 분리 기동돼도 `ContentObserver` IPC는 안전하게 통지된다(LocalBroadcast는 동일 프로세스 한정이라 누락 위험 → 제거).

---

## 핵심 계약(드리프트 금지 — GUARDRAILS와 글자 그대로 일치)

- **서버 권위 RPC(상태 변경)**: `feed_fish(aquarium_id uuid)`, `clean_aquarium(aquarium_id uuid)`, `collect_offline(aquarium_id uuid) → bigint`, `start_fishing(spot_id text) → uuid`.
  - 위젯/알림 먹이·청소도 반드시 `feed_fish` / `clean_aquarium` RPC 경유. 토큰 없으면 버튼 **비활성 + 앱 열기**(직접 캐시 쓰기 금지).
- **version CAS**: 모든 상태 변경은 `UPDATE ... WHERE id=? AND version=?`. 0행이면 `conflict` → optimistic 캐시 롤백 → 서버 스냅샷 강제 refresh.
- **IPC**: ContentProvider authority `com.aquadesk.cache`, 통지 URI `content://com.aquadesk.cache/snapshot`. `WallpaperBus`가 `notifyChange` / `registerContentObserver` 래핑.
- **딥링크 scheme**: `aquadesk://` — `aquadesk://sync-complete?version=N`, `aquadesk://aquarium/{shareToken}`, `aquadesk://login`.
- **스프라이트 state enum**: `idle | swim | scatter | peek | yawn | sulk`. 불만족(`satisfied=false`)은 스냅샷 파생(별도 컬럼 없음) → `sulk` 진입.
- **공유 타입/경제 상수 SoT**: [`@aquadesk/game-spec`](../../packages/game-spec)(`packages/game-spec`). 네이티브는 스냅샷 계약(`AquariumSnapshot` / `FishSnapshot`)을 이 패키지 정의에 맞춰 역직렬화하며, **경제 상수/타입을 네이티브에서 중복 정의하지 않는다**(GUARDRAILS §1.6, §10).
- **토큰 저장/갱신**: refresh token은 **Android Keystore** 암호화 저장. refresh→access 갱신은 `SyncWorker`(네이티브)가 **단일 주체**. 웹앱은 resume 시 `getAuthSession()`으로 네이티브 세션을 읽어 재사용(웹 독립 refresh 금지). service role 키는 네이티브에 두지 않는다.

---

## 빌드 진입점 메모 (추후 구현 — 자리표시)

```
apps/android/
  settings.gradle.kts        # TODO: rootProject + :app 모듈 포함
  build.gradle.kts           # TODO: AGP, Kotlin, compileSdk/targetSdk(34+), minSdk=29
  gradle/                    # TODO: gradle wrapper
  app/
    build.gradle.kts         # TODO: applicationId="com.aquadesk", GL ES2.0 feature, WorkManager/Keystore 의존성
    src/main/
      AndroidManifest.xml    # TODO: WallpaperService(android.service.wallpaper) + ACTION_CHANGE_LIVE_WALLPAPER
                             #       ContentProvider authority "com.aquadesk.cache"
                             #       aquadesk:// intent-filter, android:process 미지정(단일 프로세스)
      kotlin/com/aquadesk/   # TODO: 위 모듈 맵의 클래스들
      res/                   # TODO: 위젯 RemoteViews 레이아웃, 문자열
```

- **로컬 빌드(추후)**: `./gradlew :app:assembleDebug` (Windows: `gradlew.bat :app:assembleDebug`).
- **라이브 배경 설정 진입점**: 온보딩 CTA → `Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER)` + `EXTRA_LIVE_WALLPAPER_COMPONENT = ComponentName(ctx, AquariumWallpaperService::class.java)`로 **우리 서비스 선지정**(미지원 기기는 `ACTION_LIVE_WALLPAPER_CHOOSER` 폴백).
- **env / 시크릿**: `NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_ANON_KEY`만 웹뷰가 사용(클라 노출 허용). `SUPABASE_SERVICE_ROLE_KEY`는 Edge Function 전용 — **네이티브/번들/로그에 절대 금지**(GUARDRAILS §7, §10).

> TODO: 위 모든 파일/모듈은 미구현 자리표시다. 빌드 순서(설계서 05): B(스키마/RLS/함수/시드) → W(로비/꾸미기) → **A(배경·인증·위젯, = 이 패키지)** → 상점 → 낚시 → 도감 → iOS.
