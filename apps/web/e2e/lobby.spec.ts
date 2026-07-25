/**
 * 로비 코어 액션 — feed_fish / clean_aquarium / collect_offline RPC 왕복.
 * 낙관적 UI 후 서버 권위 재조회(conflict → refresh 재시도) 경로가 에러 없이 완주하는지.
 */
import { expect, test } from '@playwright/test';

test('로비: 먹이·청소·오프라인 적립 서버 왕복', async ({ page }) => {
  await page.goto('/lobby');
  await expect(page.getByText(/어항 #1/)).toBeVisible({ timeout: 30_000 });

  // 먹이 (feed_fish)
  const feedDone = page.waitForResponse((r) => r.url().includes('/rpc/feed_fish'));
  await page.getByRole('button', { name: /먹이/ }).click();
  await feedDone;
  await expect(page.getByRole('button', { name: /먹이/ })).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByText(/오류:/)).toHaveCount(0);

  // 청소 (clean_aquarium)
  const cleanDone = page.waitForResponse((r) => r.url().includes('/rpc/clean_aquarium'));
  await page.getByRole('button', { name: /청소/ }).click();
  await cleanDone;
  await expect(page.getByRole('button', { name: /청소/ })).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByText(/오류:/)).toHaveCount(0);

  // 오프라인 적립 (collect_offline) → 적립 알림
  await page.getByRole('button', { name: /오프라인 적립/ }).click();
  await expect(page.getByText(/오프라인 적립 \+/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/오류:/)).toHaveCount(0);

  // 하트 수령 (claim_gifts) — 신규 유저는 받은 선물 없음
  await page.getByRole('button', { name: /하트 수령/ }).click();
  await expect(page.getByText(/받을 선물이 아직 없어요/)).toBeVisible({ timeout: 15_000 });

  // 공유 링크 발급 (issue_share_token) — 불투명 토큰 URL 노출(user_id 미포함)
  await page.getByRole('button', { name: /공유 링크 만들기/ }).click();
  const link = page.locator('a[href*="/aquarium/"]');
  await expect(link).toBeVisible({ timeout: 15_000 });
  const href = await link.getAttribute('href');
  expect(href).toMatch(/\/aquarium\/[A-Za-z0-9_-]{16,}$/);
  await expect(page.getByText(/오류:/)).toHaveCount(0);
});
