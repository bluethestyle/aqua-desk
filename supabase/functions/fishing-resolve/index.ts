// fishing-resolve/index.ts
// -----------------------------------------------------------------------------
// Edge Function (Deno, service role) — kebab-case URL: /fishing-resolve
//
// 계약 (GUARDRAILS §4.3):
//   fishing-resolve(session_id uuid, skill jsonb) → reward
//   - session 미consumed 검증
//   - fishing_spots 풀(species_pool) + rarity_weights + seed 로 종 결정
//   - game-spec 공식 의도대로 size_pct 산출(skill 보정)
//   - fish_instances insert + dex_entries upsert + fishing_sessions.consumed=true
//   - 멱등(GUARDRAILS §1.4, 멱등키 = fishing_sessions.id):
//       이미 consumed 면 기존 reward(fish_instance)를 그대로 반환
//   - service role 로 RLS 우회 (auth.role()='service_role' → GUC 불필요, §4.3 "(svc)")
//
// 낚시 스킬 보정 (GUARDRAILS §6):
//   - 캐스팅 Perfect(castPerfect=true) → 희귀확률 +10%p
//   - reeling time-in-zone ≥0.9 → size_pct 상위 10% (0.9..1.0 구간)
//
// game-spec SoT 동기화 (GUARDRAILS §1.6):
//   size_pct/rarity 보정은 @aquadesk/game-spec 의 fishingSizePct()/rareChance() 와
//   **결정적으로 동일하게** 정렬되어 parity 벡터(설계서 05 §6)를 재현한다(computeSizePct/pickRarity).
//   ⚠️ game-spec formulas.ts 를 고치면 이 두 함수도 반드시 함께 고쳐 동기화한다.
//   TODO: game-spec 이 Deno 에서 import 가능해지면 위임하고 여기선 I/O(검증·DB 쓰기·멱등)만 담당.
// -----------------------------------------------------------------------------

import {
  createServiceClient,
  errorResponse,
  getUserId,
  handlePreflight,
  jsonResponse,
} from "../_shared/supabase.ts";

// ── 입력 계약 ────────────────────────────────────────────────────────────────
interface FishingSkill {
  castPerfect: boolean; // 희귀종 확률 +10%p (GUARDRAILS §6)
  timeInZone: number; // 0..1, ≥0.9 → size_pct 상위 10%
}

interface ResolveRequest {
  session_id: string; // 멱등키 = fishing_sessions.id
  skill: FishingSkill;
}

// rarity 키는 fishing_spots.rarity_weights / fish_species.rarity 와 일치 (설계서 02 §1.1)
type Rarity = "common" | "rare" | "mythic";
const RARITY_ORDER: Rarity[] = ["common", "rare", "mythic"];

// fish_instances.nature enum (설계서 02 §6)
type Nature = "timid" | "gluttonous" | "curious" | "lone";
const NATURES: Nature[] = ["timid", "gluttonous", "curious", "lone"];

// 희귀 보정 상수 (GUARDRAILS §6): 캐스팅 Perfect → 희귀확률 +10%p
const RARE_BONUS_PP = 0.10;
// Perfect Catch(time-in-zone) 임계 + 상위 크기 구간 (GUARDRAILS §6)
const PERFECT_ZONE_THRESHOLD = 0.9;
const PERFECT_SIZE_FLOOR = 0.9; // 상위 10% → size_pct ∈ [0.9, 1.0]

/**
 * 결정적 PRNG(mulberry32). seed = fishing_sessions.id 해시 → 멱등 재호출 시에도
 * (이미 consumed 라 기존 reward 반환하지만) 동일 seed 면 동일 결과.
 */
function makeRng(seedStr: string): () => number {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * rarity_weights + castPerfect 보정으로 rarity 를 고른다.
 * ★@aquadesk/game-spec 의 rareChance() 와 동일 의미로 동기화:
 *   pRare = clamp01(baseRare + (castPerfect ? +10%p : 0)), mythic 불변, common 이 차액 흡수.
 *   (이전: common→rare shift(common 가중치 cap) 방식 → game-spec 과 불일치하여 교체)
 */
function pickRarity(
  weights: Record<string, number>,
  castPerfect: boolean,
  rng: () => number,
): Rarity {
  const baseRare = Math.max(0, weights.rare ?? 0);
  const pMythic = Math.max(0, weights.mythic ?? 0);
  // rareChance(castPerfect, baseRare): +10%p(절대) 가산 후 [0,1] clamp
  const pRare = Math.min(1, baseRare + (castPerfect ? RARE_BONUS_PP : 0));
  const pCommon = Math.max(0, 1 - pRare - pMythic);
  const probs: Record<Rarity, number> = { common: pCommon, rare: pRare, mythic: pMythic };
  const total = pCommon + pRare + pMythic;
  if (total <= 0) return "common";
  let r = rng() * total;
  for (const k of RARITY_ORDER) {
    if (r < probs[k]) return k;
    r -= probs[k];
  }
  return "common";
}

/**
 * size_pct 산출 — ★@aquadesk/game-spec 의 fishingSizePct() 와 결정적으로 동일(rng 미사용).
 *   - timeInZone ≥ 0.9 → [0.9, 1.0] 비례 매핑
 *   - 그 외 → sizePct = timeInZone (선형)
 *   parity 벡터(설계서 05 §6): fishingSizePct(0.9)=0.9, (0.95)=0.95 를 그대로 재현.
 */
function computeSizePct(timeInZone: number): number {
  const t = Math.min(1, Math.max(0, Number.isNaN(timeInZone) ? 0 : timeInZone));
  if (t >= PERFECT_ZONE_THRESHOLD) {
    const span = 1 - PERFECT_ZONE_THRESHOLD;
    const within = span > 0 ? (t - PERFECT_ZONE_THRESHOLD) / span : 0;
    return PERFECT_SIZE_FLOOR + within * (1 - PERFECT_SIZE_FLOOR);
  }
  return t;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);

  // 호출자 인증 — 클라가 보낸 user_id 를 신뢰하지 않고 JWT 에서 해석(GUARDRAILS §1.3).
  const userId = await getUserId(req);
  if (!userId) return errorResponse("unauthorized", 401);

  let body: ResolveRequest;
  try {
    body = (await req.json()) as ResolveRequest;
  } catch {
    return errorResponse("invalid_json", 400);
  }
  const { session_id, skill } = body;
  if (!session_id) return errorResponse("missing_session_id", 400);
  const safeSkill: FishingSkill = {
    castPerfect: Boolean(skill?.castPerfect),
    timeInZone: typeof skill?.timeInZone === "number" ? skill.timeInZone : 0,
  };

  const supabase = createServiceClient();

  // 1) 세션 로드 + 소유 검증. service role 이므로 RLS 우회, 소유는 user_id 로 직접 확인.
  const { data: session, error: sErr } = await supabase
    .from("fishing_sessions")
    .select("id, user_id, spot_id, consumed, reward_fish_instance_id")
    .eq("id", session_id)
    .maybeSingle();

  if (sErr) return errorResponse("db_error", 500, sErr.message);
  if (!session) return errorResponse("session_not_found", 404);
  if (session.user_id !== userId) return errorResponse("forbidden", 403);

  // 2) 멱등 (GUARDRAILS §1.4): 이미 consumed 면 기존 reward 를 그대로 반환.
  if (session.consumed) {
    if (!session.reward_fish_instance_id) {
      // consumed=true 인데 reward 가 없으면 빈손 세션(설계상 비정상이나 멱등 보존).
      return jsonResponse({ idempotent: true, reward: null });
    }
    const { data: existing, error: exErr } = await supabase
      .from("fish_instances")
      .select("id, aquarium_id, species_id, nature, growth_stage, size_pct")
      .eq("id", session.reward_fish_instance_id)
      .maybeSingle();
    if (exErr) return errorResponse("db_error", 500, exErr.message);
    return jsonResponse({ idempotent: true, reward: existing });
  }

  // 3) 낚시터 풀 로드 (카탈로그, public read — 종 결정 입력).
  const { data: spot, error: spotErr } = await supabase
    .from("fishing_spots")
    .select("id, species_pool, rarity_weights")
    .eq("id", session.spot_id)
    .maybeSingle();
  if (spotErr) return errorResponse("db_error", 500, spotErr.message);
  if (!spot) return errorResponse("spot_not_found", 404);

  const pool: string[] = Array.isArray(spot.species_pool)
    ? (spot.species_pool as string[])
    : [];
  const weights = (spot.rarity_weights ?? {}) as Record<string, number>;
  if (pool.length === 0) return errorResponse("empty_pool", 422);

  // 4) 종 결정 — seed = session.id (멱등/결정적).
  const rng = makeRng(session.id);
  const rarity = pickRarity(weights, safeSkill.castPerfect, rng);

  // 풀 후보 중 해당 rarity 의 종으로 좁힌다(없으면 풀 전체에서 폴백).
  const { data: speciesRows, error: spErr } = await supabase
    .from("fish_species")
    .select("id, rarity")
    .in("id", pool);
  if (spErr) return errorResponse("db_error", 500, spErr.message);

  const byRarity = (speciesRows ?? []).filter((s) => s.rarity === rarity);
  const candidates = byRarity.length > 0
    ? byRarity.map((s) => s.id)
    : (speciesRows ?? []).map((s) => s.id);
  if (candidates.length === 0) return errorResponse("no_species", 422);
  const speciesId = candidates[Math.floor(rng() * candidates.length)];

  // 5) size_pct + nature 산출 (GUARDRAILS §6 공식 의도).
  const sizePct = computeSizePct(safeSkill.timeInZone);
  const nature = NATURES[Math.floor(rng() * NATURES.length)];

  // 6) 대상 어항 결정 — 사용자의 기본 어항(idx 오름차순 첫 행).
  //    TODO(구현 자리): 어항 슬롯 풀(만석) 검사·다중 어항 선택 UX 는 추후. 현재는 idx=최소.
  const { data: aquarium, error: aqErr } = await supabase
    .from("aquariums")
    .select("id")
    .eq("user_id", userId)
    .order("idx", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (aqErr) return errorResponse("db_error", 500, aqErr.message);
  if (!aquarium) return errorResponse("no_aquarium", 422);

  // 7) fish_instances insert (서버 권위 쓰기 — service role 로 RLS 우회).
  const { data: inserted, error: insErr } = await supabase
    .from("fish_instances")
    .insert({
      aquarium_id: aquarium.id,
      species_id: speciesId,
      nature,
      growth_stage: 1,
      hunger: 1.0,
      size_pct: sizePct,
    })
    .select("id, aquarium_id, species_id, nature, growth_stage, size_pct")
    .single();
  if (insErr || !inserted) {
    return errorResponse("insert_failed", 500, insErr?.message);
  }

  // 8) dex_entries upsert — 최초면 insert, 재포획이면 count++.
  //    pk=(user_id, species_id). 원자 증가를 위해 SECURITY DEFINER RPC 권장이나,
  //    service role 이므로 read-then-write 로 처리(낚시 1회=세션당 1회, 멱등키로 보호).
  const { data: dexRow, error: dexSelErr } = await supabase
    .from("dex_entries")
    .select("count")
    .eq("user_id", userId)
    .eq("species_id", speciesId)
    .maybeSingle();
  if (dexSelErr) return errorResponse("db_error", 500, dexSelErr.message);

  if (!dexRow) {
    const { error: dexInsErr } = await supabase
      .from("dex_entries")
      .insert({ user_id: userId, species_id: speciesId, count: 1 });
    if (dexInsErr) return errorResponse("db_error", 500, dexInsErr.message);
  } else {
    const { error: dexUpdErr } = await supabase
      .from("dex_entries")
      .update({ count: (dexRow.count ?? 0) + 1 })
      .eq("user_id", userId)
      .eq("species_id", speciesId);
    if (dexUpdErr) return errorResponse("db_error", 500, dexUpdErr.message);
  }

  // 9) 세션 마감 — consumed=true + reward 연결 (멱등키 확정).
  //    consumed=false 조건부 UPDATE 로 동시 resolve 경쟁을 차단(0행이면 이미 처리됨).
  const { data: closed, error: closeErr } = await supabase
    .from("fishing_sessions")
    .update({ consumed: true, reward_fish_instance_id: inserted.id })
    .eq("id", session.id)
    .eq("consumed", false)
    .select("id")
    .maybeSingle();
  if (closeErr) return errorResponse("db_error", 500, closeErr.message);

  if (!closed) {
    // 경쟁: 다른 호출이 먼저 consumed 처리. 방금 insert 한 중복 인스턴스를 정리하고
    // 기존 reward 를 반환(멱등 보장).
    await supabase.from("fish_instances").delete().eq("id", inserted.id);
    const { data: winner } = await supabase
      .from("fishing_sessions")
      .select("reward_fish_instance_id")
      .eq("id", session.id)
      .maybeSingle();
    if (winner?.reward_fish_instance_id) {
      const { data: winFish } = await supabase
        .from("fish_instances")
        .select("id, aquarium_id, species_id, nature, growth_stage, size_pct")
        .eq("id", winner.reward_fish_instance_id)
        .maybeSingle();
      return jsonResponse({ idempotent: true, reward: winFish });
    }
    return jsonResponse({ idempotent: true, reward: null });
  }

  // 10) 결과 반환 — user_id 미포함(GUARDRAILS §10).
  return jsonResponse({
    idempotent: false,
    reward: {
      id: inserted.id,
      aquarium_id: inserted.aquarium_id,
      species_id: speciesId,
      rarity,
      nature,
      growth_stage: inserted.growth_stage,
      size_pct: sizePct,
    },
  });
});
