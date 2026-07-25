/**
 * Aqua Desk — fishing finite state machine (Single Source of Truth).
 *
 * Mirrors 설계서/04 §3 exactly. Pure transition logic — no I/O, no timers (callers
 * drive the machine with explicit events). Web and native share these transitions and
 * verify them against the same parity vectors (설계서/05 §6).
 *
 *   casting ──tap(Perfect?)──▶ waiting ──bite/tap──▶ reeling ──success──▶ resolving ──▶ result
 *      │                          │                     │                                 ▲
 *      └ (cast fail) ─────────────┴─ (timeout) ─────────┴─ (zone exit) ──▶ fail ──────────┘
 *                                                                          (빈손 result)
 *
 * Invariant (설계서/04 §4): the client only decides success→resolving; the SERVER decides
 * "무엇을 잡았나" and never flips "잡았나/못 잡았나". `fail` merges into an empty-handed
 * `result`. The client never confirms a catch on its own.
 */

import { FISHING_SKILL } from './economy.ts';

/**
 * Fishing states (설계서/04 §3). `fail` is the failure transition (빈손) that merges
 * into `result`.
 */
export type FishingState =
  | 'casting'
  | 'waiting'
  | 'reeling'
  | 'resolving'
  | 'result'
  | 'fail';

/**
 * Skill inputs passed to fishing-resolve (설계서/04 §3, GUARDRAILS §6).
 * - castPerfect: Perfect cast → rare chance +10%p.
 * - timeInZone: 0..1 reeling time-in-green-zone; ≥0.9 → Perfect Catch (top 10% size).
 */
export interface FishingSkill {
  castPerfect: boolean;
  timeInZone: number;
}

/**
 * Events that drive the FSM. Distinct from states; transitions are (state, event) → state.
 *
 * - cast        : casting → waiting (a non-failing cast). `perfect` records skill.
 * - cast_fail   : casting → fail (botched cast timing).
 * - bite        : waiting → reeling (the "!" appeared and was tapped within 1.0s).
 * - bite_timeout: waiting → fail (no tap within 1.0s of the bite).
 * - reel_success: reeling → resolving (green zone held to completion).
 * - zone_exit   : reeling → fail (float left the green-zone upper/lower bound).
 * - resolved    : resolving → result (server fishing-resolve responded with the reward).
 * - to_result   : fail → result (empty-handed result is shown).
 */
export type FishingEvent =
  | { type: 'cast'; perfect: boolean }
  | { type: 'cast_fail' }
  | { type: 'bite' }
  | { type: 'bite_timeout' }
  | { type: 'reel_success' }
  | { type: 'zone_exit' }
  | { type: 'resolved' }
  | { type: 'to_result' };

/** Terminal-ish predicate: `result` is the final state. */
export function isTerminal(state: FishingState): boolean {
  return state === 'result';
}

/** Whether the run reached the empty-handed failure branch. */
export function isFailure(state: FishingState): boolean {
  return state === 'fail';
}

/**
 * Pure FSM transition (설계서/04 §3, §3.1).
 *
 * Returns the next state, or the SAME state if the event is not valid in the current
 * state (no throw — callers may treat (next===prev) as "ignored"). This keeps web/native
 * parity deterministic.
 */
export function fishingTransition(state: FishingState, event: FishingEvent): FishingState {
  switch (state) {
    case 'casting':
      if (event.type === 'cast') return 'waiting';
      if (event.type === 'cast_fail') return 'fail';
      return state;

    case 'waiting':
      if (event.type === 'bite') return 'reeling';
      if (event.type === 'bite_timeout') return 'fail'; // ★ 1.0s 내 미탭 → timeout → fail
      return state;

    case 'reeling':
      if (event.type === 'reel_success') return 'resolving';
      if (event.type === 'zone_exit') return 'fail'; // ★ 그린존 상/하한 이탈 → fail
      return state;

    case 'resolving':
      // Server fishing-resolve decided "무엇"; advance to the result popup.
      if (event.type === 'resolved') return 'result';
      return state;

    case 'fail':
      // 빈손 result로 합류.
      if (event.type === 'to_result') return 'result';
      return state;

    case 'result':
      // Terminal.
      return state;

    default: {
      // Exhaustiveness guard.
      const _never: never = state;
      return _never;
    }
  }
}

/** The state the machine starts in when fishing is entered (after start_fishing succeeds). */
export const FISHING_INITIAL_STATE: FishingState = 'casting';

/**
 * Whether a reeling skill counts as a "Perfect Catch" (top 10% size band),
 * i.e. timeInZone ≥ 0.9 (GUARDRAILS §6). Convenience for UI/connector logic.
 */
export function isPerfectCatch(skill: FishingSkill): boolean {
  return skill.timeInZone >= FISHING_SKILL.perfectCatchTimeInZone;
}
