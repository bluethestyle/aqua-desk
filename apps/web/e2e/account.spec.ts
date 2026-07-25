/**
 * 계정 (auth 프로토) — 게스트→정식 전환(진행 승계) · 고정 테스트 계정 로그인 · 로그아웃.
 * 인증은 Supabase Auth 경유(auth.users 승격/세션 교체) — 게임 데이터 쓰기 없음.
 */
import { expect, test } from '@playwright/test';
import { TEST_EMAIL, TEST_PASSWORD } from './env';

test('게스트 → 정식 전환(데이터 승계) → 로그아웃 → 새 게스트', async ({ page }) => {
  await page.goto('/account');
  await expect(page.getByText('게스트(익명)')).toBeVisible({ timeout: 30_000 });

  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@aquadesk.dev`;
  await page.getByPlaceholder('이메일').first().fill(email);
  await page.getByPlaceholder('비밀번호 (6자 이상)').fill('E2e-pass-123!');
  await page.getByRole('button', { name: '전환하기' }).click();

  await expect(page.getByText(/정식 계정으로 전환됐어요/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(email)).toBeVisible({ timeout: 15_000 });

  // 진행 데이터 승계 — 부트스트랩 환영 물고기가 그대로 남아 있어야 한다.
  await page.goto('/lobby');
  await expect(page.getByText(/물고기 1/)).toBeVisible({ timeout: 30_000 });

  // 로그아웃 → /lobby 전체 리로드 → 새 게스트 세션 자동 시작(지갑 로드로 확인).
  await page.goto('/account');
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL(/\/lobby$/, { timeout: 20_000 });
  await expect(page.getByText(/⚡ \d+\/\d+/)).toBeVisible({ timeout: 30_000 });
});

test('기존 계정(고정 테스트 계정) 로그인 → 세션 교체', async ({ page }) => {
  // 크리덴셜은 커밋하지 않는다(GUARDRAILS §7) — .env.local의 E2E_TEST_EMAIL/PASSWORD.
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD 미설정 — skip');

  await page.goto('/account');
  await expect(page.getByText('게스트(익명)')).toBeVisible({ timeout: 30_000 });

  await page.getByPlaceholder('이메일').nth(1).fill(TEST_EMAIL);
  await page.getByPlaceholder('비밀번호', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인', exact: true }).click();

  await expect(page).toHaveURL(/\/lobby$/, { timeout: 20_000 });
  await page.goto('/account');
  await expect(page.getByText(TEST_EMAIL)).toBeVisible({ timeout: 30_000 });
});
