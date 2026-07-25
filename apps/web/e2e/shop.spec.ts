/**
 * 상점 (W3) — 카탈로그(public read) 렌더 + purchase_item 서버 권위.
 * 신규 유저는 코인 0 → 구매는 서버가 거부해야 하며 잔액/보유는 불변이어야 한다.
 */
import { expect, test } from '@playwright/test';

test('상점: 카탈로그 14종 + 오늘의 상점 6슬롯 + 잔액 0 구매는 서버 거부·잔액 불변', async ({ page }) => {
  await page.goto('/shop');

  // 시드 카탈로그: deco 10 + food 2 + theme 2 = 14 (IAP 스텁 버튼은 '구매 (스텁)'라 제외됨)
  const catalogSection = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: /판매 품목/ }) });
  await expect(
    catalogSection.getByRole('button', { name: '구매', exact: true }),
  ).toHaveCount(14, { timeout: 30_000 });

  // 오늘의 상점(daily-shop-roll) — date+user seed 6슬롯
  const dailySection = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: /오늘의 상점/ }) });
  await expect(
    dailySection.getByRole('button', { name: '구매', exact: true }),
  ).toHaveCount(6, { timeout: 30_000 });

  // 지갑 로드(신규 유저 코인 0)
  await expect(page.getByText(/⚡ \d+\/\d+/)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('span', { hasText: /^🪙 0$/ })).toBeVisible();

  // 잔액 0으로 구매 시도 → 서버 거부(원자 차감 실패) → 오류 표시 + 잔액 불변
  await catalogSection.getByRole('button', { name: '구매', exact: true }).first().click();
  await expect(page.getByText(/오류:/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('span', { hasText: /^🪙 0$/ })).toBeVisible();
  await expect(page.getByText(/구매 완료/)).toHaveCount(0);
});
