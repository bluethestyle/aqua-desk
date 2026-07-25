/**
 * E2E 공용 헬퍼 — REST 직접 호출(테스트 픽스처용)과 뷰포트 검증.
 * 익명 가입/RPC는 전부 anon 키 + 사용자 JWT 경로만 사용한다(서버 권위 준수).
 */
import type { Page } from '@playwright/test';
import { ANON_KEY, SUPABASE_URL } from './env';

export interface AnonUser {
  accessToken: string;
  userId: string;
}

/** 익명 유저 생성(부트스트랩 트리거로 지갑·어항#1·환영 물고기 자동 생성). */
export async function createAnonUser(): Promise<AnonUser> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`anon signup failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; user: { id: string } };
  return { accessToken: json.access_token, userId: json.user.id };
}

/** 해당 유저 JWT로 aquadesk 스키마 RPC 호출(PostgREST). */
export async function rpcAs(
  user: AnonUser,
  fn: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${user.accessToken}`,
      'Content-Type': 'application/json',
      'Content-Profile': 'aquadesk',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${fn} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** 해당 유저 JWT로 aquadesk 스키마 테이블 SELECT(PostgREST). */
export async function restGetAs(user: AnonUser, pathAndQuery: string): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${user.accessToken}`,
      'Accept-Profile': 'aquadesk',
    },
  });
  if (!res.ok) throw new Error(`rest ${pathAndQuery} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** 해당 유저 JWT로 Edge Function 호출 — 상태코드까지 검증할 수 있게 raw 반환. */
export async function edgeAs(
  user: AnonUser,
  fn: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${user.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, json };
}

/** 문서의 가로 오버플로(px). 모바일 레이아웃 검증용 — 0이어야 정상. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
}
