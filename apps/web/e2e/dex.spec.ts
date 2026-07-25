/**
 * 도감 (W5) — 카탈로그(fish_species) + 자기 dex 행 join 표시.
 * 시드: 종 6 (common 5 + mythic hero 1). 셀 6개 + 완성도 헤더.
 */
import { expect, test } from '@playwright/test';

test('도감: 완성도 헤더 + 종 6 그리드 렌더', async ({ page }) => {
  await page.goto('/dex');

  await expect(page.getByText(/완성도 \d+%/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/\/ 6 종 수집/)).toBeVisible();

  // 종 셀 6개(보유=이름+×n, 미보유=실루엣) — 셀 div 에만 title 이 있다.
  await expect(page.locator('div[title]')).toHaveCount(6);

  // 신화(mythic) 티어에 히어로 배지 노출
  await expect(page.getByText('★ 히어로')).toBeVisible();
});
