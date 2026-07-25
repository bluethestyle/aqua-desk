/**
 * .env.local 로더 — Next.js 밖(Playwright 러너)에서도 NEXT_PUBLIC_* 를 쓰기 위함.
 * anon(publishable) 키만 다룬다. secret 키는 여기서 절대 읽지 않는다(GUARDRAILS §7).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env.local', import.meta.url));
try {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  // .env.local 없으면 이미 설정된 process.env 에 의존.
}

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

/** 고정 테스트 계정(선택) — 크리덴셜은 커밋 금지라 .env.local/CI 시크릿으로만 주입. 없으면 해당 테스트 skip. */
export const TEST_EMAIL = process.env.E2E_TEST_EMAIL ?? '';
export const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD ?? '';

if (!SUPABASE_URL || !ANON_KEY) {
  throw new Error('e2e: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 필요 (.env.local)');
}
