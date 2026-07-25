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
 * 익명 가입 single-flight 프라미스(모듈 단일).
 * 첫 로드 때 WalletBar(loadWallet)와 페이지 로더(loadLobby 등)가 동시에 ensureSession을
 * 부르면 익명 가입이 2번 일어나 "유저 A 데이터 로드 → 유저 B 토큰으로 RPC" 레이스가 생긴다
 * (not_found_or_forbidden 간헐 실패 + 익명 유저 중복 생성). 가입만 단일화하고,
 * 세션 조회는 매번 fresh(getSession) — 로그인/로그아웃(계정 페이지) 후에도 낡지 않는다.
 */
let signupInflight: Promise<string> | null = null;

/**
 * 현재 세션을 보장한다. 세션이 없으면 익명 로그인하고 user id를 반환한다.
 * (익명 인증은 Supabase 프로젝트에서 Anonymous sign-ins가 켜져 있어야 한다.)
 * 동시 호출 시 익명 가입은 1회만 수행되어 동일 유저를 공유한다.
 */
export async function ensureSession(): Promise<string> {
  const supabase = getSupabaseClient();

  const { data: sessionData } = await supabase.auth.getSession();
  const existing = sessionData.session?.user;
  if (existing) return existing.id;

  if (!signupInflight) {
    signupInflight = (async (): Promise<string> => {
      // 이중 확인: 대기 중 다른 경로(로그인 등)로 세션이 생겼으면 가입하지 않는다.
      const { data: again } = await supabase.auth.getSession();
      if (again.session?.user) return again.session.user.id;

      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      if (!data.user) throw new Error('anonymous sign-in returned no user');
      return data.user.id;
    })().finally(() => {
      // 성공/실패 무관 settle 후 리셋 — 로그아웃 뒤 새 게스트 생성이 가능해야 한다.
      // (대기 중이던 호출자들은 이미 같은 프라미스를 공유했으므로 중복 가입은 없다.)
      signupInflight = null;
    });
  }
  return signupInflight;
}
