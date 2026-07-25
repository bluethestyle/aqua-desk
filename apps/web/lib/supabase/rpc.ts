/**
 * Server-authority RPC wrappers (GUARDRAILS §1, §4, §9; 설계서/02 §4, 04 §5).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 직접 테이블 WRITE 금지.                                                      │
 * │  - 클라에서 wallets/inventory/dex_entries/fish_instances/purchases/gifts/   │
 * │    fishing_sessions 를 INSERT/UPDATE 하지 않는다 (GUARDRAILS §10).          │
 * │  - 모든 상태 변경은 SECURITY DEFINER RPC 또는 service-role Edge Function     │
 * │    경유다. 클라는 자기 행 SELECT만.                                          │
 * │  - 낙관적 UI는 표시용일 뿐, 권위는 항상 서버 RPC 결과다 (GUARDRAILS §1.4).    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 동시성(version CAS, GUARDRAILS §1.5): 상태변경 RPC는 서버에서
 * `UPDATE ... WHERE id=? AND version=?` 로 수행되고, 불일치 시 `conflict`를 반환한다.
 *  → 호출부는 conflict 응답을 받으면 스냅샷을 refresh한 뒤 재시도해야 한다(아래 isConflict 참고).
 *
 * 멱등키(GUARDRAILS §1.4): 낚시 = fishing_sessions.id, 결제 = purchases(platform,receipt).
 *
 * 함수 이름은 GUARDRAILS §4.3 / 설계서 §4·§5 시그니처를 글자 그대로 따른다(드리프트 금지).
 *  - Postgres RPC(snake_case): supabase.rpc('feed_fish', ...) 등
 *  - Edge Function(kebab-case, URL): supabase.functions.invoke('fishing-resolve', ...) 등
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from './client';

/** 서버 version CAS 불일치 시그널. RPC가 이 문자열을 반환/throw하면 클라는 refresh 후 재시도. */
export const CONFLICT = 'conflict' as const;

/** 호출부에서 conflict 판별용 헬퍼 (메시지 또는 반환값 검사). */
export function isConflict(value: unknown): boolean {
  if (value === CONFLICT) return true;
  if (value && typeof value === 'object') {
    const msg = (value as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.toLowerCase().includes(CONFLICT)) return true;
  }
  if (value instanceof Error && value.message.toLowerCase().includes(CONFLICT)) return true;
  return false;
}

function client(db?: SupabaseClient): SupabaseClient {
  return db ?? getSupabaseClient();
}

/**
 * jsonb 반환 RPC의 status 계약 검사(0004_functions.sql).
 * 서버는 거부를 SQL 에러가 아니라 { status: 'insufficient_funds' | 'theme_not_owned' |
 * 'self_gift_blocked' | 'rate_limited' | 'conflict' | ... } 로 반환한다.
 * 'ok'가 아니면 전부 throw — 삼키면 클라가 가짜 성공을 표시하게 된다(서버 권위 위반 표시).
 */
function expectOkStatus<T extends { status?: string }>(data: unknown): T {
  const res = (data ?? {}) as T;
  if (res.status === CONFLICT) throw new Error(CONFLICT);
  if (res.status !== 'ok') throw new Error(res.status ?? 'rpc_failed');
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// Postgres RPC (SECURITY DEFINER) — snake_case (GUARDRAILS §3, §4.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * start_fishing(spot_id text) → uuid (session_id).
 * lazy 스태미나 재생 → -1 → fishing_sessions insert. 스태미나 부족 시 서버가 거부.
 * 반환된 session_id가 멱등/중복지급 방지 키다(설계서/04 §4).
 */
export async function startFishing(spotId: string, db?: SupabaseClient): Promise<string> {
  const { data, error } = await client(db).rpc('start_fishing', { spot_id: spotId });
  if (error) throw error;
  return data as string;
}

/**
 * feed_fish(aquarium_id uuid). hunger↑ + version CAS (보호 컬럼 → 서버가 GUC 설정).
 * 위젯/알림/앱 모두 이 RPC 경유(토큰 필요). 직접 fish_instances/aquariums write 금지.
 * conflict 반환 시 스냅샷 refresh 후 재시도.
 */
export async function feedFish(aquariumId: string, db?: SupabaseClient): Promise<number> {
  const { data, error } = await client(db).rpc('feed_fish', { aquarium_id: aquariumId });
  if (error) throw error;
  // RPC가 에러가 아닌 {status:'conflict'} jsonb로 version CAS 불일치를 알린다 → throw로 통일.
  const res = expectOkStatus<{ status?: string; version?: number }>(data);
  return Number(res.version);
}

/**
 * clean_aquarium(aquarium_id uuid). water_quality=1 + version CAS.
 * conflict 반환 시 스냅샷 refresh 후 재시도.
 */
export async function cleanAquarium(aquariumId: string, db?: SupabaseClient): Promise<number> {
  const { data, error } = await client(db).rpc('clean_aquarium', { aquarium_id: aquariumId });
  if (error) throw error;
  const res = expectOkStatus<{ status?: string; version?: number }>(data);
  return Number(res.version);
}

/**
 * collect_offline(aquarium_id uuid) → bigint (적립된 코인).
 * last_collected_at·aqua_pass_until 기준 캡(6h/패스 24h) + coin_rate_bonus 반영.
 */
export async function collectOffline(aquariumId: string, db?: SupabaseClient): Promise<number> {
  const { data, error } = await client(db).rpc('collect_offline', { aquarium_id: aquariumId });
  if (error) throw error;
  const coins = Number(data);
  // 서버는 version CAS 불일치 시 -1을 반환한다(0004 collect_offline) → conflict로 통일.
  if (coins < 0) throw new Error(CONFLICT);
  return coins;
}

/**
 * purchase_item(item_id text). 가격(coin/pearl) 원자 차감 + inventory upsert.
 * 직접 wallets/inventory write 금지(GUARDRAILS §10).
 */
export async function purchaseItem(itemId: string, db?: SupabaseClient): Promise<void> {
  const { data, error } = await client(db).rpc('purchase_item', { item_id: itemId });
  if (error) throw error;
  // 서버 거부(insufficient_funds 등)는 jsonb status로 온다 — 삼키면 가짜 '구매 완료'가 된다.
  expectOkStatus(data);
}

/**
 * set_aquarium_theme(aquarium_id uuid, theme_id text). 소유/프리미엄 검증 후 theme_id 변경.
 * theme_id는 보호 컬럼이라 클라 직접 UPDATE 금지 — 반드시 이 RPC.
 */
export async function setAquariumTheme(
  aquariumId: string,
  themeId: string,
  db?: SupabaseClient,
): Promise<void> {
  const { data, error } = await client(db).rpc('set_aquarium_theme', {
    aquarium_id: aquariumId,
    theme_id: themeId,
  });
  if (error) throw error;
  // theme_not_owned / conflict 모두 status 로 온다 — ok 외 전부 throw.
  expectOkStatus(data);
}

/**
 * save_slots(aquarium_id uuid, slots jsonb, expected_version int) → {status, version}.
 * 꾸미기 슬롯 저장 + version CAS(GUARDRAILS §1.5) — 직접 UPDATE 대신 이 RPC 사용(§4.1).
 * conflict 반환 시 스냅샷 refresh 후 새 version으로 재시도. 반환 = 새 version.
 */
export async function saveSlots(
  aquariumId: string,
  slots: ReadonlyArray<Record<string, unknown>>,
  expectedVersion: number,
  db?: SupabaseClient,
): Promise<number> {
  const { data, error } = await client(db).rpc('save_slots', {
    aquarium_id: aquariumId,
    slots,
    expected_version: expectedVersion,
  });
  if (error) throw error;
  const res = expectOkStatus<{ status?: string; version?: number }>(data);
  return Number(res.version);
}

/**
 * issue_share_token(aquarium_idx int) → text. 16자+ 불투명 토큰만 반환.
 * URL/응답에 user_id 노출 금지(GUARDRAILS §1.3) — 공유는 토큰만.
 */
export async function issueShareToken(aquariumIdx: number, db?: SupabaseClient): Promise<string> {
  const { data, error } = await client(db).rpc('issue_share_token', { aquarium_idx: aquariumIdx });
  if (error) throw error;
  return data as string;
}

/**
 * get_shared_aquarium(token text) → jsonb (read-only 스냅샷).
 * user_id는 절대 반환되지 않는다. 공유 뷰어(aquarium/[token]) 전용.
 * 반환 jsonb는 AquariumSnapshot 형태(게임 스펙 계약)지만 RPC가 jsonb로 주므로 unknown으로 받는다.
 */
export async function getSharedAquarium(token: string, db?: SupabaseClient): Promise<unknown> {
  const { data, error } = await client(db).rpc('get_shared_aquarium', { token });
  if (error) throw error;
  return data;
}

/**
 * send_heart(to_token text). 토큰→user 해석, 자기선물 차단, 일 5회 레이트리밋. — P1
 */
export async function sendHeart(toToken: string, db?: SupabaseClient): Promise<void> {
  const { data, error } = await client(db).rpc('send_heart', { to_token: toToken });
  if (error) throw error;
  // invalid_token / self_gift_blocked / rate_limited 도 status 로 온다 — ok 외 전부 throw.
  expectOkStatus(data);
}

/**
 * claim_gifts() → int (적립된 hearts 수). 100 hearts → 1000 coins 자동 환산. — P1
 */
export async function claimGifts(db?: SupabaseClient): Promise<number> {
  const { data, error } = await client(db).rpc('claim_gifts');
  if (error) throw error;
  return Number(data);
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge Functions (Deno, service role) — kebab-case URL (GUARDRAILS §3, §4.3)
//   service-role 키는 Edge 환경변수 전용. 클라는 invoke만 하고 키를 보유하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * fishing-resolve (session_id uuid, skill jsonb).
 * 서버가 '무엇을 잡았나'만 결정하고 '잡았나/못 잡았나'는 뒤집지 않는다(설계서/04 §4 불변 규칙).
 * 멱등: 이미 consumed면 서버가 기존 reward를 그대로 반환 → 결과 복원(지연/단절 대비 재호출 안전).
 *
 * skill: { castPerfect: boolean; timeInZone: number }  (설계서/04 §3)
 */
export async function fishingResolve(
  sessionId: string,
  skill: { castPerfect: boolean; timeInZone: number },
  db?: SupabaseClient,
): Promise<unknown> {
  const { data, error } = await client(db).functions.invoke('fishing-resolve', {
    body: { session_id: sessionId, skill },
  });
  if (error) throw error;
  return data;
}

/**
 * daily-shop-roll (). date+user seed로 6슬롯 결정(클라 조작 불가). 구매는 purchaseItem 경유.
 */
export async function dailyShopRoll(db?: SupabaseClient): Promise<unknown> {
  const { data, error } = await client(db).functions.invoke('daily-shop-roll', { body: {} });
  if (error) throw error;
  return data;
}

/**
 * verify-receipt (platform text, receipt text). 영수증 검증 + purchases UNIQUE 멱등 지급.
 * 멱등키 = purchases(platform, receipt). — 프로토에서는 설계만(스텁 호출).
 */
export async function verifyReceipt(
  platform: 'play' | 'appstore',
  receipt: string,
  db?: SupabaseClient,
): Promise<unknown> {
  const { data, error } = await client(db).functions.invoke('verify-receipt', {
    body: { platform, receipt },
  });
  if (error) throw error;
  return data;
}

/**
 * grant-ad-reward (kind text). 광고 보상 서버 지급, 일 횟수 제한, SSV. — P1
 * kind: 'stamina' | 'offline_x2' | 'shop_refresh' (설계서/04 §5.1)
 * SSV nonce: 프로토 스텁 — 실제 광고 SDK 연동 시 광고 네트워크 콜백 서명으로 교체.
 */
export async function grantAdReward(
  kind: 'stamina' | 'offline_x2' | 'shop_refresh',
  db?: SupabaseClient,
): Promise<{ ok: boolean; granted: boolean; stamina?: number }> {
  const nonce =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const { data, error } = await client(db).functions.invoke('grant-ad-reward', {
    body: { kind, ssv: { nonce } },
  });
  if (error) throw error;
  const res = data as { ok?: boolean; granted?: boolean; stamina?: number } | null;
  if (!res?.ok) throw new Error('ad_reward_failed');
  return { ok: true, granted: res.granted === true, stamina: res.stamina };
}
