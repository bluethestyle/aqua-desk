// daily-shop-roll/index.ts
// -----------------------------------------------------------------------------
// Edge Function (Deno, service role) — kebab-case URL: /daily-shop-roll
//
// 계약 (GUARDRAILS §4.3 / 설계서 04 §5.2):
//   daily-shop-roll() → { date, slots: ShopSlot[] }
//   - date + user_id seed 로 일일 6슬롯을 "결정적"으로 생성(클라 조작 불가).
//   - 구매 자체는 purchase_item RPC 가 처리한다(여기서는 진열만).
//   - service role 로 카탈로그(items) 읽기. 읽기 전용이라 권위 테이블 쓰기 없음.
//
// 결정성: 같은 (date, user) → 항상 같은 6슬롯. 클라가 날짜/유저를 위조해도
// user_id 는 JWT 에서 해석(GUARDRAILS §1.3)하므로 타인 슬롯 조작 불가.
//
// ⚠️ TODO(구현 자리):
//   - shop_refresh 광고 보상(grant-ad-reward kind='shop_refresh')으로 1회 리롤 시
//     seed 에 회차(refresh count)를 섞어 재롤하는 로직은 추후. 현재는 date+user 고정.
//   - 슬롯 가중치/등급별 진열 규칙(레어 슬롯 비율 등)은 game-spec 으로 단일화 예정.
//   - 진열 풀 필터(예: type in ('deco','theme'), 한정/시즌 제외)는 카탈로그 확장 시 보강.
// -----------------------------------------------------------------------------

import {
  createServiceClient,
  errorResponse,
  getUserId,
  handlePreflight,
  jsonResponse,
} from "../_shared/supabase.ts";

const SLOT_COUNT = 6; // 일일 6슬롯 (GUARDRAILS §4.3 "date+user seed 6슬롯")

interface ShopSlot {
  slot: number; // 0..5
  item_id: string;
  type: string; // items.type: deco | food | theme
  price_coin: number | null;
  price_pearl: number | null;
  asset_key: string;
}

/** 결정적 PRNG(mulberry32) — seed 문자열 해시. */
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

/** UTC 기준 날짜 키(YYYY-MM-DD) — 일 단위 롤오버. */
function utcDateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 결정적 비복원 추출(Fisher–Yates 부분 셔플)로 풀에서 n 개 슬롯을 고른다.
 * 같은 seed → 같은 선택.
 */
function pickDeterministic<T>(pool: T[], n: number, rng: () => number): T[] {
  const arr = pool.slice();
  const out: T[] = [];
  const k = Math.min(n, arr.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
    out.push(arr[i]);
  }
  return out;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);

  // user_id 는 JWT 에서 해석(클라가 보낸 값 불신 — GUARDRAILS §1.3).
  const userId = await getUserId(req);
  if (!userId) return errorResponse("unauthorized", 401);

  const supabase = createServiceClient();

  // 진열 후보 풀 = 카탈로그(items). public read 지만 service role 로 일괄 조회.
  // TODO(구현 자리): 한정/시즌/이미 보유 제외 필터는 추후 보강.
  const { data: items, error } = await supabase
    .from("items")
    .select("id, type, price_coin, price_pearl, asset_key")
    .order("id", { ascending: true });
  if (error) return errorResponse("db_error", 500, error.message);
  if (!items || items.length === 0) return errorResponse("empty_catalog", 422);

  const dateKey = utcDateKey();
  // seed = date + user_id (결정적·유저별). 동일 날짜/유저면 항상 동일 6슬롯.
  const rng = makeRng(`${dateKey}:${userId}`);
  const picked = pickDeterministic(items, SLOT_COUNT, rng);

  const slots: ShopSlot[] = picked.map((it, i) => ({
    slot: i,
    item_id: it.id,
    type: it.type,
    price_coin: it.price_coin,
    price_pearl: it.price_pearl,
    asset_key: it.asset_key,
  }));

  // user_id 미반환(GUARDRAILS §10). date 로 클라가 롤오버 인지.
  return jsonResponse({ date: dateKey, slots });
});
