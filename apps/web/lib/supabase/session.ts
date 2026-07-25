'use client';

/**
 * Guest session bootstrap (게스트 = 익명 인증).
 *
 * 서버 권위(GUARDRAILS §1, §7): 클라는 anon key만 사용. 익명 로그인으로 `auth.users`
 * 행이 생기면 부트스트랩 트리거(handle_new_user, supabase/migrations/0003)가
 * profiles·wallets·기본 어항 #1·환영 물고기를 생성한다 → 이후 자기 행 SELECT + 서버 RPC만.
 *
 * R8(설계서/04 §2.1): 네이티브 WebView 모드에서는 토큰 refresh 단일 주체가 네이티브이며
 * 웹은 브리지 getAuthSession()으로 세션을 주입받는다. 여기서는 웹 단독(브라우저) 경로만 다룬다.
 * 네이티브 모드 주입은 추후(A5) lib/bridge에서 처리.
 */

import { getSupabaseClient } from './client';

/**
 * 진행 중인 세션 보장 프라미스(모듈 단일).
 * 첫 로드 때 WalletBar(loadWallet)와 페이지 로더(loadLobby 등)가 동시에 ensureSession을
 * 부르면 익명 가입이 2번 일어나 "유저 A 데이터 로드 → 유저 B 토큰으로 RPC" 레이스가 생긴다
 * (not_found_or_forbidden 간헐 실패 + 익명 유저 중복 생성). 반드시 단일화한다.
 */
let inflight: Promise<string> | null = null;

/**
 * 현재 세션을 보장한다. 세션이 없으면 익명 로그인하고 user id를 반환한다.
 * (익명 인증은 Supabase 프로젝트에서 Anonymous sign-ins가 켜져 있어야 한다.)
 * 동시 호출은 동일 프라미스를 공유한다 — 익명 가입은 컨텍스트당 1회.
 */
export function ensureSession(): Promise<string> {
  if (!inflight) {
    inflight = (async (): Promise<string> => {
      const supabase = getSupabaseClient();

      const { data: sessionData } = await supabase.auth.getSession();
      const existing = sessionData.session?.user;
      if (existing) return existing.id;

      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      if (!data.user) throw new Error('anonymous sign-in returned no user');
      return data.user.id;
    })().catch((e: unknown) => {
      // 실패는 캐시하지 않는다 — 다음 호출이 재시도할 수 있게 리셋.
      inflight = null;
      throw e;
    });
  }
  return inflight;
}
