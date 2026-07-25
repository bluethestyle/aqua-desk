/**
 * Aqua Desk — economy constants (Single Source of Truth).
 *
 * Mirrors GUARDRAILS §6 (초기값 — 튜닝 대상). These constants MUST NOT be re-defined
 * outside this package (GUARDRAILS §10: "경제 상수/타입을 game-spec 밖에서 중복 정의" 금지).
 * Web / native / docs reference these named consts; native ports verify against the
 * same parity vectors (설계서/05 §6).
 *
 * Pure data — no I/O.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Stamina (GUARDRAILS §6: 기본 cap 5, 아쿠아 패스 +2(=7), 재생 +1/30분, 낚시 1회 −1)
// ─────────────────────────────────────────────────────────────────────────────

export const STAMINA = {
  /** Base maximum stamina (free). */
  baseCap: 5,
  /** Aqua Pass bonus added to the cap (=> 7 total with pass). */
  passBonus: 2,
  /** Regenerate +1 stamina per this many minutes. */
  regenMinutesPerPoint: 30,
  /** A single fishing cast costs this much stamina. */
  fishingCost: 1,
} as const;

/** Convenience: stamina cap with Aqua Pass active. */
export const STAMINA_CAP_WITH_PASS = STAMINA.baseCap + STAMINA.passBonus; // 7

// ─────────────────────────────────────────────────────────────────────────────
// Rewarded ads (GUARDRAILS §4.3 grant-ad-reward: kind별 1일 한도 + nonce 멱등)
// 서버 구현(grant_ad_reward RPC / Edge)은 이 값을 미러한다 — 여기가 SoT.
// ─────────────────────────────────────────────────────────────────────────────

export const AD_REWARD = {
  /** kind별 1일 시청 보상 한도 (UTC 일 기준). */
  dailyLimit: {
    stamina: 5,
    offline_x2: 1,
    shop_refresh: 1,
  },
  /** kind='stamina' 1회 지급량 (cap 초과분은 버려짐). */
  staminaReward: 1,
} as const;

export type AdRewardKind = keyof typeof AD_REWARD.dailyLimit;

// ─────────────────────────────────────────────────────────────────────────────
// Offline coins (GUARDRAILS §6: 어종당 10 × growth_stage coin/h × (1+coin_rate_bonus),
//                캡 6h(무료) / 24h(패스))
// ─────────────────────────────────────────────────────────────────────────────

export const OFFLINE = {
  /** Per-fish hourly coin rate factor: coinsPerHour = perFishCoinPerHourPerStage × growthStage. */
  perFishCoinPerHourPerStage: 10,
  /** Accrual cap (hours) without Aqua Pass. */
  capHoursFree: 6,
  /** Accrual cap (hours) with Aqua Pass. */
  capHoursPass: 24,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Hearts → coins (GUARDRAILS §6: 100 hearts → 1000 coins, claim 시 자동)
// ─────────────────────────────────────────────────────────────────────────────

export const HEARTS = {
  /** Conversion threshold: this many hearts convert in one step. */
  conversionThreshold: 100,
  /** Coins granted per conversion threshold reached. */
  coinsPerThreshold: 1000,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Fishing skill effects
// (GUARDRAILS §6: 캐스팅 Perfect → 희귀확률 +10%p; reeling time-in-zone ≥0.9 → size_pct 상위 10%)
// ─────────────────────────────────────────────────────────────────────────────

export const FISHING_SKILL = {
  /** Perfect cast adds this absolute probability (+10 percentage points) to rare chance. */
  castPerfectRareBonus: 0.1,
  /** time-in-zone at or above this threshold triggers a Perfect Catch. */
  perfectCatchTimeInZone: 0.9,
  /**
   * Perfect Catch raises size into the top 10% band: sizePct is mapped into [0.9, 1.0].
   * (Top 10% = floor of the resulting size band.)
   */
  perfectCatchSizeFloor: 0.9,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Dex (도감) buff
// (GUARDRAILS §6: 세트 완성 → coin_rate_bonus += 0.05. 인플레 방지: 어항2/3·장식가 비례 상향)
// ─────────────────────────────────────────────────────────────────────────────

export const DEX_BUFF = {
  /** Completing a dex set adds this to coin_rate_bonus. */
  coinRateBonusPerSet: 0.05,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Slots / growth (GUARDRAILS §6: 슬롯 시작 5; 성장 4단계)
// ─────────────────────────────────────────────────────────────────────────────

export const SLOTS = {
  /** Starting decoration slot count. Expansion via level/shop. */
  startCount: 5,
} as const;

export const GROWTH = {
  /** Number of growth stages (먹이 + 시간). */
  maxStage: 4,
  minStage: 1,
} as const;

/**
 * Aquarium-2 unlock gate (GUARDRAILS §6: 어항2 해금 = 도감 80% + 코인).
 * Dex completion fraction required (0..1).
 */
export const AQUARIUM_2_DEX_UNLOCK_FRACTION = 0.8;

// ─────────────────────────────────────────────────────────────────────────────
// IAP products (GUARDRAILS §6 / 설계서/04 §6). product_id is the verify-receipt /
// purchase_item key — keep these IDs identical to GUARDRAILS (드리프트 금지).
// ─────────────────────────────────────────────────────────────────────────────

/** Distribution channel for a product. */
export type IapChannel =
  /** Store IAP (real-money) → verify-receipt Edge Function grants. */
  | 'store_iap'
  /** In-game pearl spend → purchase_item RPC. */
  | 'pearl_spend';

export interface IapPearlPack {
  productId: string;
  /** Price in KRW (₩). */
  priceKrw: number;
  /** Pearls granted (base + bonus already folded in). */
  pearls: number;
  /** Bonus fraction over the linear base (0 for the anchor pack). */
  bonus: number;
  channel: IapChannel;
}

/**
 * (A) Pearl packs — store IAP, escalating bonus (설계서/04 §6 A).
 * Grants happen server-side via verify-receipt (purchases UNIQUE(platform, receipt) 멱등).
 */
export const PEARL_PACKS: readonly IapPearlPack[] = [
  { productId: 'pearl_pack_10', priceKrw: 1_200, pearls: 10, bonus: 0, channel: 'store_iap' },
  { productId: 'pearl_pack_50', priceKrw: 5_500, pearls: 50, bonus: 0.09, channel: 'store_iap' },
  { productId: 'pearl_pack_115', priceKrw: 12_000, pearls: 115, bonus: 0.15, channel: 'store_iap' },
  { productId: 'pearl_pack_260', priceKrw: 25_000, pearls: 260, bonus: 0.3, channel: 'store_iap' },
  { productId: 'pearl_pack_540', priceKrw: 49_000, pearls: 540, bonus: 0.35, channel: 'store_iap' },
] as const;

export interface IapStarterPack {
  productId: string;
  priceKrw: number;
  pearls: number;
  /** First-purchase-only product (1회). */
  firstPurchaseOnly: true;
  channel: IapChannel;
}

/** (B) Starter pack — first purchase only (설계서/04 §6 B). 진주 30 + 한정 장식 + 코인. */
export const STARTER_PACK: IapStarterPack = {
  productId: 'starter_pack',
  priceKrw: 2_900,
  pearls: 30,
  firstPurchaseOnly: true,
  channel: 'store_iap',
} as const;

/**
 * (C) Theme / hero products — purchased with in-game pearls (purchase_item RPC), not
 * direct store IAP (설계서/04 §6 C). product_id patterns: `theme_*`, `hero_fish_*`.
 * Concrete product_ids live in the items/themes catalog seed; these are the price bands.
 */
export const PEARL_SPEND_PRICE_BANDS = {
  /** Core/recurring theme skins (충동구매 대역). items.type='theme', themes.is_premium=true. */
  themeCoreMin: 50,
  themeCoreMax: 80,
  /** Limited / bundle themes. */
  themeLimitedMin: 120,
  themeLimitedMax: 150,
  /** Mythic hero fish, guaranteed (확정 분양, not gacha). Whale anchor. */
  heroFish: 400,
} as const;

/** Aqua Pass subscription (GUARDRAILS §6: 월 1,900 — 오프라인 24h·자동관리·스태미나+2·프리미엄 슬롯). */
export const AQUA_PASS = {
  productId: 'aqua_pass',
  priceKrwPerMonth: 1_900,
  channel: 'store_iap' as IapChannel,
} as const;
