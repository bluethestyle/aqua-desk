/**
 * 꾸미기 (W2) — 렌더 + 보호 컬럼(theme_id) 서버 권위.
 * 신규 유저: 보유 장식 없음, 프리미엄 테마 미보유 → set_aquarium_theme 은 서버가 거부해야 하고
 * 낙관적 UI는 refresh 로 deepsea 로 되돌아와야 한다.
 */
import { expect, test } from '@playwright/test';

test('꾸미기: 렌더 + 프리미엄 테마 변경은 서버가 거부(권위 복원)', async ({ page }) => {
  await page.goto('/decorate');
  await expect(page.getByText(/어항 #1/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/보유한 장식이 없습니다/)).toBeVisible();

  // 미보유 프리미엄 테마 → RPC 거부 → 오류 표시 + 권위 재조회로 deepsea 복원
  await page.getByRole('button', { name: /Cyberpunk/ }).click();
  await expect(page.getByText(/오류:/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/테마 deepsea/)).toBeVisible({ timeout: 15_000 });
});
