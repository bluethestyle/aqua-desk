# supabase — Aqua Desk DB (스키마 · RLS · 트리거 · RPC · 시드)

> 단일 진실원: 루트 [`GUARDRAILS.md`](../GUARDRAILS.md) §4(계약·RLS/RPC), §6(경제 상수)
> 와 [`설계서/02-데이터-모델.md`](../설계서/02-데이터-모델.md). 충돌 시 **GUARDRAILS 우선**.

서버 권위(Server Authority) 모델: 경제·수집·결제·토큰 상태는 **클라가 직접 쓰지 않는다.**
모든 증감은 `SECURITY DEFINER` 함수 또는 service-role Edge Function으로만 수행하며,
클라이언트는 **자기 행 SELECT만** 한다.

---

## 파일 / 적용 순서

마이그레이션은 번호 순서대로 적용된다(GUARDRAILS §8).

| 순서 | 파일 | 내용 |
|------|------|------|
| 1 | `migrations/0001_schema.sql`  | 모든 테이블 + FK + 인덱스 |
| 2 | `migrations/0002_rls.sql`     | RLS 정책(권위 SELECT-only / 토큰 거부 / owner 제한 UPDATE / 카탈로그 public read) |
| 3 | `migrations/0003_triggers.sql`| `app_is_server_write()`, `handle_new_user()`, guard 트리거 |
| 4 | `migrations/0004_functions.sql`| 서버 권위 RPC(SECURITY DEFINER) 본문 + grant |
| 5 | `seed.sql`                    | 카탈로그 시드(themes/fish_species/items/fishing_spots/synergies) |

> ⚠️ 배포 후에는 기존 마이그레이션 파일을 in-place 편집하지 말고 **새 번호 파일**로 추가한다.

---

## 로컬 개발

Supabase CLI 필요(`npm i -g supabase` 또는 스코프 설치). 프로젝트 루트에 `supabase/config.toml`이
있어야 CLI가 이 디렉토리를 인식한다(`supabase init`으로 생성).

```bash
# Docker로 로컬 스택 기동
supabase start

# 전체 재적용(0001→0004) + seed.sql 재실행 — 가장 자주 쓰는 명령
supabase db reset
```

`supabase db reset`은 마이그레이션을 처음부터 다시 적용하고 `seed.sql`을 실행한다(로컬 전용).

---

## 배포 (원격 프로젝트)

```bash
# 프로젝트 링크(최초 1회)
supabase link --project-ref <PROJECT_REF>

# 마이그레이션을 원격 DB에 적용
supabase db push
```

CI에서 `supabase db push`로 적용한다. seed는 카탈로그 초기화 용도이며,
원격 카탈로그 갱신은 멱등 `on conflict` 구문으로 안전하게 재실행할 수 있다.

---

## ★ service role 경고 (보안)

- **service role 키는 클라/번들/로그에 절대 노출 금지**(GUARDRAILS §7, §10).
  웹(Vercel)에는 `NEXT_PUBLIC_SUPABASE_URL`·`NEXT_PUBLIC_SUPABASE_ANON_KEY`만 노출한다.
  `SUPABASE_SERVICE_ROLE_KEY`는 **Edge Function 환경변수에만** 둔다.
- `SECURITY DEFINER` ≠ `service_role`: DEFINER 함수도 `auth.role()`은 호출자(`authenticated`)다.
  보호 컬럼을 쓰는 DEFINER RPC(`feed_fish`/`clean_aquarium`/`collect_offline`/`set_aquarium_theme`)는
  쓰기 직전 `perform set_config('app.authority_write','on', true);`로 guard 트리거를 통과해야 한다.
- 권위 테이블에는 **쓰기 RLS 정책이 없다**(= anon 키 직접 INSERT/UPDATE/DELETE 전면 거부).
  합법적 쓰기는 전부 RPC가 담당한다.

---

## RPC 카탈로그 (시그니처 — GUARDRAILS §4.3 고정)

| RPC | 시그니처 | GUC | 책임 |
|-----|----------|:---:|------|
| `start_fishing`       | `start_fishing(spot_id text) → uuid`            | – | lazy 스태미나 재생 → −1 → 세션 insert |
| `feed_fish`           | `feed_fish(aquarium_id uuid)`                   | ✔ | hunger↑ + version CAS |
| `clean_aquarium`      | `clean_aquarium(aquarium_id uuid)`              | ✔ | water_quality=1 + version CAS |
| `collect_offline`     | `collect_offline(aquarium_id uuid) → bigint`    | ✔ | 오프라인 코인 적립 + last_collected_at |
| `purchase_item`       | `purchase_item(item_id text)`                   | – | 가격 원자 차감 + inventory upsert |
| `set_aquarium_theme`  | `set_aquarium_theme(aquarium_id uuid, theme_id text)` | ✔ | 소유/프리미엄 검증 후 theme_id |
| `issue_share_token`   | `issue_share_token(aquarium_idx int) → text`    | – | 16자+ 토큰만 반환 |
| `get_shared_aquarium` | `get_shared_aquarium(token text) → jsonb`       | – | read-only 스냅샷(user_id 미반환) |
| `send_heart`          | `send_heart(to_token text)`                     | – | 토큰→user, 자기선물 차단, 일 5회 |
| `claim_gifts`         | `claim_gifts() → int`                           | – | hearts 적립, 100→1000 coins 환산 |

> ✔ = 보호 컬럼 쓰기 → `set_config('app.authority_write','on',true)` 선행 필수.
> Edge Function(`fishing-resolve`/`daily-shop-roll`/`verify-receipt`/`grant-ad-reward`)은
> `supabase/functions/`에서 service-role로 구현한다(별도 패키지).
