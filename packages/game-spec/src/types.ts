/**
 * Aqua Desk — shared data contracts (Single Source of Truth).
 *
 * SoT for AquariumSnapshot and all shared types is this file (GUARDRAILS §5, 설계서/02 §6).
 * Web / native / docs import or reference these; duplicating these definitions elsewhere
 * is forbidden (GUARDRAILS §1.6, §10).
 *
 * Pure types only — no runtime, no I/O.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Catalog-level enums (mirror DB catalog text columns, 설계서/02 §1.1)
// ─────────────────────────────────────────────────────────────────────────────

/** fish_species.rarity — drives rarity_weights rolls and dex grouping. */
export type Rarity = 'common' | 'rare' | 'mythic';

/** fish_species.body_type — selects the locomotion/sprite profile in the native FSM. */
export type BodyType = 'fusiform' | 'disc' | 'eel';

/** fish_instances.nature — behavior personality used by the wallpaper FSM. */
export type Nature = 'timid' | 'gluttonous' | 'curious' | 'lone';

/**
 * Sprite animation state enum (GUARDRAILS §5, 설계서/02 §6).
 * Storage layout: sprites/fish/{species}/{state}/{frame}.png
 * The "불만족"(dissatisfied) presentation is a derived value from `satisfied=false`,
 * not a distinct sprite state.
 */
export type FishSpriteState =
  | 'idle'
  | 'swim'
  | 'scatter'
  | 'peek'
  | 'yawn'
  | 'sulk';

/** Day/night rendering mode for the background. `auto` follows device clock. */
export type DayNight = 'auto' | 'day' | 'night';

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot contract (Native ↔ Web shared JSON) — 설계서/02 §6
// Lightweight, render-only format. packages/game-spec converts DB rows → snapshot.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single placed decoration slot.
 * x/y are INITIAL placement hints (server seed); the per-frame position authority
 * is the native FSM (GUARDRAILS §5, 설계서/02 §6).
 */
export interface SlotPlacement {
  slotId: string;
  itemId: string;
  /** 0..1 normalized initial placement hint (server seed). */
  x: number;
  /** 0..1 normalized initial placement hint (server seed). */
  y: number;
  layer: number;
}

/**
 * One fish in the aquarium snapshot.
 *
 * `sizePct` is the per-individual size (0..1), computed server-side at fishing time
 * with skill correction (설계서/02 §1.2, §6).
 * `satisfied` is a DERIVED value (hunger==0 or low water_quality ⇒ false); there is
 * no `satisfied` column in the DB (설계서/02 §1.2).
 * `x`/`y` are INITIAL placement hints (server seed); runtime position authority is the
 * native FSM (GUARDRAILS §5).
 */
export interface FishSnapshot {
  id: string;
  speciesId: string;
  bodyType: BodyType;
  nickname?: string;
  nature: Nature;
  /** Growth stage 1..4 (먹이 + 시간). */
  growthStage: number;
  /** 0..1 individual size (server-computed at fishing time). */
  sizePct: number;
  /** Derived from hunger / water_quality (dissatisfied = false). */
  satisfied: boolean;
  /** 0..1 normalized initial placement hint (server seed). */
  x: number;
  /** 0..1 normalized initial placement hint (server seed). */
  y: number;
}

/**
 * A queued background animation (★비가시 큐잉, R1).
 * Native enqueues when not visible and flushes on onVisibilityChanged(true).
 */
export interface PendingAnim {
  kind: 'feed-drop' | 'clean' | 'heart';
  /** Epoch millis when the action occurred (for ordering / staleness). */
  at: number;
  payload?: unknown;
}

/**
 * Render-only aquarium snapshot shared between native wallpaper and web (설계서/02 §6).
 * `version` mirrors aquariums.version (server-authoritative CAS counter).
 */
export interface AquariumSnapshot {
  version: number;
  themeId: string;
  dayNight: DayNight;
  /** 0..1 water clarity (cleaning restores toward 1). */
  waterQuality: number;
  slots: SlotPlacement[];
  fish: FishSnapshot[];
  /** ★비가시 큐잉(R1): 'feed-drop' | 'clean' | 'heart'. */
  pendingAnims: PendingAnim[];
}
