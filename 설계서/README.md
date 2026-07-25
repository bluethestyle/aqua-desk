# Aqua Desk — 프로토타입 기초 설계서

> v2 (서버권위·RLS 재작성 반영)

`기획서/`(특히 [`04-서비스-고도화-및-리스크-대응.md`](../기획서/04-서비스-고도화-및-리스크-대응.md))에서 확정된 결정을 **빌드 가능한 엔지니어링 설계**로 옮긴 문서 모음입니다.

> **v2 대원칙 — 서버 권위(Server Authority).** 경제·수집·결제·토큰 테이블(`wallets`/`inventory`/`dex_entries`/`fish_instances`/`purchases`/`gifts`/`share_tokens`)은 **클라이언트 직접 쓰기 금지**입니다. 모든 증감은 `SECURITY DEFINER` 함수 또는 service-role Edge Function으로만 수행하고, 클라이언트는 **자기 행 SELECT만** 합니다. RLS는 **SELECT 권한 / WRITE 권한**을 분리해 재작성했습니다.

## 문서 목록

| 문서 | 내용 |
|------|------|
| [01-시스템-아키텍처.md](./01-시스템-아키텍처.md) | 레이어 구성, 컴포넌트 책임, 데이터 흐름, **서버권위 동기화·인증 모델(version CAS, 익명→이메일 병합)** |
| [02-데이터-모델.md](./02-데이터-모델.md) | Postgres 스키마, **RLS(SELECT/WRITE 분리)**, **서버권위 RPC**, Storage(3단), **스냅샷 계약(JSON)**, 브리지/딥링크 API |
| [03-네이티브-안드로이드-설계.md](./03-네이티브-안드로이드-설계.md) | 배경 엔진(GL ES 2.0), 셰이더 게이팅, 터치/파티클, 위젯·알림, **비가시 큐잉·단일프로세스 IPC(ContentObserver)** |
| [04-웹앱-백엔드-설계.md](./04-웹앱-백엔드-설계.md) | Next.js 구조, **게임 로직(`packages/game-spec`, 순수 TS)**, 낚시 FSM, **서버권위 RPC/Edge Functions**, 공유 토큰 보안 |
| [05-프로토타입-스코프-및-순서.md](./05-프로토타입-스코프-및-순서.md) | 프로토타입 절단선, 빌드 순서, Done 기준, 레포 구조, 마이그레이션 절차, parity 테스트, 환경 설정 |

## 기술 스택 스냅샷 (확정)

| 영역 | 선택 | 근거 |
|------|------|------|
| Android 셸 | **Kotlin (얇은 Activity + WebView)** | RN 미채용, APK 경량 |
| Android 배경 | **Kotlin WallpaperService + OpenGL ES 2.0** | 풀스크린 셰이더, **최소 API 29** (`RenderEffect`/AGSL는 API 31/33+라 회피) |
| Android IPC | **단일 프로세스 + `ContentObserver`** | WallpaperService/QuickActionService/WidgetProvider 동일 프로세스(`android:process` 미지정), 캐시 변경 신호는 ContentProvider 기반 `ContentObserver`(LocalBroadcast 폐기) |
| Android 토큰 저장 | **Android Keystore 기반 암호화 저장** | `EncryptedSharedPreferences`(deprecated) 대체 |
| iOS | **Swift + WidgetKit + WKWebView(Mirror)** | 라이브 배경 불가 → 위젯·미러 |
| 웹앱 | **Next.js (App Router) on Vercel** | SSR/라우팅·배포 단순 |
| 게임 로직(공유) | **`packages/game-spec` (순수 TS, I/O 없음)** | web/native 공유 + parity 테스트벡터 |
| 미니게임 | **PixiJS (WebGL) / Canvas 2D** | 낚시 경량 |
| 위젯 스냅샷 | **웹앱이 Canvas로 webp 생성 → Storage 업로드** | Edge/native 합성 폐기(웹 생성 단일화) |
| 백엔드 | **Supabase** (Postgres+RLS, Auth, Storage, Edge Fn) | 일원화, **서버권위(SECURITY DEFINER RPC + service-role Edge Fn)** |
| 에셋 | **Aseprite → TexturePacker (atlas + JSON)** | 도트 표준 |

### 서버 권위 RLS 2분류 (요약 — 상세 [02 §2](./02-데이터-모델.md))

| 분류 | 테이블 | SELECT 권한 | WRITE 권한 |
|------|--------|-------------|------------|
| **권위(클라 SELECT-only)** | `wallets`·`inventory`·`dex_entries`·`purchases`·`gifts` | `auth.uid() = user_id` | **없음(서버 전용)** — SECURITY DEFINER/service-role |
| **권위(조인 SELECT-only)** | `fish_instances` | `aquariums` 소유 EXISTS join | **없음(서버 전용)** |
| **토큰(정책 없음=거부)** | `share_tokens` | 직접 거부 | 직접 거부 — `issue_share_token`/`get_shared_aquarium` RPC 전용 |
| **사용자 편집** | `aquariums`(slots만), `profiles`(display_name·settings만) | owner | owner UPDATE(일부 열만); `theme_id`·`water_quality`·`version`·`rating`·`aqua_pass_until`은 서버/RPC/트리거 보호 |
| **카탈로그(public read)** | `items`·`fish_species`·`themes`·`fishing_spots`·`synergies` | public | 서버 시드 |

### 서버 권위 RPC / Edge Function (요약 — 상세 [02](./02-데이터-모델.md) · [04 §5](./04-웹앱-백엔드-설계.md))

모두 `SECURITY DEFINER` 또는 service-role. 상태변경 RPC는 **version CAS**(불일치=conflict→클라 refresh).

- 낚시: `start_fishing(spot_id)` → `fishing-resolve(session_id, skill)` [Edge] (`fishing_sessions.id` 멱등키)
- 케어: `feed_fish(aquarium_id)` · `clean_aquarium(aquarium_id)` (위젯/알림/앱 공통, 토큰 필요)
- 방치/꾸미기: `collect_offline(aquarium_id)` · `set_aquarium_theme(...)` · `purchase_item(item_id)`
- 상점/결제: `daily-shop-roll` [Edge] · `verify-receipt(platform, receipt)` [Edge] (`purchases` UNIQUE 멱등)
- 소셜(토큰 기반): `issue_share_token(aquarium_idx)` · `get_shared_aquarium(token)` · `send_heart(to_token)` · `claim_gifts()` (하트 100→코인 1000 자동환산)
- 광고: `grant_ad_reward(kind)` [Edge] (1일 횟수 제한, SSV 검증)

## 설계가 반드시 해결하는 "핵심 이음새" (기획서 `04` R1·R6·R8)

1. **비가시 상태 먹이 → 연출 큐잉 + 단일프로세스 IPC(`ContentObserver`)** → [03 §4](./03-네이티브-안드로이드-설계.md)
   - 위젯/알림 `feed_fish`/`clean_aquarium` **서버 RPC 호출** → 로컬캐시 optimistic → `ContentObserver`(ContentProvider 기반) → Engine. 비가시 시 `AnimQueue` 적재 후 `onVisibilityChanged(true)`에 flush. (프로세스 분리 폐기로 LocalBroadcast 불필요)
2. **네이티브 백그라운드 동기화의 인증(Keystore 세션 토큰 저장)** → [03 §6](./03-네이티브-안드로이드-설계.md), [01 §5](./01-시스템-아키텍처.md)
   - 네이티브가 단일 refresh 주체(R8). 웹앱은 resume 시 `getAuthSession()` 브리지로 네이티브 세션 재사용(웹 독립 refresh 금지), invalid refresh 시 재인증 폴백.
3. **공유 링크 불투명 토큰(`user_id` 비노출)** → [02 §2](./02-데이터-모델.md), [04 §5](./04-웹앱-백엔드-설계.md)
   - `share_tokens` 직접 접근 거부, `issue_share_token`/`get_shared_aquarium` RPC 전용. 소셜은 friends 테이블 없이 **토큰 보유자 한정** 하트(레이트리밋+자기선물 차단).
4. **낚시 Optimistic UI + 서버 정합(잡았나 여부 불변)** → [04 §4](./04-웹앱-백엔드-설계.md)
   - 보상 쓰기는 전부 서버(`fishing-resolve`), `fishing_sessions.id` 멱등키. 연출 종료 후 응답 미도착이면 스피너→타임아웃 시 session 기반 재동기화('연출종료==응답도착' 가정 제거).
5. **위젯 스냅샷 webp = 웹 생성** → [03 §7](./03-네이티브-안드로이드-설계.md), [04](./04-웹앱-백엔드-설계.md)
   - 웹앱이 저장 시 Canvas로 webp 생성 → Storage 업로드. Edge/native 합성 폐기, `snapshot-export`는 메타만(또는 제거).
