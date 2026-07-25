/**
 * 서버 계약(REST/Edge) 검증 — 브라우저 없이 계약만 본다.
 * 디바이스 프로파일과 무관하므로 desktop 프로젝트에서 1회만 실행.
 *  - save_slots: version CAS(ok/conflict) · 슬롯 캡 · 소유권 거부
 *  - grant-ad-reward: 일 5회 한도(429) · SSV nonce 재사용(409)
 */
import { expect, test } from '@playwright/test';
import { AD_REWARD } from '@aquadesk/game-spec';
import { createAnonUser, edgeAs, restGetAs, rpcAs } from './utils';

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'desktop', 'API 계약 테스트는 desktop 프로젝트에서 1회만');
});

test('save_slots: version CAS ok/conflict + 슬롯 캡 + 소유권 거부', async () => {
  const user = await createAnonUser();
  const rows = (await restGetAs(user, 'aquariums?select=id,version')) as Array<{
    id: string;
    version: number;
  }>;
  expect(rows.length).toBe(1);
  const aq = rows[0]!;

  // ok — version +1
  const ok = (await rpcAs(user, 'save_slots', {
    aquarium_id: aq.id,
    slots: [],
    expected_version: aq.version,
  })) as { status: string; version: number };
  expect(ok.status).toBe('ok');
  expect(ok.version).toBe(aq.version + 1);

  // 낡은 version → conflict (클라는 refresh 후 재시도하는 계약)
  const conflict = (await rpcAs(user, 'save_slots', {
    aquarium_id: aq.id,
    slots: [],
    expected_version: aq.version,
  })) as { status: string };
  expect(conflict.status).toBe('conflict');

  // 슬롯 캡(5) 초과 → slot_cap_exceeded
  const six = Array.from({ length: 6 }, (_, i) => ({
    slotId: `s${i}`,
    itemId: 'deco_rock_small',
    x: 0.5,
    y: 0.5,
    layer: i,
  }));
  const cap = (await rpcAs(user, 'save_slots', {
    aquarium_id: aq.id,
    slots: six,
    expected_version: ok.version,
  })) as { status: string };
  expect(cap.status).toBe('slot_cap_exceeded');

  // 타인 어항 → not_found_or_forbidden(42501) → HTTP 4xx throw
  const attacker = await createAnonUser();
  await expect(
    rpcAs(attacker, 'save_slots', {
      aquarium_id: aq.id,
      slots: [],
      expected_version: ok.version,
    }),
  ).rejects.toThrow();
});

test('grant-ad-reward: 일 한도(429) + nonce 재전송은 멱등 재반환 + RPC 직접 호출 차단', async () => {
  const user = await createAnonUser();
  const limit = AD_REWARD.dailyLimit.stamina; // 한도 SoT = game-spec

  let lastNonce = '';
  let lastStamina: number | undefined;
  for (let i = 1; i <= limit; i += 1) {
    lastNonce = `e2e-nonce-${Date.now()}-${i}`;
    const r = await edgeAs(user, 'grant-ad-reward', {
      kind: 'stamina',
      ssv: { nonce: lastNonce },
    });
    expect(r.status, `grant #${i} should succeed`).toBe(200);
    lastStamina = (r.json as { stamina?: number }).stamina;
  }

  // 한도 초과 — 429 daily_limit_reached
  const over = await edgeAs(user, 'grant-ad-reward', {
    kind: 'stamina',
    ssv: { nonce: `e2e-nonce-over-${Date.now()}` },
  });
  expect(over.status).toBe(429);

  // nonce 재전송 — 거부가 아니라 저장된 기존 결과를 그대로 재반환(멱등, 중복 지급 없음)
  const replay = await edgeAs(user, 'grant-ad-reward', {
    kind: 'stamina',
    ssv: { nonce: lastNonce },
  });
  expect(replay.status).toBe(200);
  const replayJson = replay.json as { idempotent?: boolean; stamina?: number };
  expect(replayJson.idempotent).toBe(true);
  expect(replayJson.stamina).toBe(lastStamina);

  // grant_ad_reward RPC는 service_role 전용 — 클라 직접 호출(=SSV 게이트 우회)은 거부돼야 한다
  await expect(
    rpcAs(user, 'grant_ad_reward', {
      target_user: user.userId,
      kind: 'stamina',
      nonce: `e2e-bypass-${Date.now()}`,
    }),
  ).rejects.toThrow();
});
