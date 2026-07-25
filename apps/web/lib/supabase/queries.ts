'use client';

/**
 * 공유 읽기 쿼리 (자기 행 SELECT only / 카탈로그 public read) — 서버 권위(GUARDRAILS §1, §9).
 * 페이지들이 일관된 로더를 쓰도록 모은다. 쓰기는 전부 lib/supabase/rpc.ts 경유(직접 write 금지).
 */

import type { BodyType, Rarity } from '@aquadesk/game-spec';
import { regenStamina, STAMINA } from '@aquadesk/game-spec';
import { getSupabaseClient } from './client';
import { ensureSession } from './session';
import type { WalletView } from './aquarium';

export type { WalletView } from './aquarium';

/** 지갑 1행(자기 행) + lazy-regen 표시용 스태미나. */
export async function loadWallet(now: number = Date.now()): Promise<WalletView> {
  await ensureSession();
  const supabase = getSupabaseClient();

  const [walletRes, profileRes] = await Promise.all([
    supabase.from('wallets').select('coins, pearls, hearts, stamina, stamina_updated_at').single(),
    supabase.from('profiles').select('aqua_pass_until').single(),
  ]);
  if (walletRes.error) throw walletRes.error;
  if (profileRes.error) throw profileRes.error;

  const w = walletRes.data;
  const hasPass =
    !!profileRes.data?.aqua_pass_until &&
    new Date(profileRes.data.aqua_pass_until).getTime() > now;
  const staminaCap = STAMINA.baseCap + (hasPass ? STAMINA.passBonus : 0);

  return {
    coins: Number(w.coins),
    pearls: Number(w.pearls),
    hearts: Number(w.hearts),
    staminaDisplay: regenStamina(Number(w.stamina), new Date(w.stamina_updated_at).getTime(), now, hasPass),
    staminaCap,
  };
}

// ── 카탈로그 (public read) ────────────────────────────────────────────────
export interface CatalogItem {
  id: string;
  type: 'deco' | 'food' | 'theme';
  priceCoin: number | null;
  pricePearl: number | null;
  assetKey: string;
  themeId: string | null;
}

export async function loadCatalogItems(): Promise<CatalogItem[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('items')
    .select('id, type, price_coin, price_pearl, asset_key, theme_id')
    .order('id', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    type: r.type as CatalogItem['type'],
    priceCoin: r.price_coin == null ? null : Number(r.price_coin),
    pricePearl: r.price_pearl == null ? null : Number(r.price_pearl),
    assetKey: String(r.asset_key),
    themeId: (r.theme_id as string | null) ?? null,
  }));
}

// ── 인벤토리 (자기 행) ────────────────────────────────────────────────────
export interface InventoryEntry {
  itemId: string;
  qty: number;
  item: CatalogItem | null;
}

export async function loadInventory(): Promise<InventoryEntry[]> {
  await ensureSession();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('inventory')
    .select('item_id, qty, items(id, type, price_coin, price_pearl, asset_key, theme_id)');
  if (error) throw error;
  return (data ?? []).map((r: Record<string, unknown>) => {
    const raw = Array.isArray(r.items) ? r.items[0] : r.items;
    const it = raw as Record<string, unknown> | null;
    return {
      itemId: String(r.item_id),
      qty: Number(r.qty),
      item: it
        ? {
            id: String(it.id),
            type: it.type as CatalogItem['type'],
            priceCoin: it.price_coin == null ? null : Number(it.price_coin),
            pricePearl: it.price_pearl == null ? null : Number(it.price_pearl),
            assetKey: String(it.asset_key),
            themeId: (it.theme_id as string | null) ?? null,
          }
        : null,
    };
  });
}

// ── 도감 (카탈로그 + 자기 보유) ───────────────────────────────────────────
export interface SpeciesEntry {
  id: string;
  rarity: Rarity;
  bodyType: BodyType;
  isHero: boolean;
  themeId: string | null;
}

export interface DexView {
  species: SpeciesEntry[];
  caught: Record<string, { count: number }>;
  caughtCount: number;
  total: number;
  /** 0..1 도감 완성도. */
  completion: number;
}

export async function loadDex(): Promise<DexView> {
  await ensureSession();
  const supabase = getSupabaseClient();
  const [speciesRes, dexRes] = await Promise.all([
    supabase.from('fish_species').select('id, rarity, body_type, is_hero, theme_id').order('id'),
    supabase.from('dex_entries').select('species_id, count'),
  ]);
  if (speciesRes.error) throw speciesRes.error;
  if (dexRes.error) throw dexRes.error;

  const species: SpeciesEntry[] = (speciesRes.data ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    rarity: r.rarity as Rarity,
    bodyType: r.body_type as BodyType,
    isHero: Boolean(r.is_hero),
    themeId: (r.theme_id as string | null) ?? null,
  }));

  const caught: Record<string, { count: number }> = {};
  for (const r of (dexRes.data ?? []) as Array<Record<string, unknown>>) {
    caught[String(r.species_id)] = { count: Number(r.count) };
  }

  const caughtCount = species.filter((s) => caught[s.id]).length;
  const total = species.length;
  return { species, caught, caughtCount, total, completion: total > 0 ? caughtCount / total : 0 };
}
