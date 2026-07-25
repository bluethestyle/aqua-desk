'use client';

/**
 * Lobby 상태 로더 (W1) — 자기 행 SELECT만(서버 권위, GUARDRAILS §1, §9).
 *
 *  - 재화: `wallets` 자기 행 SELECT.
 *  - 어항/물고기: `aquariums`(idx=1) + `fish_instances`(+`fish_species.body_type`) SELECT.
 *  - DB 행 → game-spec `AquariumSnapshot` 으로 변환(타입 SoT = @aquadesk/game-spec).
 *  - 표시용 스태미나는 game-spec `regenStamina()` 로 lazy 재생 반영(권위 아님, 표시용).
 *
 * 직접 테이블 WRITE 없음 — 모든 증감은 lib/supabase/rpc.ts 의 RPC/Edge 경유.
 */

import type {
  AquariumSnapshot,
  BodyType,
  DayNight,
  FishSnapshot,
  Nature,
  SlotPlacement,
} from '@aquadesk/game-spec';
import { regenStamina, STAMINA } from '@aquadesk/game-spec';
import { getSupabaseClient } from './client';
import { ensureSession } from './session';

export interface WalletView {
  coins: number;
  pearls: number;
  hearts: number;
  /** lazy-regen 반영 표시용 스태미나(서버 권위 아님). */
  staminaDisplay: number;
  staminaCap: number;
}

export interface LobbyState {
  aquariumId: string;
  hasPass: boolean;
  wallet: WalletView;
  snapshot: AquariumSnapshot;
}

/** to-one 임베드가 객체/배열 어느 쪽으로 와도 body_type을 안전하게 뽑는다. */
function readBodyType(embedded: unknown): BodyType {
  const row = Array.isArray(embedded) ? embedded[0] : embedded;
  const bt = (row as { body_type?: string } | null | undefined)?.body_type;
  return (bt ?? 'fusiform') as BodyType;
}

/**
 * 로비 상태를 로드한다(세션 보장 → 자기 행 SELECT → 스냅샷 변환).
 * @param now 표시용 스태미나/패스 계산 기준 시각(테스트 주입 가능). 기본 Date.now().
 */
export async function loadLobby(now: number = Date.now()): Promise<LobbyState> {
  await ensureSession();
  const supabase = getSupabaseClient();

  const [walletRes, profileRes, aquariumRes] = await Promise.all([
    supabase
      .from('wallets')
      .select('coins, pearls, hearts, stamina, stamina_updated_at')
      .single(),
    supabase.from('profiles').select('aqua_pass_until, settings').single(),
    supabase
      .from('aquariums')
      .select('id, theme_id, water_quality, version, slots')
      .eq('idx', 1)
      .single(),
  ]);

  if (walletRes.error) throw walletRes.error;
  if (profileRes.error) throw profileRes.error;
  if (aquariumRes.error) throw aquariumRes.error;

  const wallet = walletRes.data;
  const profile = profileRes.data;
  const aq = aquariumRes.data;

  const fishRes = await supabase
    .from('fish_instances')
    .select(
      'id, species_id, nickname, nature, growth_stage, hunger, size_pct, fish_species(body_type)',
    )
    .eq('aquarium_id', aq.id)
    .order('born_at', { ascending: true });
  if (fishRes.error) throw fishRes.error;

  const hasPass =
    !!profile?.aqua_pass_until && new Date(profile.aqua_pass_until).getTime() > now;
  const staminaCap = STAMINA.baseCap + (hasPass ? STAMINA.passBonus : 0);
  const staminaDisplay = regenStamina(
    Number(wallet.stamina),
    new Date(wallet.stamina_updated_at).getTime(),
    now,
    hasPass,
  );

  const fish: FishSnapshot[] = (fishRes.data ?? []).map((r: Record<string, unknown>, i: number) => ({
    id: String(r.id),
    speciesId: String(r.species_id),
    bodyType: readBodyType(r.fish_species),
    nickname: (r.nickname as string | null) ?? undefined,
    nature: r.nature as Nature,
    growthStage: Number(r.growth_stage),
    sizePct: Number(r.size_pct),
    // satisfied 파생(hunger==0 또는 수질 저하 ⇒ false) — 설계서/02 §6.
    satisfied: Number(r.hunger) > 0 && Number(aq.water_quality) > 0.3,
    // x/y는 초기 배치 힌트(런타임 위치 권위는 네이티브 FSM). 데모용 분산 배치.
    x: 0.15 + (i % 5) * 0.17,
    y: 0.3 + ((i * 0.137) % 0.5),
  }));

  const dayNight = ((profile?.settings as { dayNight?: string } | null)?.dayNight ??
    'auto') as DayNight;

  const snapshot: AquariumSnapshot = {
    version: Number(aq.version),
    themeId: String(aq.theme_id),
    dayNight,
    waterQuality: Number(aq.water_quality),
    slots: ((aq.slots as SlotPlacement[] | null) ?? []),
    fish,
    pendingAnims: [],
  };

  return {
    aquariumId: String(aq.id),
    hasPass,
    wallet: {
      coins: Number(wallet.coins),
      pearls: Number(wallet.pearls),
      hearts: Number(wallet.hearts),
      staminaDisplay,
      staminaCap,
    },
    snapshot,
  };
}
