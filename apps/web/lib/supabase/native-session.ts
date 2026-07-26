'use client';

/**
 * 네이티브 세션 승계 (R8 — 설계서/03 §6.1; 리뷰 확정 결함 픽스).
 *
 * 불변식: 웹은 refresh를 수행하지 않는다. 그래서 승계는 **만료 전 access token이 있을 때만**
 * setSession을 호출한다(만료 access를 넘기면 supabase-js가 내부에서 refresh를 수행해
 * 네이티브 회전과 경쟁 — 금지 경로). access가 낡았으면 네이티브에 재동기화 신호를 보내고
 * 잠시 대기해 fresh access를 다시 읽는다.
 */

import { getAuthSession, hasBridge, setAuthSession } from '../bridge';
import { getSupabaseClient } from './client';

/** JWT exp(ms). 파싱 실패 = 0(만료 취급). */
function jwtExpMs(token: string): number {
  try {
    const payload = token.split('.')[1] ?? '';
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: number }).exp ?? 0;
    return exp * 1000;
  } catch {
    return 0;
  }
}

let adoptInflight: Promise<boolean> | null = null;

/**
 * 네이티브 보관 세션을 웹 클라이언트에 승계한다. 성공 시 true.
 * 동시 호출은 single-flight. 네이티브 세션이 없으면 false(게스트 플로우 허용 신호).
 */
export function adoptNativeSession(): Promise<boolean> {
  if (!hasBridge()) return Promise.resolve(false);
  if (!adoptInflight) {
    adoptInflight = (async (): Promise<boolean> => {
      const supabase = getSupabaseClient();
      const { data } = await supabase.auth.getSession();
      if (data.session) return true;

      // 최대 ~6초: 네이티브 TokenRefresher가 fresh access를 채울 시간을 준다.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const native = await getAuthSession().catch(() => null);
        if (!native?.refreshToken) return false; // 네이티브 세션 없음.

        const fresh =
          !!native.accessToken && jwtExpMs(native.accessToken) > Date.now() + 60_000;
        if (fresh && native.accessToken) {
          // 만료 전 access만 주입 — setSession의 암묵 refresh 경로를 타지 않는다(R8).
          const { error } = await supabase.auth.setSession({
            access_token: native.accessToken,
            refresh_token: native.refreshToken,
          });
          return !error;
        }
        // access가 낡음 → 동일 RT 재위탁은 네이티브에서 no-op + 동기화 트리거로 처리된다.
        if (attempt === 0) void setAuthSession(native.refreshToken);
        await new Promise((r) => setTimeout(r, 1_500));
      }
      return false;
    })().finally(() => {
      adoptInflight = null;
    });
  }
  return adoptInflight;
}

/** 네이티브가 세션(refresh token)을 보유 중인지 — ensureSession의 익명 가입 게이트용. */
export async function nativeHasSession(): Promise<boolean> {
  if (!hasBridge()) return false;
  const native = await getAuthSession().catch(() => null);
  return !!native?.refreshToken;
}
