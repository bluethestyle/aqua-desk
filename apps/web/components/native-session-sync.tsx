'use client';

/**
 * NativeSessionSync — R8 세션 단일화 브리지 (설계서/03 §6.1, 04 §2.1; GUARDRAILS §5).
 * 네이티브 WebView 모드에서만 동작(브라우저에서는 no-op):
 *  1) 시작 시: 네이티브 세션 승계(adoptNativeSession — 만료 전 access만 주입, 웹 refresh 금지).
 *  2) '새로 발급된' 세션 이벤트(SIGNED_IN/TOKEN_REFRESHED/USER_UPDATED)에서만 refresh token을
 *     네이티브에 위탁. ★INITIAL_SESSION(복원)은 위탁 금지 — 복원본은 네이티브 회전 이전의
 *     낡은 토큰일 수 있어 Keystore의 최신 토큰을 역행 덮어쓰기 하게 된다(리뷰 확정 결함).
 *  3) SIGNED_OUT은 무시 — refresh 실패 등으로도 발화되므로 여기서 clearAuthSession하면
 *     웹 일시 오류가 네이티브 백그라운드 세션을 파괴한다. 네이티브 세션 파기는
 *     사용자의 명시적 로그아웃(account 페이지)만 수행한다.
 * PageShell에 마운트되어 모든 페이지에서 1회 구동된다(UI 없음).
 */

import { useEffect } from 'react';
import { hasBridge, setAuthSession } from '../lib/bridge';
import { getSupabaseClient } from '../lib/supabase/client';
import { adoptNativeSession } from '../lib/supabase/native-session';

/** 마지막으로 위탁한 refresh token — 동일 토큰 반복 위탁(브리지 왕복) 방지. */
let lastHandedOff: string | null = null;

/** 위탁 대상 이벤트 — '이 웹 컨텍스트에서 새로 발급/갱신된' 세션만. */
const HANDOFF_EVENTS = new Set(['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED']);

export function NativeSessionSync() {
  useEffect(() => {
    if (!hasBridge()) return;
    const supabase = getSupabaseClient();

    // 1) 콜드스타트 승계(웹 세션은 메모리 전용이라 매 시작마다 시도).
    void adoptNativeSession();

    // 2) 신규 발급 세션 → 네이티브 위탁. 3) SIGNED_OUT은 의도적으로 무시.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!HANDOFF_EVENTS.has(event)) return;
      const refreshToken = session?.refresh_token;
      if (refreshToken && refreshToken !== lastHandedOff) {
        lastHandedOff = refreshToken;
        void setAuthSession(refreshToken);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return null;
}
