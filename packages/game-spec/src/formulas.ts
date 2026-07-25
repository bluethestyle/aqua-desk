/**
 * Aqua Desk — pure economy/fishing formulas (Single Source of Truth).
 *
 * These mirror the server-authority RPC math (설계서/02 §4, 설계서/04 §5) so that
 * web optimistic UI and native prediction stay in lock-step with the server
 * (설계서/05 §6 parity). Pure functions only — no I/O, no Date.now() side effects
 * (callers pass `now`).
 *
 * IMPORTANT: the server (Supabase RPC / Edge Fn) remains the authority. These functions
 * are for display/prediction and for parity verification against server behavior.
 */

import {
  STAMINA,
  OFFLINE,
  HEARTS,
  FISHING_SKILL,
} from './economy.ts';

/** One hour in milliseconds. */
const MS_PER_HOUR = 60 * 60 * 1000;
/** One minute in milliseconds. */
const MS_PER_MINUTE = 60 * 1000;

/** Minimal shape needed from a fish row to compute offline accrual. */
export interface OfflineFish {
  /** Growth stage 1..4. */
  growthStage: number;
}

/**
 * Lazy stamina regeneration.
 *
 * Regenerates +1 per `STAMINA.regenMinutesPerPoint` minutes elapsed since `updatedAt`,
 * clamped to the cap (base 5, +2 with Aqua Pass => 7). Mirrors the lazy regen in
 * `start_fishing` (GUARDRAILS §6, 설계서/02 §4.1).
 *
 * If `current` is already at or above the cap, it is returned unchanged (no decay).
 *
 * @param current   current stamina value (server-stored)
 * @param updatedAt epoch millis of stamina_updated_at
 * @param now       epoch millis "now"
 * @param hasPass   whether Aqua Pass is active (raises cap by +2)
 * @returns regenerated stamina, clamped to the cap
 */
export function regenStamina(
  current: number,
  updatedAt: number,
  now: number,
  hasPass: boolean,
): number {
  const cap = STAMINA.baseCap + (hasPass ? STAMINA.passBonus : 0);
  if (current >= cap) return current;

  const elapsedMs = Math.max(0, now - updatedAt);
  const regened = Math.floor(elapsedMs / (STAMINA.regenMinutesPerPoint * MS_PER_MINUTE));
  return Math.min(cap, current + regened);
}

/**
 * Offline coin accrual.
 *
 * Per fish: `10 × growthStage` coins/hour, scaled by `(1 + coinRateBonus)`, summed over
 * all fish, multiplied by elapsed hours capped at 6h (free) / 24h (pass).
 * Result is floored to an integer coin amount (GUARDRAILS §6, 설계서/02 §4.1, §4.3).
 *
 * @param fish            fish in the aquarium (growthStage drives the rate)
 * @param lastCollectedAt epoch millis of aquariums.last_collected_at
 * @param now             epoch millis "now"
 * @param hasPass         whether Aqua Pass is active (24h cap vs 6h)
 * @param coinRateBonus   wallets.coin_rate_bonus (e.g. 0.05 per completed dex set)
 * @returns integer coins accrued
 */
export function offlineCoins(
  fish: readonly OfflineFish[],
  lastCollectedAt: number,
  now: number,
  hasPass: boolean,
  coinRateBonus: number,
): number {
  const capHours = hasPass ? OFFLINE.capHoursPass : OFFLINE.capHoursFree;
  const elapsedMs = Math.max(0, now - lastCollectedAt);
  const cappedHours = Math.min(capHours, elapsedMs / MS_PER_HOUR);
  if (cappedHours <= 0 || fish.length === 0) return 0;

  let coinsPerHour = 0;
  for (const f of fish) {
    coinsPerHour += OFFLINE.perFishCoinPerHourPerStage * f.growthStage;
  }
  coinsPerHour *= 1 + coinRateBonus;

  return Math.floor(coinsPerHour * cappedHours);
}

/**
 * Hearts → coins conversion performed at claim time (claim_gifts, GUARDRAILS §6).
 *
 * Every full `HEARTS.conversionThreshold` (100) hearts converts to
 * `HEARTS.coinsPerThreshold` (1000) coins. Returns the converted coins and the hearts
 * remaining below the next threshold (the leftover stays on the wallet).
 *
 * @param hearts current hearts balance
 * @returns { coins, heartsRemaining }
 */
export function heartsToCoins(hearts: number): { coins: number; heartsRemaining: number } {
  if (hearts < HEARTS.conversionThreshold) {
    return { coins: 0, heartsRemaining: Math.max(0, hearts) };
  }
  const conversions = Math.floor(hearts / HEARTS.conversionThreshold);
  return {
    coins: conversions * HEARTS.coinsPerThreshold,
    heartsRemaining: hearts - conversions * HEARTS.conversionThreshold,
  };
}

/**
 * Fishing size_pct from reeling time-in-zone.
 *
 * Base mapping is linear (sizePct = clamp(timeInZone, 0..1)). When time-in-zone reaches
 * the Perfect Catch threshold (≥0.9), the result is lifted into the top 10% band
 * [0.9, 1.0] (GUARDRAILS §6: "time-in-zone ≥0.9 → size_pct 상위 10%").
 *
 * NOTE: the server (fishing-resolve) is authoritative for the final size_pct; this is the
 * shared rule both sides apply for parity.
 *
 * @param timeInZone 0..1 fraction of reeling spent in the green zone
 * @returns 0..1 size percentile
 */
export function fishingSizePct(timeInZone: number): number {
  const t = clamp01(timeInZone);
  if (t >= FISHING_SKILL.perfectCatchTimeInZone) {
    // Map the top band [perfectCatchTimeInZone, 1] → [perfectCatchSizeFloor, 1].
    const span = 1 - FISHING_SKILL.perfectCatchTimeInZone;
    const within = span > 0 ? (t - FISHING_SKILL.perfectCatchTimeInZone) / span : 0;
    return FISHING_SKILL.perfectCatchSizeFloor + within * (1 - FISHING_SKILL.perfectCatchSizeFloor);
  }
  return t;
}

/**
 * Rare-tier probability with cast-skill bonus.
 *
 * A Perfect cast adds +10 percentage points (absolute) to the base rare chance
 * (GUARDRAILS §6). The result is clamped to [0, 1].
 *
 * The base rare chance comes from the spot's `rarity_weights` (설계서/02 §1.1); pass it in.
 *
 * @param castPerfect    whether the cast was Perfect
 * @param baseRareChance base rare probability from rarity_weights (0..1). Defaults to 0.
 * @returns rare probability after the skill bonus, clamped to [0,1]
 */
export function rareChance(castPerfect: boolean, baseRareChance = 0): number {
  const base = clamp01(baseRareChance);
  if (!castPerfect) return base;
  return clamp01(base + FISHING_SKILL.castPerfectRareBonus);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
