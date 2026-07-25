// verify-receipt/index.ts
// -----------------------------------------------------------------------------
// Edge Function (Deno, service role) — kebab-case URL: /verify-receipt
//
// 계약 (GUARDRAILS §4.3 / 설계서 04 §5):
//   verify-receipt(platform text, receipt text) → { ok, product_id, granted }
//   - 영수증 검증(스텁) → purchases(platform, receipt) UNIQUE 로 멱등 insert
//     (GUARDRAILS §1.4: 결제 멱등키 = purchases(platform,receipt))
//   - 상품ID별 지급(GUARDRAILS §6 product_id 카탈로그): pearls/items/coins 원자 지급
//   - verified=true 마감
//   - service role 로 RLS 우회(auth.role()='service_role' → GUC 불필요, §4.3 "(svc)")
//
// 멱등 (GUARDRAILS §1.4 / §10):
//   - 같은 (platform, receipt)가 두 번 들어오면 UNIQUE 충돌 → 재지급하지 않고
//     기존 결과를 그대로 반환(중복 지급 방지).
//
// ⚠️ TODO(구현 자리 — 실제 영수증 검증):
//   현재 verifyReceipt() 는 형식 검증만 하는 스텁이다(설계서 05: 결제 실연동은 후속).
//   프로덕션 교체:
//     - platform='play'     → Google Play Developer API(purchases.products.get)로
//                              packageName/productId/purchaseToken 검증.
//     - platform='appstore' → App Store Server API / verifyReceipt(또는 StoreKit2
//                              JWS notification)로 영수증 서명·환경(prod/sandbox) 검증.
//   검증 결과의 product_id 를 신뢰 원천으로 삼아 지급한다(클라가 보낸 product_id 불신).
// -----------------------------------------------------------------------------

import {
  createServiceClient,
  errorResponse,
  getUserId,
  handlePreflight,
  jsonResponse,
} from "../_shared/supabase.ts";

type Platform = "play" | "appstore"; // 설계서 02 §1: purchases.platform

interface VerifyRequest {
  platform: Platform;
  receipt: string;
  // product_id 는 검증된 영수증에서 얻는 것이 원칙. 스텁 단계에서는 영수증과 함께
  // 전달받되, 실제 구현에서는 verifyReceipt() 가 반환한 값으로 대체한다(클라 불신).
  product_id?: string;
}

// 지급 명세(서버 권위 카탈로그) — GUARDRAILS §6 product_id 와 글자 그대로 일치.
// 진주 팩(IAP 직접결제) 만 verify-receipt 경로. 테마/히어로(진주 소비)는 purchase_item RPC.
interface Grant {
  pearls?: number;
  coins?: number;
  items?: { item_id: string; qty: number }[];
  // 첫구매 1회 제한(starter_pack) 등 특수 규칙 플래그.
  onceOnly?: boolean;
}

// GUARDRAILS §6 "IAP 상품 ID / 가격" — verify-receipt product_id 지급표.
const GRANTS: Record<string, Grant> = {
  pearl_pack_10: { pearls: 10 },
  pearl_pack_50: { pearls: 50 }, // 50(+9%) — 기준 진주 50 (보너스는 표기상)
  pearl_pack_115: { pearls: 115 }, // 115(+15%)
  pearl_pack_260: { pearls: 260 }, // 260(+30%)
  pearl_pack_540: { pearls: 540 }, // 540(+35%)
  // 스타터팩(첫구매 1회): 진주 30 + 한정 장식 + 코인.
  // TODO(구현 자리): 한정 장식 item_id 와 코인 보너스 값은 seed 카탈로그 확정 후 채운다.
  starter_pack: {
    pearls: 30,
    coins: 0, // TODO: 코인 보너스 값(기획 확정)
    items: [], // TODO: { item_id: 'deco_starter_limited', qty: 1 }
    onceOnly: true,
  },
  // 구독: aqua_pass — 영수증 검증 후 profiles.aqua_pass_until 갱신(보호 컬럼이나
  // service role 이라 GUC 불필요). 기간 산정은 스토어 갱신 주기 기준.
  // TODO(구현 자리): 구독 갱신/만료 webhook(RTDN/App Store Notifications) 처리.
  aqua_pass: {},
};

/**
 * 영수증 검증 스텁.
 * @returns 검증 성공 시 { ok:true, productId }, 실패 시 { ok:false }
 *
 * TODO(구현 자리): 위 파일 헤더의 platform 별 실제 검증으로 교체.
 * 현재는 형식(비어있지 않음 + 알려진 product_id)만 확인한다.
 */
async function verifyReceipt(
  platform: Platform,
  receipt: string,
  claimedProductId: string | undefined,
): Promise<{ ok: boolean; productId?: string }> {
  if (platform !== "play" && platform !== "appstore") return { ok: false };
  if (!receipt || receipt.length < 8) return { ok: false };
  // 스텁: 클라가 함께 보낸 product_id 를 임시로 사용(실제론 영수증에서 추출).
  const productId = claimedProductId;
  if (!productId || !(productId in GRANTS)) return { ok: false };
  // (Deno) 비동기 시그니처 유지를 위한 no-op await — 실제 검증은 fetch 기반.
  await Promise.resolve();
  return { ok: true, productId };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);

  const userId = await getUserId(req);
  if (!userId) return errorResponse("unauthorized", 401);

  let body: VerifyRequest;
  try {
    body = (await req.json()) as VerifyRequest;
  } catch {
    return errorResponse("invalid_json", 400);
  }
  const { platform, receipt, product_id } = body;
  if (!platform || !receipt) return errorResponse("missing_params", 400);

  // 1) 영수증 검증(스텁). 신뢰 원천 = 검증 결과의 productId.
  const verified = await verifyReceipt(platform, receipt, product_id);
  if (!verified.ok || !verified.productId) {
    return errorResponse("invalid_receipt", 402);
  }
  const productId = verified.productId;
  const grant = GRANTS[productId];
  if (!grant) return errorResponse("unknown_product", 422);

  const supabase = createServiceClient();

  // 2) 멱등 insert (GUARDRAILS §1.4): purchases(platform, receipt) UNIQUE.
  //    먼저 verified=false 로 삽입을 시도 → 충돌(23505)이면 이미 처리된 영수증.
  const { data: inserted, error: insErr } = await supabase
    .from("purchases")
    .insert({
      user_id: userId,
      product_id: productId,
      platform,
      receipt,
      verified: false,
    })
    .select("id, verified")
    .maybeSingle();

  if (insErr) {
    // 23505 = unique_violation → 이미 지급된 영수증(멱등). 재지급하지 않는다.
    // (Postgres 오류코드. supabase-js 는 error.code 로 전달.)
    // deno-lint-ignore no-explicit-any
    if ((insErr as any).code === "23505") {
      return jsonResponse({
        ok: true,
        idempotent: true,
        product_id: productId,
        granted: false,
      });
    }
    return errorResponse("db_error", 500, insErr.message);
  }
  if (!inserted) return errorResponse("insert_failed", 500);

  // 3) starter_pack 첫구매 1회 제한: 이미 verified 된 동일 product 가 있으면 미지급.
  if (grant.onceOnly) {
    const { count, error: cntErr } = await supabase
      .from("purchases")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("product_id", productId)
      .eq("verified", true);
    if (cntErr) return errorResponse("db_error", 500, cntErr.message);
    if ((count ?? 0) > 0) {
      // 이번 영수증은 기록하되(중복 행) 지급은 차단 → verified=true 로 마감만.
      await supabase.from("purchases").update({ verified: true }).eq("id", inserted.id);
      return jsonResponse({
        ok: true,
        idempotent: true,
        product_id: productId,
        granted: false,
        reason: "once_only_already_claimed",
      });
    }
  }

  // 4) 지급 — 지갑/인벤토리 원자 갱신 (서버 권위, service role 로 RLS 우회).
  //    wallets 는 read-then-write. 결제 멱등키(receipt UNIQUE)가 중복 지급을 막으므로
  //    이 지급은 영수증당 1회만 도달한다.
  const { data: wallet, error: wErr } = await supabase
    .from("wallets")
    .select("coins, pearls")
    .eq("user_id", userId)
    .maybeSingle();
  if (wErr) return errorResponse("db_error", 500, wErr.message);
  if (!wallet) return errorResponse("no_wallet", 422);

  const newPearls = (wallet.pearls ?? 0) + (grant.pearls ?? 0);
  const newCoins = (wallet.coins ?? 0) + (grant.coins ?? 0);
  if (grant.pearls || grant.coins) {
    const { error: updErr } = await supabase
      .from("wallets")
      .update({ pearls: newPearls, coins: newCoins })
      .eq("user_id", userId);
    if (updErr) return errorResponse("db_error", 500, updErr.message);
  }

  // 아이템 지급(inventory upsert, qty 가산).
  for (const it of grant.items ?? []) {
    const { data: inv, error: invSelErr } = await supabase
      .from("inventory")
      .select("qty")
      .eq("user_id", userId)
      .eq("item_id", it.item_id)
      .maybeSingle();
    if (invSelErr) return errorResponse("db_error", 500, invSelErr.message);
    if (!inv) {
      const { error: e } = await supabase
        .from("inventory")
        .insert({ user_id: userId, item_id: it.item_id, qty: it.qty });
      if (e) return errorResponse("db_error", 500, e.message);
    } else {
      const { error: e } = await supabase
        .from("inventory")
        .update({ qty: (inv.qty ?? 0) + it.qty })
        .eq("user_id", userId)
        .eq("item_id", it.item_id);
      if (e) return errorResponse("db_error", 500, e.message);
    }
  }

  // 5) verified=true 마감.
  const { error: vErr } = await supabase
    .from("purchases")
    .update({ verified: true })
    .eq("id", inserted.id);
  if (vErr) return errorResponse("db_error", 500, vErr.message);

  // 6) 결과 반환 — user_id 미포함(GUARDRAILS §10).
  return jsonResponse({
    ok: true,
    idempotent: false,
    product_id: productId,
    granted: true,
    grant: { pearls: grant.pearls ?? 0, coins: grant.coins ?? 0, items: grant.items ?? [] },
  });
});
