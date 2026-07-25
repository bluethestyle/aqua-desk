// grant-ad-reward/index.ts
// -----------------------------------------------------------------------------
// Edge Function (Deno, service role) — kebab-case URL: /grant-ad-reward
//
// 계약 (GUARDRAILS §4.3 / 설계서 04 §5.1):
//   grant-ad-reward(kind text) → { ok, kind, granted }
//   - 리워드 광고 보상을 "서버가" 지급(클라는 보상을 직접 지급하지 않음 — 서버 권위).
//   - kind: 'stamina'(+1) | 'offline_x2'(오프라인 적립 2배) | 'shop_refresh'(상점 무료 리프레시)
//   - kind별 1일 횟수 제한.
//   - SSV(Server-Side Verification)로 위조 콜백 차단.
//   - service role 로 RLS 우회(auth.role()='service_role' → GUC 불필요, §4.3 "(svc)")
//
// ⚠️ TODO(구현 자리 — SSV / 남용 방지):
//   1) SSV: 광고 네트워크(AdMob 등)의 Server-Side Verification 콜백 서명을 검증한다.
//      - verifyAdSsv(): 광고 네트워크 공개키로 서명 검증 + nonce/transaction_id 재사용 차단.
//      - 현재는 스텁(형식 검증)이다. 프로덕션 전 필수 교체.
//   2) 일 횟수 제한: kind별 1일 N회. 본 스텁은 카운트 테이블이 아직 없으므로
//      "한도 검사 자리"만 명시 주석으로 둔다. 구현 옵션:
//      - (권장) ad_reward_log(user_id, kind, day) 테이블 + UNIQUE/카운트로 원자 제한,
//        또는 SECURITY DEFINER RPC 로 일 한도 CAS. (서버 권위 §1)
//      - 회당 nonce 를 ad_reward_log 에 기록해 SSV 중복 콜백 멱등 처리.
//   3) offline_x2 / shop_refresh 는 "다음 1회"에 적용되는 토큰성 보상이라
//      즉시 재화 증감이 아니다 → 적용 시점(collect_offline / daily-shop-roll)에서
//      소비되도록 사용자 플래그(예: wallets 확장 또는 별도 토큰 테이블)에 적립한다.
//      현재는 스키마 확장 전이라 stamina 만 즉시 지급하고, 나머지는 자리표시로 둔다.
// -----------------------------------------------------------------------------

import {
  createServiceClient,
  errorResponse,
  getUserId,
  handlePreflight,
  jsonResponse,
} from "../_shared/supabase.ts";

type RewardKind = "stamina" | "offline_x2" | "shop_refresh"; // 설계서 04 §5.1
const VALID_KINDS: RewardKind[] = ["stamina", "offline_x2", "shop_refresh"];

// kind별 1일 횟수 제한(초기값 — 튜닝 대상). 실제 강제는 TODO(2)의 카운트 저장 필요.
const DAILY_LIMIT: Record<RewardKind, number> = {
  stamina: 5,
  offline_x2: 1,
  shop_refresh: 1,
};

// 스태미나 보상량 + cap. cap 은 GUARDRAILS §6: 기본 5, 아쿠아 패스 +2(=7).
const STAMINA_REWARD = 1;
const STAMINA_CAP_BASE = 5;
const STAMINA_CAP_PASS = 7;

interface AdRewardRequest {
  kind: RewardKind;
  // SSV 검증용 페이로드(광고 네트워크 콜백/토큰). 스텁에서는 형식만 확인.
  ssv?: { signature?: string; nonce?: string; transaction_id?: string };
}

/**
 * 광고 SSV 검증 스텁.
 * TODO(구현 자리): 광고 네트워크 공개키로 서명 검증 + nonce 재사용 차단.
 * @returns 위조/누락이면 false
 */
async function verifyAdSsv(
  ssv: AdRewardRequest["ssv"],
): Promise<boolean> {
  // 스텁: SSV 페이로드(nonce)가 있는지 형식만 확인. 프로덕션은 서명검증 필수.
  await Promise.resolve();
  if (!ssv || !ssv.nonce) {
    // 프로토 단계 허용 다이얼: nonce 없으면 거부(위조 콜백 차단의 최소선).
    return false;
  }
  return true;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);

  const userId = await getUserId(req);
  if (!userId) return errorResponse("unauthorized", 401);

  let body: AdRewardRequest;
  try {
    body = (await req.json()) as AdRewardRequest;
  } catch {
    return errorResponse("invalid_json", 400);
  }
  const { kind, ssv } = body;
  if (!kind || !VALID_KINDS.includes(kind)) {
    return errorResponse("invalid_kind", 400);
  }

  // SSV 검증(위조 콜백 차단 — 설계서 04 §5.1 "남용 방지").
  const ssvOk = await verifyAdSsv(ssv);
  if (!ssvOk) return errorResponse("ssv_failed", 403);

  // ── 일 횟수 제한 검사 자리 (TODO 2) ──────────────────────────────────────
  // const limit = DAILY_LIMIT[kind];
  // const usedToday = await countAdRewardsToday(supabase, userId, kind); // 미구현
  // if (usedToday >= limit) return errorResponse("daily_limit_reached", 429);
  // (위 카운트 저장 테이블/RPC 가 도입되면 활성화. 현재는 한도 상수만 선언해 둔다.)
  void DAILY_LIMIT; // 상수 사용 표식(린트) — 한도 강제는 TODO(2)에서.

  const supabase = createServiceClient();

  if (kind === "stamina") {
    // 스태미나 +1 (cap 적용, 아쿠아 패스면 +2 cap). 서버 권위 쓰기.
    const { data: wallet, error: wErr } = await supabase
      .from("wallets")
      .select("stamina")
      .eq("user_id", userId)
      .maybeSingle();
    if (wErr) return errorResponse("db_error", 500, wErr.message);
    if (!wallet) return errorResponse("no_wallet", 422);

    // 아쿠아 패스 여부로 cap 결정(profiles.aqua_pass_until).
    const { data: profile, error: pErr } = await supabase
      .from("profiles")
      .select("aqua_pass_until")
      .eq("id", userId)
      .maybeSingle();
    if (pErr) return errorResponse("db_error", 500, pErr.message);

    const hasPass = profile?.aqua_pass_until
      ? new Date(profile.aqua_pass_until).getTime() > Date.now()
      : false;
    const cap = hasPass ? STAMINA_CAP_PASS : STAMINA_CAP_BASE;
    const next = Math.min(cap, (wallet.stamina ?? 0) + STAMINA_REWARD);

    const { error: updErr } = await supabase
      .from("wallets")
      .update({ stamina: next })
      .eq("user_id", userId);
    if (updErr) return errorResponse("db_error", 500, updErr.message);

    return jsonResponse({ ok: true, kind, granted: true, stamina: next });
  }

  // offline_x2 / shop_refresh: "다음 1회"에 적용되는 토큰성 보상.
  // TODO(구현 자리 — 3): 적용 시점(collect_offline / daily-shop-roll)에서 소비할
  //   사용자 토큰을 적립해야 한다(스키마 확장 필요). 현재는 자리표시로 수락만 반환.
  return jsonResponse({
    ok: true,
    kind,
    granted: false,
    pending: true,
    note: "token reward pending schema (see TODO 3)",
  });
});
