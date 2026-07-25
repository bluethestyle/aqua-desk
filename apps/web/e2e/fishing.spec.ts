/**
 * 낚시 (W4) — game-spec FSM 구동 + fishing-resolve(Edge) 서버 권위 왕복.
 *  - 성공: start_fishing(스태미나 5→4) → 캐스팅(중앙=Perfect) → 탭 → 릴링 0.95 → 보상 표시.
 *  - 실패: cast_fail → 빈손 result (resolve 미호출, 스태미나는 소모 유지).
 */
import { expect, test } from '@playwright/test';

test('낚시 성공 플로우: 보상 표시 + 스태미나 차감', async ({ page }) => {
  await page.goto('/fishing');
  await expect(page.getByText(/⚡ 5\/5/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: /낚시 시작/ }).click();
  // start_fishing 성공 → 캐스팅 단계 + 스태미나 4/5
  await expect(page.getByRole('button', { name: /캐스팅 \(→ 입질 대기\)/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/⚡ 4\/5/)).toBeVisible({ timeout: 15_000 });

  // 게이지 기본 0.50 = Perfect 존 → 캐스팅
  await page.getByRole('button', { name: /캐스팅 \(→ 입질 대기\)/ }).click();
  await page.getByRole('button', { name: /^탭!/ }).click();

  // 릴링: time-in-zone 0.95 (≥0.9 → Perfect Catch)
  await page.locator('input[type="range"]').fill('0.95');
  await page.getByRole('button', { name: /릴링 성공/ }).click();

  // fishing-resolve 왕복 → 보상 표시(종/성격/크기)
  await expect(page.getByText(/종: /)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/오류:/)).toHaveCount(0);
  // 결과 후에도 스태미나는 4/5 (성공해도 반환 없음)
  await expect(page.getByText(/⚡ 4\/5/)).toBeVisible({ timeout: 15_000 });
});

test('낚시 실패 플로우: 빈손 result + 스태미나 미반환', async ({ page }) => {
  await page.goto('/fishing');
  await expect(page.getByText(/⚡ 5\/5/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: /낚시 시작/ }).click();
  await page.getByRole('button', { name: /캐스팅 실패/ }).click();
  await expect(page.getByText(/놓쳤습니다/)).toBeVisible();

  await page.getByRole('button', { name: /결과 확인\(빈손\)/ }).click();
  await expect(page.getByText(/빈손 — 다음엔/)).toBeVisible();
  await expect(page.getByText(/⚡ 4\/5/)).toBeVisible({ timeout: 15_000 });
});
