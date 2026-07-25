-- ════════════════════════════════════════════════════════════════════════
-- 0001_schema.sql — Aqua Desk DB schema
-- SoT: GUARDRAILS.md §4 + 설계서/02-데이터-모델.md §1
-- 순서: 0001_schema → 0002_rls → 0003_triggers → 0004_functions → seed.sql
-- ════════════════════════════════════════════════════════════════════════
-- 명명 규약(GUARDRAILS §3): DB 테이블/컬럼은 snake_case.
-- 카탈로그 text ID(species_id/item_id/theme_id/spot_id)는 에셋 키와 1:1.
-- 사용자 데이터는 모두 user_id 스코프.
-- ════════════════════════════════════════════════════════════════════════

-- ★스키마 격리: Aqua Desk는 전용 'aquadesk' 스키마에 격리(기존 public 데이터와 공존).
--   hosted: supabase-js는 db:{schema:'aquadesk'}로 접근하고, 대시보드 Exposed schemas에 'aquadesk' 추가.
create schema if not exists aquadesk;
set search_path = aquadesk, extensions, public;

-- gen_random_uuid()/gen_random_bytes() 보장 (Supabase는 보통 extensions 스키마에 이미 설치).
create extension if not exists "pgcrypto";

-- ── 1.1 카탈로그 (public read) ──────────────────────────────────────────

-- 테마 카탈로그 (그래픽 + 네이티브 셰이더 무드)
create table if not exists themes (
  id             text primary key,                 -- 'deepsea' | 'cyberpunk' | 'emerald' ...
  name           text not null,
  price_pearl    int,                              -- nullable(기본 무료 테마면 null)
  asset_prefix   text not null,                    -- storage 경로 prefix (sprites/theme/{id})
  shader_profile text not null,                    -- 네이티브 FX 프로파일 키 (LUT + FX 패스)
  is_premium     boolean default false
);

-- 어종 카탈로그 (시드)
create table if not exists fish_species (
  id          text primary key,
  rarity      text not null,                       -- common | rare | mythic
  body_type   text not null,                       -- fusiform | disc | eel
  base_sprite text not null,
  is_hero     boolean default false,               -- 테마 전용 도트
  theme_id    text references themes(id)           -- 테마 시그니처(nullable)
);

-- 아이템 카탈로그 (장식/먹이/테마)
create table if not exists items (
  id          text primary key,
  type        text not null,                       -- deco | food | theme
  price_coin  int,
  price_pearl int,                                 -- nullable(유료 전용이면 set)
  asset_key   text not null,
  theme_id    text references themes(id)           -- 테마 스킨이면 set
);

-- 낚시터 카탈로그 (낚시 풀 정의)
create table if not exists fishing_spots (
  id             text primary key,                 -- 'home' ...
  name           text not null,
  species_pool   jsonb not null,                   -- ["clownfish","tang",...] 후보 종
  rarity_weights jsonb not null                    -- {"common":0.7,"rare":0.25,"mythic":0.05}
);

-- 시너지 카탈로그 (물고기-장식 조합 → 버프)
create table if not exists synergies (
  id              text primary key,
  fish_species_id text references fish_species(id),
  deco_item_id    text references items(id),
  bonus           jsonb not null                   -- {"coin_rate_bonus":0.02, ...}
);

-- ── 1.2 사용자 데이터 ───────────────────────────────────────────────────

-- 사용자 프로필 (auth.users 1:1)
create table if not exists profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  display_name    text,
  aqua_pass_until timestamptz,                     -- 구독 만료(null=미구독) — 서버 전용(보호)
  settings        jsonb default '{}',              -- {dayNight, lowPower, sound...}
  created_at      timestamptz default now()
);

-- 지갑 (재화) — 권위 테이블, 클라 SELECT-only
create table if not exists wallets (
  user_id            uuid primary key references profiles(id) on delete cascade,
  coins              bigint default 0,
  pearls             int    default 0,
  stamina            int    default 5,            -- 기본 cap 5 (패스 +2 = 7)
  stamina_updated_at timestamptz default now(),
  hearts             int    default 0,            -- 소셜 카운터(임계 도달 시 코인 환산)
  coin_rate_bonus    real   default 0             -- 도감 마일스톤/시너지 버프 누적(서버 갱신)
);

-- 어항 (멀티 어항: index 1,2,...) — owner write(제한: slots만)
create table if not exists aquariums (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references profiles(id) on delete cascade,
  idx               int  not null default 1,       -- 어항 번호
  theme_id          text not null default 'deepsea' references themes(id), -- 보호 컬럼
  slots             jsonb default '[]',            -- [{slotId,itemId,x,y,layer}] — 클라 UPDATE 허용
  water_quality     real default 1.0,              -- 0..1 (청소로 회복) — 보호 컬럼
  version           int  default 1,                -- 보호 컬럼(CAS)
  rating            int  default 0,                -- 풍수/감성 점수, 서버 계산 — 보호 컬럼
  last_collected_at timestamptz default now(),     -- 오프라인 적립 기준 — 보호 컬럼
  updated_at        timestamptz default now(),
  unique (user_id, idx)
);

-- 물고기 인스턴스 (user_id 없음 → 어항 소유로 권한 유도)
create table if not exists fish_instances (
  id           uuid primary key default gen_random_uuid(),
  aquarium_id  uuid references aquariums(id) on delete cascade,
  species_id   text references fish_species(id),
  nickname     text,
  nature       text not null,                      -- timid|gluttonous|curious|lone
  growth_stage int  default 1,                     -- 1..4
  hunger       real default 1.0,                   -- 0..1 (0=불만족 진입)
  size_pct     real default 0.5,                   -- 0..1, 낚시 시 서버 산출(스킬 보정)
  last_fed_at  timestamptz default now(),
  born_at      timestamptz default now()
);
-- 불만족 상태는 satisfied=false 파생값(hunger==0 또는 water_quality 저하)으로 계산 → 별도 컬럼 불필요.

-- 인벤토리 — 권위 테이블, 클라 SELECT-only
create table if not exists inventory (
  user_id uuid references profiles(id) on delete cascade,
  item_id text references items(id),
  qty     int default 0,
  primary key (user_id, item_id)
);

-- 도감 (수집 메타의 척추) — 권위 테이블, 클라 SELECT-only
create table if not exists dex_entries (
  user_id         uuid references profiles(id) on delete cascade,
  species_id      text references fish_species(id),
  first_caught_at timestamptz default now(),
  count           int default 1,
  primary key (user_id, species_id)
);

-- 낚시 세션 (멱등·스태미나 게이트·중복지급 방지 키)
create table if not exists fishing_sessions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid references profiles(id) on delete cascade,
  spot_id                 text references fishing_spots(id),
  started_at              timestamptz default now(),
  consumed                boolean default false,   -- resolve 완료 표식(멱등)
  reward_fish_instance_id uuid references fish_instances(id)
);

-- 공유 토큰 (★불투명, user_id 비노출 R6) — RPC 전용(직접 정책 없음)
create table if not exists share_tokens (
  token        text primary key,                   -- 랜덤 16자+ 불투명
  user_id      uuid references profiles(id) on delete cascade,
  aquarium_idx int default 1,
  created_at   timestamptz default now(),
  expires_at   timestamptz
);

-- 소셜 선물(하트) — 지연 전달, 권위 테이블
create table if not exists gifts (
  id           uuid primary key default gen_random_uuid(),
  to_user_id   uuid references profiles(id) on delete cascade,
  from_user_id uuid references profiles(id),
  type         text default 'heart',
  qty          int default 1,
  claimed      boolean default false,
  created_at   timestamptz default now()
);

-- 결제 로그 — 권위 테이블(영수증 멱등)
create table if not exists purchases (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references profiles(id) on delete cascade,
  product_id text not null,
  platform   text not null,                        -- play | appstore
  receipt    text,
  verified   boolean default false,
  created_at timestamptz default now(),
  unique (platform, receipt)                       -- 영수증 멱등(중복 지급 방지)
);

-- ── 인덱스 (FK 조인 / 소유 검증 / 멱등 조회 가속) ───────────────────────
create index if not exists idx_aquariums_user            on aquariums(user_id);
create index if not exists idx_fish_instances_aquarium   on fish_instances(aquarium_id);
create index if not exists idx_fish_instances_species    on fish_instances(species_id);
create index if not exists idx_fish_species_theme        on fish_species(theme_id);
create index if not exists idx_items_theme               on items(theme_id);
create index if not exists idx_synergies_fish            on synergies(fish_species_id);
create index if not exists idx_synergies_deco            on synergies(deco_item_id);
create index if not exists idx_inventory_user            on inventory(user_id);
create index if not exists idx_dex_entries_user          on dex_entries(user_id);
create index if not exists idx_fishing_sessions_user     on fishing_sessions(user_id);
create index if not exists idx_fishing_sessions_spot     on fishing_sessions(spot_id);
create index if not exists idx_share_tokens_user         on share_tokens(user_id);
create index if not exists idx_gifts_to_user             on gifts(to_user_id);
create index if not exists idx_gifts_from_user           on gifts(from_user_id);
-- 미수령 선물 빠른 조회(claim_gifts).
create index if not exists idx_gifts_unclaimed           on gifts(to_user_id) where claimed = false;
-- send_heart 일 5회 레이트리밋 윈도 스캔 가속.
create index if not exists idx_gifts_rate                on gifts(to_user_id, from_user_id, created_at);
create index if not exists idx_purchases_user            on purchases(user_id);
