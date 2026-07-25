/**
 * @aquadesk/game-spec — public surface.
 *
 * Single Source of Truth for Aqua Desk game rules: shared snapshot types, economy
 * constants, pure formulas, and the fishing FSM. Pure TypeScript, no I/O.
 * Imported by apps/web; ported/verified by native against shared parity vectors
 * (GUARDRAILS §1.6, §5, §6; 설계서/05 §6).
 */

export * from './types.ts';
export * from './economy.ts';
export * from './formulas.ts';
export * from './fishing-fsm.ts';
