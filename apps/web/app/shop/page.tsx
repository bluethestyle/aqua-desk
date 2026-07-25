'use client';

/**
 * Shop (W3 수직 슬라이스) — 카탈로그 + 구매 RPC + 보유 반영 (설계서/04 §6, GUARDRAILS §6, §9).
 *
 * 서버 권위(GUARDRAILS §1, §4.3, §10):
 *  1) 판매 품목은 items 카탈로그 public read(loadCatalogItems) — type in deco/food/theme.
 *  2) 인게임 재화(coin/pearl) 소비 구매는 **purchase_item RPC**(서버 원자 차감 + inventory upsert).
 *     - 직접 wallets/inventory write 금지(§10). 낙관적 UI 없음 — 재화는 권위 결과만 표시.
 *     - 성공 시 requestWalletRefresh()(전역 재화) + loadInventory 재조회로 보유 수량 반영.
 *     - version CAS / 조건부 차감 불일치(conflict) → refresh 후 1회 재시도(GUARDRAILS §1.5, 로비 패턴).
 *  3) 보유 수량은 inventory 자기 행 SELECT(loadInventory)로 함께 표시.
 *  4) 스토어 IAP(진주팩/스타터팩) 가격 사다리는 game-spec PEARL_PACKS/STARTER_PACK(SoT)에서 읽어
 *     "verify-receipt 경유(프로토 스텁)" 안내 섹션으로 노출(실제 결제는 네이티브 셸 + Edge).
 *
 * ★직접 권위 테이블 write 없음. 모든 증감은 RPC/Edge 경유.
 */

import { useCallback, useEffect, useState } from 'react';
import { PEARL_PACKS, STARTER_PACK } from '@aquadesk/game-spec';
import { PageShell } from '../../components/page-shell';
import { requestWalletRefresh } from '../../components/wallet-bar';
import {
  loadCatalogItems,
  loadInventory,
  type CatalogItem,
  type InventoryEntry,
} from '../../lib/supabase/queries';
import { isConflict, purchaseItem } from '../../lib/supabase/rpc';

const TYPE_LABEL: Record<CatalogItem['type'], string> = {
  deco: '장식',
  food: '먹이',
  theme: '테마',
};

const TYPE_EMOJI: Record<CatalogItem['type'], string> = {
  deco: '🪸',
  food: '🍤',
  theme: '🎨',
};

export default function ShopPage() {
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [inventory, setInventory] = useState<InventoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** 보유 수량 재조회(자기 행 SELECT) + 전역 재화 갱신. */
  const refreshInventory = useCallback(async () => {
    const inv = await loadInventory();
    setInventory(inv);
    requestWalletRefresh();
    return inv;
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // 카탈로그(public read) + 보유(자기 행)를 병렬 로드.
        const [catalog, inv] = await Promise.all([loadCatalogItems(), loadInventory()]);
        if (alive) {
          // 판매 품목만(type in deco/food/theme) — 인게임 재화 가격이 매겨진 것.
          setItems(
            catalog.filter((i) => i.type === 'deco' || i.type === 'food' || i.type === 'theme'),
          );
          setInventory(inv);
        }
      } catch (e) {
        if (alive) setError(describe(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 구매: 낙관적 UI 없음(재화는 권위 결과만). purchase_item RPC 가 서버에서 원자 차감 + inventory upsert.
   * conflict(version CAS/조건부 차감 불일치) → 보유 refresh 후 1회 재시도(GUARDRAILS §1.5, 로비 패턴).
   */
  const onBuy = useCallback(
    (item: CatalogItem) => {
      if (busyId) return;
      setBusyId(item.id);
      setError(null);
      setNotice(null);
      (async () => {
        try {
          try {
            await purchaseItem(item.id);
          } catch (e) {
            if (isConflict(e)) {
              await refreshInventory();
              await purchaseItem(item.id);
            } else {
              throw e;
            }
          }
          await refreshInventory();
          setNotice(`구매 완료: ${item.id} (서버 원자 차감 + 보유 반영)`);
        } catch (e) {
          setError(describe(e));
          // 권위 상태로 reconcile(잔액 부족/소유 중복 등은 서버가 거부 → 보유는 변하지 않음).
          await refreshInventory().catch(() => undefined);
        } finally {
          setBusyId(null);
        }
      })();
    },
    [busyId, refreshInventory],
  );

  const ownedQty = useCallback(
    (itemId: string): number => inventory.find((e) => e.itemId === itemId)?.qty ?? 0,
    [inventory],
  );

  return (
    <PageShell title="상점">
      {loading && <p>불러오는 중…</p>}
      {error && (
        <p style={{ color: '#ff8a8a' }}>
          오류: {error}
          {error.toLowerCase().includes('anonymous') && (
            <span style={{ opacity: 0.8 }}> (Supabase에서 Anonymous sign-ins 활성화 필요)</span>
          )}
          {error.includes('insufficient_funds') && (
            <span style={{ opacity: 0.8 }}> (코인/진주 잔액이 부족합니다)</span>
          )}
        </p>
      )}
      {notice && <p style={{ color: '#8affb0' }}>{notice}</p>}

      {items && (
        <section>
          <h2 style={{ fontSize: 16, margin: '4px 0 8px' }}>판매 품목 (purchase_item RPC)</h2>
          {items.length === 0 ? (
            <p style={{ opacity: 0.7, fontSize: 13 }}>
              판매 품목이 없습니다 (items 카탈로그 시드를 확인하세요).
            </p>
          ) : (
            <div style={grid}>
              {items.map((item) => {
                const owned = ownedQty(item.id);
                return (
                  <div key={item.id} style={card}>
                    <div style={{ fontSize: 28, lineHeight: 1 }}>{TYPE_EMOJI[item.type]}</div>
                    <div style={{ fontWeight: 600, marginTop: 6 }}>{item.id}</div>
                    <div style={{ opacity: 0.7, fontSize: 12 }}>
                      {TYPE_LABEL[item.type]}
                      {item.themeId ? ` · 테마 ${item.themeId}` : ''}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 13 }}>{priceLabel(item)}</div>
                    <div style={{ marginTop: 4, fontSize: 12, opacity: 0.8 }}>
                      보유: {owned.toLocaleString()}
                    </div>
                    <button
                      type="button"
                      onClick={() => onBuy(item)}
                      disabled={busyId !== null}
                      style={{ ...btn, marginTop: 8, opacity: busyId !== null ? 0.6 : 1 }}
                    >
                      {busyId === item.id ? '구매 중…' : '구매'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* 스토어 IAP 안내 — 가격 사다리는 game-spec(SoT). 실제 결제는 네이티브 셸 + verify-receipt Edge. */}
      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, margin: '4px 0 8px' }}>스토어 IAP (verify-receipt 경유)</h2>
        <p style={{ opacity: 0.7, fontSize: 13, margin: '0 0 10px' }}>
          진주팩/스타터팩은 실제 결제 상품입니다. 지급은 영수증 검증 Edge(verify-receipt)가
          purchases(platform, receipt) UNIQUE 멱등으로 처리합니다(GUARDRAILS §1.4, §6). 웹
          프로토타입에서는 결제 SDK가 없어 설계만 노출하는 스텁입니다(실 결제는 네이티브 셸 경유).
        </p>
        <div style={grid}>
          {PEARL_PACKS.map((pack) => (
            <div key={pack.productId} style={card}>
              <div style={{ fontSize: 28, lineHeight: 1 }}>🦪</div>
              <div style={{ fontWeight: 600, marginTop: 6 }}>진주 {pack.pearls}</div>
              <div style={{ opacity: 0.7, fontSize: 12 }}>
                {pack.productId}
                {pack.bonus > 0 ? ` · +${Math.round(pack.bonus * 100)}%` : ''}
              </div>
              <div style={{ marginTop: 6, fontSize: 13 }}>₩{pack.priceKrw.toLocaleString()}</div>
              <button type="button" disabled style={{ ...btn, marginTop: 8, opacity: 0.5 }}>
                구매 (스텁)
              </button>
            </div>
          ))}
          <div style={card}>
            <div style={{ fontSize: 28, lineHeight: 1 }}>🎁</div>
            <div style={{ fontWeight: 600, marginTop: 6 }}>스타터팩</div>
            <div style={{ opacity: 0.7, fontSize: 12 }}>
              {STARTER_PACK.productId} · 진주 {STARTER_PACK.pearls} + 한정 장식 + 코인 · 첫 구매 1회
            </div>
            <div style={{ marginTop: 6, fontSize: 13 }}>
              ₩{STARTER_PACK.priceKrw.toLocaleString()}
            </div>
            <button type="button" disabled style={{ ...btn, marginTop: 8, opacity: 0.5 }}>
              구매 (스텁)
            </button>
          </div>
        </div>
      </section>

      <p style={{ opacity: 0.6, marginTop: 20, fontSize: 13 }}>
        재화 차감/지급은 전부 서버(원자 차감). 인게임 구매는 purchase_item RPC, 스토어 결제는
        verify-receipt Edge 경유 — 직접 wallets/inventory write 금지(GUARDRAILS §10). 낙관적 UI
        없음(권위는 RPC 결과, conflict → refresh 후 재시도).
      </p>
    </PageShell>
  );
}

/** coin/pearl 가격 라벨(둘 다 null이면 가격 미정). */
function priceLabel(item: CatalogItem): string {
  const parts: string[] = [];
  if (item.priceCoin != null) parts.push(`🪙 ${item.priceCoin.toLocaleString()}`);
  if (item.pricePearl != null) parts.push(`🦪 ${item.pricePearl.toLocaleString()}`);
  return parts.length > 0 ? parts.join('  ·  ') : '가격 미정';
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return '알 수 없는 오류';
}

const btn: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid #3a4656',
  background: '#16202b',
  color: '#cfe8ff',
  cursor: 'pointer',
};

const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
  gap: 10,
};

const card: React.CSSProperties = {
  padding: 12,
  borderRadius: 10,
  border: '1px solid #233040',
  background: '#0f1822',
};
