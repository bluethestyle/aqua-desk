/**
 * Parity test vectors for @aquadesk/game-spec economy + fishing formulas/FSM.
 *
 * These boundary-value vectors are the shared web↔native parity contract (설계서/05 §6):
 * the native (Kotlin) port must reproduce the same outputs for the same inputs. Keep the
 * numbers here in sync with GUARDRAILS §6 — change the constant, change the vector.
 *
 * Run: `node --test --experimental-strip-types __tests__`  (Node 20+).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  regenStamina,
  offlineCoins,
  heartsToCoins,
  fishingSizePct,
  rareChance,
  type OfflineFish,
} from '../src/formulas.ts';
import {
  STAMINA,
  STAMINA_CAP_WITH_PASS,
  OFFLINE,
  HEARTS,
  FISHING_SKILL,
  DEX_BUFF,
  PEARL_PACKS,
  STARTER_PACK,
  AQUA_PASS,
} from '../src/economy.ts';
import {
  fishingTransition,
  isFailure,
  isTerminal,
  isPerfectCatch,
  FISHING_INITIAL_STATE,
  type FishingState,
} from '../src/fishing-fsm.ts';

const MIN = 60 * 1000;
const HOUR = 60 * 60 * 1000;

// ── stamina ─────────────────────────────────────────────────────────────────

test('regenStamina: no time elapsed → unchanged', () => {
  assert.equal(regenStamina(2, 1_000, 1_000, false), 2);
});

test('regenStamina: +1 per 30 min, floored', () => {
  const t0 = 0;
  assert.equal(regenStamina(0, t0, 29 * MIN, false), 0); // just under one tick
  assert.equal(regenStamina(0, t0, 30 * MIN, false), 1); // exactly one tick (boundary)
  assert.equal(regenStamina(0, t0, 90 * MIN, false), 3); // three ticks
});

test('regenStamina: clamps to base cap 5', () => {
  assert.equal(STAMINA.baseCap, 5);
  assert.equal(regenStamina(4, 0, 10 * HOUR, false), STAMINA.baseCap); // 4 + many → cap 5
  assert.equal(regenStamina(5, 0, 10 * HOUR, false), 5); // already at cap, no decay
});

test('regenStamina: Aqua Pass raises cap to 7', () => {
  assert.equal(STAMINA_CAP_WITH_PASS, 7);
  assert.equal(regenStamina(5, 0, 10 * HOUR, true), STAMINA_CAP_WITH_PASS);
  assert.equal(regenStamina(7, 0, 10 * HOUR, true), 7); // at pass cap
});

test('regenStamina: current above cap is returned unchanged', () => {
  assert.equal(regenStamina(9, 0, 10 * HOUR, false), 9);
});

// ── offline coins ─────────────────────────────────────────────────────────────

test('offlineCoins: empty aquarium → 0', () => {
  assert.equal(offlineCoins([], 0, 10 * HOUR, false, 0), 0);
});

test('offlineCoins: no elapsed time → 0', () => {
  const fish: OfflineFish[] = [{ growthStage: 1 }];
  assert.equal(offlineCoins(fish, 1_000, 1_000, false, 0), 0);
});

test('offlineCoins: single stage-1 fish, 1h, no bonus → 10', () => {
  // 10 × 1 coin/h × 1h = 10
  const fish: OfflineFish[] = [{ growthStage: 1 }];
  assert.equal(offlineCoins(fish, 0, HOUR, false, 0), 10);
  assert.equal(OFFLINE.perFishCoinPerHourPerStage, 10);
});

test('offlineCoins: growthStage scales the rate', () => {
  // stage 3 → 30 coin/h × 2h = 60
  const fish: OfflineFish[] = [{ growthStage: 3 }];
  assert.equal(offlineCoins(fish, 0, 2 * HOUR, false, 0), 60);
});

test('offlineCoins: coin_rate_bonus applies (dex set buff 0.05)', () => {
  assert.equal(DEX_BUFF.coinRateBonusPerSet, 0.05);
  // 10 coin/h × (1 + 0.05) × 4h = 42
  const fish: OfflineFish[] = [{ growthStage: 1 }];
  assert.equal(offlineCoins(fish, 0, 4 * HOUR, false, 0.05), 42);
});

test('offlineCoins: free cap is 6h (boundary)', () => {
  assert.equal(OFFLINE.capHoursFree, 6);
  const fish: OfflineFish[] = [{ growthStage: 1 }]; // 10 coin/h
  // 10h elapsed but capped at 6h → 60
  assert.equal(offlineCoins(fish, 0, 10 * HOUR, false, 0), 60);
  // exactly at cap → 60
  assert.equal(offlineCoins(fish, 0, 6 * HOUR, false, 0), 60);
});

test('offlineCoins: pass cap is 24h (boundary)', () => {
  assert.equal(OFFLINE.capHoursPass, 24);
  const fish: OfflineFish[] = [{ growthStage: 1 }]; // 10 coin/h
  // 30h elapsed but capped at 24h → 240
  assert.equal(offlineCoins(fish, 0, 30 * HOUR, true, 0), 240);
});

test('offlineCoins: multiple fish summed and floored', () => {
  // (10×1 + 10×2) = 30 coin/h × 1.5h = 45
  const fish: OfflineFish[] = [{ growthStage: 1 }, { growthStage: 2 }];
  assert.equal(offlineCoins(fish, 0, 1.5 * HOUR, false, 0), 45);
  // fractional result is floored: 10 coin/h × 0.25h = 2.5 → 2
  assert.equal(offlineCoins([{ growthStage: 1 }], 0, 0.25 * HOUR, false, 0), 2);
});

// ── hearts → coins ─────────────────────────────────────────────────────────────

test('heartsToCoins: below threshold → no conversion', () => {
  assert.equal(HEARTS.conversionThreshold, 100);
  assert.equal(HEARTS.coinsPerThreshold, 1000);
  assert.deepEqual(heartsToCoins(99), { coins: 0, heartsRemaining: 99 });
});

test('heartsToCoins: exactly 100 → 1000 coins, 0 remaining (boundary)', () => {
  assert.deepEqual(heartsToCoins(100), { coins: 1000, heartsRemaining: 0 });
});

test('heartsToCoins: 250 → 2000 coins, 50 remaining', () => {
  assert.deepEqual(heartsToCoins(250), { coins: 2000, heartsRemaining: 50 });
});

test('heartsToCoins: negative clamps to 0', () => {
  assert.deepEqual(heartsToCoins(-5), { coins: 0, heartsRemaining: 0 });
});

// ── fishing size_pct ───────────────────────────────────────────────────────────

test('fishingSizePct: linear below the perfect threshold', () => {
  assert.equal(fishingSizePct(0), 0);
  assert.equal(fishingSizePct(0.5), 0.5);
  assert.equal(fishingSizePct(0.89), 0.89);
});

test('fishingSizePct: ≥0.9 lifts into the top 10% band (boundary)', () => {
  assert.equal(FISHING_SKILL.perfectCatchTimeInZone, 0.9);
  assert.equal(FISHING_SKILL.perfectCatchSizeFloor, 0.9);
  // at exactly 0.9 → floor of the band = 0.9
  assert.equal(fishingSizePct(0.9), 0.9);
  // at 1.0 → top of the band = 1.0
  assert.equal(fishingSizePct(1.0), 1.0);
  // midpoint 0.95 → halfway across [0.9,1.0] = 0.95
  assert.ok(Math.abs(fishingSizePct(0.95) - 0.95) < 1e-9);
});

test('fishingSizePct: clamps out-of-range inputs', () => {
  assert.equal(fishingSizePct(-1), 0);
  assert.equal(fishingSizePct(2), 1);
});

// ── rare chance ────────────────────────────────────────────────────────────────

test('rareChance: perfect cast adds +10%p (0.10)', () => {
  assert.equal(FISHING_SKILL.castPerfectRareBonus, 0.1);
  assert.ok(Math.abs(rareChance(true, 0.25) - 0.35) < 1e-9);
  assert.equal(rareChance(false, 0.25), 0.25);
});

test('rareChance: default base 0, clamps to [0,1]', () => {
  assert.ok(Math.abs(rareChance(true) - 0.1) < 1e-9);
  assert.equal(rareChance(true, 0.95), 1); // 0.95 + 0.10 clamped to 1
  assert.equal(rareChance(false, -1), 0);
});

// ── IAP catalog drift guard (GUARDRAILS §6 / 설계서/04 §6) ────────────────────────

test('IAP product ids and prices match GUARDRAILS §6 exactly', () => {
  assert.deepEqual(
    PEARL_PACKS.map((p) => [p.productId, p.priceKrw, p.pearls]),
    [
      ['pearl_pack_10', 1_200, 10],
      ['pearl_pack_50', 5_500, 50],
      ['pearl_pack_115', 12_000, 115],
      ['pearl_pack_260', 25_000, 260],
      ['pearl_pack_540', 49_000, 540],
    ],
  );
  assert.equal(STARTER_PACK.productId, 'starter_pack');
  assert.equal(STARTER_PACK.priceKrw, 2_900);
  assert.equal(STARTER_PACK.pearls, 30);
  assert.equal(AQUA_PASS.productId, 'aqua_pass');
  assert.equal(AQUA_PASS.priceKrwPerMonth, 1_900);
});

// ── fishing FSM (설계서/04 §3) ───────────────────────────────────────────────────

test('FSM: happy path casting → … → result', () => {
  let s: FishingState = FISHING_INITIAL_STATE;
  assert.equal(s, 'casting');
  s = fishingTransition(s, { type: 'cast', perfect: true });
  assert.equal(s, 'waiting');
  s = fishingTransition(s, { type: 'bite' });
  assert.equal(s, 'reeling');
  s = fishingTransition(s, { type: 'reel_success' });
  assert.equal(s, 'resolving');
  s = fishingTransition(s, { type: 'resolved' });
  assert.equal(s, 'result');
  assert.ok(isTerminal(s));
});

test('FSM: cast fail → fail → result (empty-handed)', () => {
  let s: FishingState = fishingTransition('casting', { type: 'cast_fail' });
  assert.equal(s, 'fail');
  assert.ok(isFailure(s));
  s = fishingTransition(s, { type: 'to_result' });
  assert.equal(s, 'result');
});

test('FSM: waiting timeout → fail (1.0s no tap)', () => {
  const s = fishingTransition('waiting', { type: 'bite_timeout' });
  assert.equal(s, 'fail');
});

test('FSM: reeling zone exit → fail', () => {
  const s = fishingTransition('reeling', { type: 'zone_exit' });
  assert.equal(s, 'fail');
});

test('FSM: invalid events keep the state (no throw)', () => {
  assert.equal(fishingTransition('casting', { type: 'bite' }), 'casting');
  assert.equal(fishingTransition('result', { type: 'cast', perfect: false }), 'result');
  assert.equal(fishingTransition('resolving', { type: 'zone_exit' }), 'resolving');
});

test('FSM: isPerfectCatch boundary at 0.9', () => {
  assert.equal(isPerfectCatch({ castPerfect: false, timeInZone: 0.9 }), true);
  assert.equal(isPerfectCatch({ castPerfect: false, timeInZone: 0.8999 }), false);
});
