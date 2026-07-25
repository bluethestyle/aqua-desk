// _shared/supabase.ts
// -----------------------------------------------------------------------------
// Aqua Desk — Edge Function 공유 헬퍼 (Deno / service-role)
//
// 서버 권위(GUARDRAILS §1.1): 경제·수집·결제·토큰 상태는 클라가 직접 쓰지 않는다.
// 모든 증감은 SECURITY DEFINER RPC 또는 이 service-role Edge Function으로만 수행.
//
// ⚠️ 보안 (GUARDRAILS §7 / §10):
//   - 이 클라이언트는 SUPABASE_SERVICE_ROLE_KEY 로 생성되며 RLS 를 우회한다.
//   - service role 키는 Edge Function 환경변수에만 존재하며, 클라 번들(apps/web,
//     apps/android)·로그·스냅샷·딥링크 어디에도 절대 노출/반환 금지.
//   - 이 모듈은 supabase/functions/* (Deno, 서버) 에서만 import 한다. 절대로
//     apps/web 같은 클라이언트 번들에서 import 하지 말 것.
//   - auth.role()='service_role' 이므로 보호 컬럼 GUC 플래그(app.authority_write)는
//     불필요하다 (GUARDRAILS §4.2 / §4.3 "(svc)").
// -----------------------------------------------------------------------------

// Deno std / supabase-js (Edge runtime URL imports)
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.45.4";

/**
 * service-role Supabase 클라이언트를 생성한다.
 *
 * RLS 를 우회하므로(서버 권위) 권위 테이블(wallets/inventory/dex_entries/
 * fish_instances/purchases/gifts/fishing_sessions)에 직접 쓸 수 있다.
 * 호출자의 JWT(authorization 헤더)는 전달하지 않는다 — 이 클라는 항상 service role.
 *
 * @returns service-role SupabaseClient
 * @throws 환경변수(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) 누락 시
 */
export function createServiceClient(): SupabaseClient {
  // Supabase Edge 런타임이 기본 주입하는 환경변수.
  // SUPABASE_SERVICE_ROLE_KEY 는 절대 NEXT_PUBLIC_* 로 노출하지 않는다(GUARDRAILS §7).
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !serviceRoleKey) {
    throw new Error(
      "missing_env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required (Edge Function env only)",
    );
  }

  return createClient(url, serviceRoleKey, {
    // ★스키마 격리(배포 변형): Edge 의 from()/rpc() 도 aquadesk 스키마 대상.
    db: { schema: "aquadesk" },
    auth: {
      // Edge Function 은 무상태 — 세션 영속/자동 refresh 불필요.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * 호출자(authenticated 사용자)의 user_id 를 Authorization Bearer JWT 에서 해석한다.
 *
 * service-role 클라이언트는 RLS 를 우회하므로, "누구의 행을 쓸지"는 반드시
 * 호출자 JWT 로부터 안전하게 결정해야 한다(클라가 보낸 user_id 를 신뢰하지 않는다 —
 * GUARDRAILS §1.3: user_id 는 클라/URL 에 노출/신뢰 금지).
 *
 * @param req 들어온 Request (Authorization: Bearer <access_token>)
 * @returns 인증된 사용자의 uuid, 미인증이면 null
 */
export async function getUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  // service-role 클라로 토큰을 검증해 user 를 얻는다(키 노출 없이 서버 측 검증).
  const supabase = createServiceClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

// -----------------------------------------------------------------------------
// CORS 헬퍼
// -----------------------------------------------------------------------------

/**
 * 공통 CORS 헤더. 프로토 단계에서는 "*" 허용.
 * TODO(구현 자리): 프로덕션에서는 허용 Origin 을 apps/web 의 배포 도메인으로 제한.
 */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * OPTIONS preflight 면 204 CORS 응답을 반환, 그 외엔 null.
 * @example
 *   const pre = handlePreflight(req); if (pre) return pre;
 */
export function handlePreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return null;
}

/** JSON 성공 응답(CORS 포함). */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * JSON 에러 응답(CORS 포함).
 * 멱등/충돌 신호(GUARDRAILS §1.5)는 호출부가 code 로 표준화: 'conflict' 등.
 * ⚠️ service role 키/내부 user_id 등 민감정보를 message 에 절대 포함하지 않는다.
 */
export function errorResponse(code: string, status = 400, message?: string): Response {
  return jsonResponse({ error: code, message: message ?? code }, status);
}
