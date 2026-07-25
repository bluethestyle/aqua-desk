/**
 * 스모크: 전 페이지 순회 — 로드·지갑(서버 왕복)·pageerror·가로 오버플로.
 * 하나의 컨텍스트(=익명 유저 1명)로 내비게이션 링크를 따라 순회한다.
 */
import { expect, test } from '@playwright/test';
import { horizontalOverflow } from './utils';

const PAGES = [
  { link: '로비', heading: '로비' },
  { link: '꾸미기', heading: '꾸미기' },
  { link: '상점', heading: '상점' },
  { link: '낚시', heading: '낚시' },
  { link: '도감', heading: '도감' },
  { link: '계정', heading: '계정' },
] as const;

test('전 페이지 순회: 로드·지갑 로드·pageerror 없음·가로 스크롤 없음', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto('/');
  await expect(page).toHaveURL(/\/lobby$/);

  for (const p of PAGES) {
    await page.getByRole('link', { name: p.link }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: p.heading }),
    ).toBeVisible({ timeout: 30_000 });
    // 지갑 로드 = 익명 세션 + wallets SELECT 왕복 성공 신호(⚡ n/cap 은 지갑에만 있음).
    await expect(page.getByText(/⚡ \d+\/\d+/)).toBeVisible({ timeout: 30_000 });
    expect(
      await horizontalOverflow(page),
      `${p.heading}: 가로 오버플로(px)`,
    ).toBeLessThanOrEqual(1);
  }

  expect(pageErrors, `pageerror 발생: ${pageErrors.join(' | ')}`).toEqual([]);
});
