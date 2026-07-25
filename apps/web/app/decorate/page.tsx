'use client';

/**
 * Decorate (W2 수직 슬라이스) — 슬롯 배치 → DB upsert (설계서/04 §1, 05 §1).
 *
 * 서버 권위(GUARDRAILS §1, §4.1, §9):
 *  - 어항/스냅샷(slots): loadLobby() 자기 행 SELECT. 보유 장식: loadInventory() 자기 행 SELECT.
 *  - slots는 aquariums에서 클라가 직접 UPDATE 가능한 **유일한** 컬럼이다(RLS aquariums_update_slots).
 *      → from('aquariums').update({ slots }).eq('id', aquariumId)  (★예외적 owner-write 허용)
 *      → theme_id/water_quality/version/rating/last_collected_at 은 보호 컬럼이라 절대 포함하지 않는다
 *        (포함해도 guard 트리거가 복원/거부). 테마 변경은 set_aquarium_theme RPC 경유.
 *  - 인벤토리/지갑 등 권위 테이블은 직접 write 하지 않는다(테마는 RPC, 구매는 상점의 purchase_item).
 *
 * UI/정합 패턴(로비 page.tsx 재사용):
 *  - loading / error / notice 상태, 낙관적 UI(즉시 미리보기) + 저장 후 loadLobby 재조회로 reconcile.
 *  - slots 저장도 version CAS 정합을 따른다: 저장 실패(conflict 등) → 스냅샷 refresh 후 1회 재시도.
 *  - theme 변경(set_aquarium_theme)도 conflict → refresh 후 재시도(보호 컬럼 RPC 시연).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SlotPlacement } from '@aquadesk/game-spec';
import { SLOTS } from '@aquadesk/game-spec';
import { PageShell } from '../../components/page-shell';
import { AquariumCanvas } from '../../components/aquarium-canvas';
import { requestWalletRefresh } from '../../components/wallet-bar';
import { loadLobby, type LobbyState } from '../../lib/supabase/aquarium';
import { loadInventory, type InventoryEntry } from '../../lib/supabase/queries';
import { getSupabaseClient } from '../../lib/supabase/client';
import { isConflict, setAquariumTheme } from '../../lib/supabase/rpc';

/** 테마 변경 시연용 — 카탈로그(themes) 시드와 정합(설계서 seed.sql). */
const THEME_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'deepsea', label: 'Deep Sea(기본)' },
  { id: 'cyberpunk', label: 'Cyberpunk' },
  { id: 'emerald', label: 'Emerald' },
];

/** 새 장식 배치 시 기본 좌표(0..1) — 중앙 약간 위, 단순 스텁. */
const DEFAULT_X = 0.5;
const DEFAULT_Y = 0.6;

export default function DecoratePage() {
  const [state, setState] = useState<LobbyState | null>(null);
  const [inventory, setInventory] = useState<InventoryEntry[]>([]);
  /** 편집 중 슬롯(권위 아님, 저장 전 로컬 드래프트). 저장 성공 시 서버 재조회로 reconcile. */
  const [slots, setSlots] = useState<SlotPlacement[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** 보유 장식만(type='deco') — 슬롯에 배치 가능한 대상. */
  const decoEntries = useMemo(
    () => inventory.filter((e) => e.item?.type === 'deco' && e.qty > 0),
    [inventory],
  );

  /** 서버 권위 상태 + 보유 장식 재조회. slots 드래프트도 서버 값으로 reconcile. */
  const refresh = useCallback(async () => {
    const [lobby, inv] = await Promise.all([loadLobby(), loadInventory()]);
    setState(lobby);
    setInventory(inv);
    setSlots(lobby.snapshot.slots);
    requestWalletRefresh();
    return lobby;
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [lobby, inv] = await Promise.all([loadLobby(), loadInventory()]);
        if (!alive) return;
        setState(lobby);
        setInventory(inv);
        setSlots(lobby.snapshot.slots);
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

  /** 편집 중 slots 를 즉시 반영한 미리보기 스냅샷(낙관적 표시용). */
  const previewSnapshot = useMemo(
    () => (state ? { ...state.snapshot, slots } : null),
    [state, slots],
  );

  const placedCount = slots.length;
  const slotCap = SLOTS.startCount; // 시작 슬롯 5칸(경제 상수, GUARDRAILS §6)
  const dirty = useMemo(
    () => (state ? !slotsEqual(slots, state.snapshot.slots) : false),
    [state, slots],
  );

  // ── 슬롯 드래프트 편집(로컬, 저장 전엔 권위 아님) ──────────────────────────
  const addSlot = useCallback(
    (itemId: string) => {
      setNotice(null);
      setError(null);
      setSlots((prev) => {
        if (prev.length >= slotCap) {
          setError(`슬롯이 가득 찼습니다(최대 ${slotCap}칸).`);
          return prev;
        }
        const next: SlotPlacement = {
          slotId: makeSlotId(),
          itemId,
          x: DEFAULT_X,
          y: DEFAULT_Y,
          layer: prev.length,
        };
        return [...prev, next];
      });
    },
    [slotCap],
  );

  const removeSlot = useCallback((slotId: string) => {
    setNotice(null);
    setError(null);
    setSlots((prev) => prev.filter((s) => s.slotId !== slotId));
  }, []);

  const updateCoord = useCallback((slotId: string, axis: 'x' | 'y', value: number) => {
    const v = clamp01(value);
    setSlots((prev) => prev.map((s) => (s.slotId === slotId ? { ...s, [axis]: v } : s)));
  }, []);

  const resetDraft = useCallback(() => {
    setNotice(null);
    setError(null);
    if (state) setSlots(state.snapshot.slots);
  }, [state]);

  // ── 저장: slots 만 직접 UPDATE(★예외 허용). 실패 시 refresh 후 1회 재시도. ──
  const saveSlots = useCallback(async () => {
    if (!state || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const aquariumId = state.aquariumId;
    const supabase = getSupabaseClient();

    // slots만 보낸다. theme_id/version 등 보호 컬럼은 절대 포함 금지(guard 트리거 복원/거부).
    const writeSlots = (): Promise<{ error: unknown }> =>
      supabase.from('aquariums').update({ slots }).eq('id', aquariumId) as unknown as Promise<{
        error: unknown;
      }>;

    try {
      let res = await writeSlots();
      if (res.error) {
        // RLS 거부/정합 실패 → 스냅샷 refresh 후 1회 재시도(GUARDRAILS §1.5, §9).
        if (isConflict(res.error)) {
          await refresh();
          res = await writeSlots();
        }
        if (res.error) throw res.error;
      }
      // 저장 후 서버 권위로 재조회(slots 드래프트도 reconcile).
      await refresh();
      setNotice('슬롯 배치를 저장했습니다.');
    } catch (e) {
      setError(describe(e));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [state, busy, slots, refresh]);

  // ── 테마 변경(보호 컬럼 → set_aquarium_theme RPC 시연). conflict → refresh 후 재시도. ──
  const changeTheme = useCallback(
    async (themeId: string) => {
      if (!state || busy) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      const aquariumId = state.aquariumId;
      // 낙관적 UI(표시용): 테마 즉시 반영. 권위는 RPC 결과 → 재조회.
      setState({ ...state, snapshot: { ...state.snapshot, themeId } });
      try {
        try {
          await setAquariumTheme(aquariumId, themeId);
        } catch (e) {
          if (isConflict(e)) {
            await refresh();
            await setAquariumTheme(aquariumId, themeId);
          } else {
            throw e;
          }
        }
        await refresh();
        setNotice(`테마를 ${themeId}(으)로 변경했습니다.`);
      } catch (e) {
        setError(describe(e));
        await refresh().catch(() => undefined);
      } finally {
        setBusy(false);
      }
    },
    [state, busy, refresh],
  );

  return (
    <PageShell title="꾸미기">
      {loading && <p>불러오는 중…</p>}
      {error && (
        <p style={{ color: '#ff8a8a' }}>
          오류: {error}
          {error.includes('theme_not_owned') && (
            <span style={{ opacity: 0.8 }}> (프리미엄 테마는 상점에서 스킨 구매 후 적용할 수 있어요)</span>
          )}
        </p>
      )}
      {notice && <p style={{ color: '#8affb0' }}>{notice}</p>}

      {state && previewSnapshot && (
        <>
          <div style={{ marginBottom: 8, opacity: 0.85, fontSize: 14 }}>
            어항 #1 · 테마 {state.snapshot.themeId} · v{state.snapshot.version} · 배치{' '}
            {placedCount}/{slotCap}
            {dirty && <span style={{ color: '#ffd27f' }}> · 저장되지 않은 변경</span>}
          </div>

          {/* 미리보기: 편집 중 slots 를 즉시 반영(낙관적 표시). 권위는 저장 후 재조회. */}
          <AquariumCanvas snapshot={previewSnapshot} />

          {/* 인벤토리(보유 장식) → 슬롯에 배치 */}
          <section style={card}>
            <h2 style={h2}>보유 장식 (인벤토리)</h2>
            {decoEntries.length === 0 ? (
              <p style={{ opacity: 0.7, fontSize: 13 }}>
                보유한 장식이 없습니다. 상점에서 장식을 구매하세요(purchase_item).
              </p>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {decoEntries.map((e) => (
                  <button
                    key={e.itemId}
                    type="button"
                    onClick={() => addSlot(e.itemId)}
                    disabled={busy || placedCount >= slotCap}
                    style={btn}
                    title={e.item?.assetKey ?? e.itemId}
                  >
                    🪸 {e.itemId} ×{e.qty}
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* 배치된 슬롯: 좌표(0..1) 편집 / 제거 */}
          <section style={card}>
            <h2 style={h2}>배치된 슬롯</h2>
            {slots.length === 0 ? (
              <p style={{ opacity: 0.7, fontSize: 13 }}>
                배치된 장식이 없습니다. 위에서 장식을 눌러 배치하세요.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                {slots.map((s) => (
                  <li
                    key={s.slotId}
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      padding: 8,
                      borderRadius: 8,
                      background: '#0f1822',
                      border: '1px solid #233040',
                    }}
                  >
                    <span style={{ minWidth: 120, fontSize: 13 }}>🪸 {s.itemId}</span>
                    <label style={lbl}>
                      x
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={s.x}
                        disabled={busy}
                        onChange={(ev) => updateCoord(s.slotId, 'x', Number(ev.target.value))}
                      />
                      <span style={coord}>{s.x.toFixed(2)}</span>
                    </label>
                    <label style={lbl}>
                      y
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={s.y}
                        disabled={busy}
                        onChange={(ev) => updateCoord(s.slotId, 'y', Number(ev.target.value))}
                      />
                      <span style={coord}>{s.y.toFixed(2)}</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => removeSlot(s.slotId)}
                      disabled={busy}
                      style={{ ...btn, marginLeft: 'auto' }}
                    >
                      제거
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => void saveSlots()} disabled={busy || !dirty} style={btn}>
                저장 (aquariums.slots UPDATE)
              </button>
              <button type="button" onClick={resetDraft} disabled={busy || !dirty} style={btn}>
                되돌리기
              </button>
            </div>
          </section>

          {/* 테마 변경(보호 컬럼) — set_aquarium_theme RPC 시연 */}
          <section style={card}>
            <h2 style={h2}>테마 변경 (set_aquarium_theme RPC)</h2>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {THEME_CHOICES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => void changeTheme(t.id)}
                  disabled={busy || state.snapshot.themeId === t.id}
                  style={btn}
                >
                  {t.label}
                  {state.snapshot.themeId === t.id ? ' ✓' : ''}
                </button>
              ))}
            </div>
            <p style={{ opacity: 0.6, marginTop: 8, fontSize: 12 }}>
              theme_id 는 보호 컬럼이라 직접 update 금지 — 소유/프리미엄 검증을 거치는 RPC 경유입니다.
            </p>
          </section>
        </>
      )}

      <p style={{ opacity: 0.6, marginTop: 16, fontSize: 13 }}>
        slots 만 클라 owner-write 허용(RLS aquariums_update_slots). theme_id 등 보호 컬럼은 RPC
        경유(직접 write 금지). 낙관적 UI는 표시용이며 권위는 저장 후 재조회 결과(conflict → refresh
        후 재시도).
      </p>
    </PageShell>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function makeSlotId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `slot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 드래프트와 서버 slots 가 동일한지(dirty 판정용). */
function slotsEqual(a: SlotPlacement[], b: SlotPlacement[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (
      x.slotId !== y.slotId ||
      x.itemId !== y.itemId ||
      x.x !== y.x ||
      x.y !== y.y ||
      x.layer !== y.layer
    ) {
      return false;
    }
  }
  return true;
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

const card: React.CSSProperties = {
  marginTop: 16,
  padding: 12,
  borderRadius: 12,
  background: '#0c151d',
  border: '1px solid #1d2a37',
};

const h2: React.CSSProperties = {
  fontSize: 15,
  margin: '0 0 10px',
  opacity: 0.9,
};

const lbl: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 13,
};

const coord: React.CSSProperties = {
  minWidth: 34,
  textAlign: 'right',
  opacity: 0.8,
  fontVariantNumeric: 'tabular-nums',
};
