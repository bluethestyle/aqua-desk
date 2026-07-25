-- ════════════════════════════════════════════════════════════════════════
-- seed.sql — 카탈로그 시드
-- SoT: GUARDRAILS.md §6 (경제 상수/가격) + 설계서/02-데이터-모델.md §1.1
-- 적용: 0001 → 0002 → 0003 → 0004 → seed.sql 순서 (supabase db reset)
-- 멱등: on conflict do nothing/update 로 재적용 안전.
-- 테이블명은 aquadesk. 로 정규화 — 원격 시드(supabase db push --include-seed)는
-- 배치 모드로 실행되어 set search_path 가 뒤 구문 파싱에 적용되지 않는다.
-- ════════════════════════════════════════════════════════════════════════
set search_path = aquadesk, extensions, public;

-- ── themes: deepsea(무료 기본) / cyberpunk / emerald ────────────────────
insert into aquadesk.themes (id, name, price_pearl, asset_prefix, shader_profile, is_premium) values
  ('deepsea',   'Deep Sea',  null, 'sprites/theme/deepsea',   'deepsea_lut',   false),  -- 기본 무료
  ('cyberpunk', 'Cyberpunk', 80,   'sprites/theme/cyberpunk', 'cyberpunk_lut', true),
  ('emerald',   'Emerald',   60,   'sprites/theme/emerald',   'emerald_lut',   true)
on conflict (id) do update set
  name           = excluded.name,
  price_pearl    = excluded.price_pearl,
  asset_prefix   = excluded.asset_prefix,
  shader_profile = excluded.shader_profile,
  is_premium     = excluded.is_premium;

-- ── fish_species: common 5 + hero 1 ────────────────────────────────────
-- rarity: common|rare|mythic, body_type: fusiform|disc|eel
insert into aquadesk.fish_species (id, rarity, body_type, base_sprite, is_hero, theme_id) values
  ('clownfish',     'common', 'disc',     'sprites/fish/clownfish',     false, null),
  ('tang',          'common', 'disc',     'sprites/fish/tang',          false, null),
  ('guppy',         'common', 'fusiform', 'sprites/fish/guppy',         false, null),
  ('neon_tetra',    'common', 'fusiform', 'sprites/fish/neon_tetra',    false, null),
  ('moray_eel',     'common', 'eel',      'sprites/fish/moray_eel',     false, null),
  -- hero: 테마 시그니처 신화 어종(deepsea).
  ('leviathan_koi', 'mythic', 'fusiform', 'sprites/fish/leviathan_koi', true,  'deepsea')
on conflict (id) do update set
  rarity      = excluded.rarity,
  body_type   = excluded.body_type,
  base_sprite = excluded.base_sprite,
  is_hero     = excluded.is_hero,
  theme_id    = excluded.theme_id;

-- ── items: deco 10 + food + theme 스킨 ──────────────────────────────────
-- type: deco|food|theme. price_pearl set이면 진주 전용, price_coin이면 코인.
insert into aquadesk.items (id, type, price_coin, price_pearl, asset_key, theme_id) values
  -- 장식 10종(코인).
  ('deco_rock_small',   'deco',  120,  null, 'sprites/deco/rock_small',   null),
  ('deco_rock_large',   'deco',  300,  null, 'sprites/deco/rock_large',   null),
  ('deco_seaweed',      'deco',  150,  null, 'sprites/deco/seaweed',      null),
  ('deco_coral_pink',   'deco',  420,  null, 'sprites/deco/coral_pink',   null),
  ('deco_coral_blue',   'deco',  420,  null, 'sprites/deco/coral_blue',   null),
  ('deco_treasure',     'deco',  800,  null, 'sprites/deco/treasure',     null),
  ('deco_shipwreck',    'deco', 1500,  null, 'sprites/deco/shipwreck',    null),
  ('deco_bubbler',      'deco',  600,  null, 'sprites/deco/bubbler',      null),
  ('deco_castle',       'deco', 1200,  null, 'sprites/deco/castle',       null),
  ('deco_lantern',      'deco',  null,  20,  'sprites/deco/lantern',      null),  -- 진주 전용 한정 장식
  -- 먹이(코인).
  ('food_basic',        'food',   50,  null, 'sprites/food/basic',        null),
  ('food_premium',      'food',  null,   5,  'sprites/food/premium',      null),
  -- 테마 스킨(진주 소비 → purchase_item 경로, themes.is_premium=true와 정합).
  ('theme_cyberpunk',   'theme',  null,  80,  'sprites/theme/cyberpunk',   'cyberpunk'),
  ('theme_emerald',     'theme',  null,  60,  'sprites/theme/emerald',     'emerald')
on conflict (id) do update set
  type        = excluded.type,
  price_coin  = excluded.price_coin,
  price_pearl = excluded.price_pearl,
  asset_key   = excluded.asset_key,
  theme_id    = excluded.theme_id;

-- ── fishing_spots: 'home' 1곳 ───────────────────────────────────────────
insert into aquadesk.fishing_spots (id, name, species_pool, rarity_weights) values
  (
    'home',
    'Home Reef',
    '["clownfish","tang","guppy","neon_tetra","moray_eel","leviathan_koi"]'::jsonb,
    '{"common":0.70,"rare":0.25,"mythic":0.05}'::jsonb
  )
on conflict (id) do update set
  name           = excluded.name,
  species_pool   = excluded.species_pool,
  rarity_weights = excluded.rarity_weights;

-- ── synergies: 샘플(물고기 + 장식 → coin_rate_bonus) ────────────────────
insert into aquadesk.synergies (id, fish_species_id, deco_item_id, bonus) values
  ('syn_clownfish_coral', 'clownfish', 'deco_coral_pink', '{"coin_rate_bonus":0.02}'::jsonb),
  ('syn_eel_shipwreck',   'moray_eel', 'deco_shipwreck',  '{"coin_rate_bonus":0.03}'::jsonb)
on conflict (id) do update set
  fish_species_id = excluded.fish_species_id,
  deco_item_id    = excluded.deco_item_id,
  bonus           = excluded.bonus;
