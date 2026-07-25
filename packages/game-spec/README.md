# @aquadesk/game-spec

**Single Source of Truth (SoT) for Aqua Desk game rules.**

Pure TypeScript, **no I/O**. This package holds the shared snapshot **types**, **economy
constants**, **pure formulas**, and the **fishing FSM** that the web app imports and that
the native (Android/iOS) port reproduces. Per GUARDRAILS §1.6 and §10, these rules live in
**one place only** — re-defining economy constants or shared types outside this package is
forbidden (드리프트 금지).

## Why it exists

- The server (Supabase RPC / Edge Functions) is the **authority** for economy, collection,
  payment, and token state (GUARDRAILS §1). Clients only `SELECT` their own rows.
- For web optimistic UI and native prediction to **agree with the server**, all three must
  apply the **same rules**. This package is that shared rulebook.
- Parity is enforced by **shared test vectors** (`__tests__/economy.test.ts`): the native
  Kotlin port must produce identical outputs for the same inputs (설계서/05 §6).

## Contents (`src/`)

| File | Responsibility | Source contract |
|------|----------------|-----------------|
| `types.ts` | `AquariumSnapshot`, `SlotPlacement`, `FishSnapshot`, `PendingAnim`, plus `Rarity` / `BodyType` / `Nature` / `FishSpriteState` / `DayNight` enums. | GUARDRAILS §5, 설계서/02 §6 |
| `economy.ts` | Stamina, offline-coin, hearts→coins, fishing-skill, dex-buff constants; IAP product catalog (ids/prices). | GUARDRAILS §6, 설계서/04 §6 |
| `formulas.ts` | Pure functions: `regenStamina`, `offlineCoins`, `heartsToCoins`, `fishingSizePct`, `rareChance`. | 설계서/02 §4, 설계서/04 §5 |
| `fishing-fsm.ts` | `FishingState`, `FishingSkill`, `FishingEvent`, `fishingTransition` (incl. fail transitions). | 설계서/04 §3 / §3.1 |
| `index.ts` | Public barrel re-export. | — |

## Key invariants

- `FishSnapshot.x/y` and `SlotPlacement.x/y` are **initial placement hints** (server seed).
  Per-frame position authority is the **native FSM** (GUARDRAILS §5).
- `FishSnapshot.satisfied` is **derived** (hunger==0 or low water_quality ⇒ false); there
  is no `satisfied` DB column (설계서/02 §1.2).
- Sprite states: `idle | swim | scatter | peek | yawn | sulk` (GUARDRAILS §5).
- Fishing: the client only decides **success → resolving**; the server decides *what* was
  caught and never flips *caught / not caught* (설계서/04 §4). `fail` merges into an
  empty-handed `result`.
- These formulas are for **display/prediction + parity**; the server RPC remains
  authoritative for the committed values.

## Economy constants (GUARDRAILS §6)

- Stamina: cap **5** (+2 with Aqua Pass = **7**), regen **+1 / 30 min**, fishing **−1**.
- Offline coins: `10 × growthStage` coin/h × `(1 + coinRateBonus)`, cap **6h** free / **24h** pass.
- Hearts → coins: **100 hearts → 1000 coins** (auto at `claim_gifts`).
- Fishing skill: Perfect cast → rare chance **+10%p**; reeling time-in-zone **≥0.9** → size top **10%**.
- Dex set complete → `coin_rate_bonus += 0.05`.

## Usage

```ts
import {
  type AquariumSnapshot,
  regenStamina,
  offlineCoins,
  fishingTransition,
  STAMINA,
} from '@aquadesk/game-spec';
```

## Scripts

```bash
npm test       -w packages/game-spec   # node --test parity vectors (Node 20+)
npm run typecheck -w packages/game-spec
```

> Change a rule? **Edit GUARDRAILS.md first**, then this package, then update the parity
> vectors. Web and native are verified against the same vectors.
