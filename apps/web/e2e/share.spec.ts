/**
 * 공유 뷰어 (B5/W5) — 불투명 share_token 만으로 접근(user_id 비노출, GUARDRAILS §1.3).
 *  - 소유자(REST 픽스처)가 issue_share_token 발급 → 다른 익명 유저(브라우저)가 열람 + 하트.
 *  - 무효 토큰 → not_found 안내.
 */
import { expect, test } from '@playwright/test';
import { createAnonUser, rpcAs } from './utils';

test('유효 토큰: 읽기 전용 스냅샷 + 하트 보내기(send_heart)', async ({ page }) => {
  // 픽스처: 소유자 익명 유저 + 공유 토큰 발급(브라우저 유저와 다른 계정 → 자기선물 아님)
  const owner = await createAnonUser();
  const token = (await rpcAs(owner, 'issue_share_token', { aquarium_idx: 1 })) as string;
  expect(typeof token).toBe('string');
  expect(token.length).toBeGreaterThanOrEqual(16);

  await page.goto(`/aquarium/${token}`);
  await expect(page.getByText(/테마 deepsea/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/물고기 1/)).toBeVisible(); // 환영 물고기 1마리

  await page.getByRole('button', { name: /하트 보내기/ }).click();
  await expect(page.getByText(/하트를 보냈어요/)).toBeVisible({ timeout: 15_000 });
});

test('무효 토큰: 수족관을 찾을 수 없음', async ({ page }) => {
  await page.goto('/aquarium/invalid-token-0000000000');
  await expect(page.getByText(/수족관을 찾을 수 없음/)).toBeVisible({ timeout: 30_000 });
});

test('자기 어항 하트는 서버가 차단(self_gift_blocked)', async ({ page }) => {
  // 브라우저 유저의 세션을 만들고, 그 유저 본인 토큰으로 자기 어항을 연다.
  await page.goto('/lobby');
  await expect(page.getByText(/⚡ \d+\/\d+/)).toBeVisible({ timeout: 30_000 });

  const accessToken = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) {
        const raw = localStorage.getItem(k);
        if (raw) return (JSON.parse(raw) as { access_token?: string }).access_token ?? null;
      }
    }
    return null;
  });
  expect(accessToken).toBeTruthy();

  const token = (await rpcAs(
    { accessToken: accessToken as string, userId: '' },
    'issue_share_token',
    { aquarium_idx: 1 },
  )) as string;

  await page.goto(`/aquarium/${token}`);
  await expect(page.getByText(/테마 deepsea/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: /하트 보내기/ }).click();
  await expect(page.getByText(/하트를 보내지 못했어요/)).toBeVisible({ timeout: 15_000 });
});
