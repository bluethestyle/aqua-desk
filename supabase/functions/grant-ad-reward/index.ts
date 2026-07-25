// grant-ad-reward/index.ts
// -----------------------------------------------------------------------------
// Edge Function (Deno, service role) — kebab-case URL: /grant-ad-reward
//
// 계약 (GUARDRAILS §4.3 / 설계서 04 §5.1):
//   grant-ad-reward(kind text, ssv jsonb) → { ok, kind, granted, stamina?, idempotent?, pending? }
//   - 리워드 광고 보상을 "서버가" 지급(클라는 보상을 직접 지급하지 않음 — 서버 권위).
//   - kind: 'stamina'(+1) | 'offline_x2'(오프라인 적립 2배) | 'shop_refresh'(상점 무료 리프레시)
//
// 책임 분리:
//   - 이 Edge: 인증(JWT) + SSV 검증(위조 콜백 차단) 후 grant_ad_reward RPC에 위임.
//   - grant_ad_reward RPC(단일 트랜잭션): 멱등(nonce 재전송 = 기존 결과 재반환) +
//     kind별 일일 한도 + 원자 지급 + ad_reward_log 기록. 부분 실패로 한도만 소진되거나
//     보상이 유실되는 경로 없음. 상수 SoT = game-spec AD_REWARD.
//
// ⚠️ TODO(구현 자리 — 프로덕션 전):
//   1) SSV: verifyAdSsv()는 아직 스텁(형식 검증) — 광고 네트워크(AdMob 등) 공개키
//      서명 검증으로 교체 필수. nonce는 광고 네트워크가 발급한 값을 사용.
//   2) offline_x2 / shop_refresh 는 토큰성 보상 적립(스키마 확장) 후 grant RPC에서 소비 연결.
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

interface AdRewardRequest {
  kind: RewardKind;
  // SSV 검증용 페이로드(광고 네트워크 콜백/토큰). 스텁에서는 형식만 확인.
  ssv?: { signature?: string; nonce?: string; transaction_id?: string };
}

/**
 * 광고 SSV 검증 스텁.
 * TODO(구현 자리): 광고 네트워크 공개키로 서명 검증. nonce 재사용 차단은 RPC의
 * ad_reward_log UNIQUE(user_id, nonce)가 담당(재전송은 멱등 재반환).
 * @returns 위조/누락이면 false
 */
async function verifyAdSsv(ssv: AdRewardRequest["ssv"]): Promise<boolean> {
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

  // 지급/한도/멱등/로그는 전부 RPC 트랜잭션이 원자 처리(service_role 전용 함수 —
  // 클라 직접 호출 불가라 SSV 게이트 우회가 안 된다). 신원은 위에서 JWT로 해석한
  // userId를 target_user로 전달한다(GUARDRAILS §1.3 — 클라 전달값 불신).
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("grant_ad_reward", {
    target_user: userId,
    kind,
    nonce: ssv!.nonce!,
  });

  if (error) {
    // 동시 재전송의 유니크 충돌 등 — 클라 재시도 시 멱등 재반환으로 수렴.
    return errorResponse("db_error", 500);
  }
  const res = (data ?? {}) as {
    status?: string;
    granted?: boolean;
    stamina?: number;
    idempotent?: boolean;
    pending?: boolean;
  };
  if (res.status === "daily_limit_reached") {
    return errorResponse("daily_limit_reached", 429);
  }
  if (res.status !== "ok") return errorResponse("grant_failed", 500);

  return jsonResponse({
    ok: true,
    kind,
    granted: res.granted === true,
    stamina: res.stamina,
    idempotent: res.idempotent === true,
    pending: res.pending === true,
  });
});
