'use client';

/**
 * Lobby (W1 수직 슬라이스) — 서버 권위 라운드트립 데모.
 *
 * 코어 루프 한 줄 관통(GUARDRAILS §1, §9):
 *  1) ensureSession() 익명 로그인 → 부트스트랩 트리거가 지갑·기본 어항·환영 물고기 생성.
 *  2) 자기 행 SELECT 로 어항/물고기 로드 → game-spec AquariumSnapshot 으로 표시(AquariumCanvas).
 *  3) 먹이/청소/오프라인적립은 **서버 RPC**(feed_fish/clean_aquarium/collect_offline) 경유.
 *     - 낙관적 UI: 즉시 화면만 갱신(표시용). 권위: RPC 성공 후 재조회(refresh).
 *     - version CAS conflict → refresh 후 1회 재시도(GUARDRAILS §1.5).
 *  ★직접 테이블 write 없음. 재화는 WalletBar(전역) 가 표시(자기 행 SELECT only).
 */

import { useCallback, useEffect, useState } from 'react';
import type { AquariumSnapshot } from '@aquadesk/game-spec';
import { PageShell } from '../../components/page-shell';
import { AquariumCanvas } from '../../components/aquarium-canvas';
import { requestWalletRefresh } from '../../components/wallet-bar';
import { loadLobby, type LobbyState } from '../../lib/supabase/aquarium';
import { cleanAquarium, collectOffline, feedFish, isConflict } from '../../lib/supabase/rpc';

export default function LobbyPage() {
  const [state, setState] = useState<LobbyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await loadLobby();
    setState(next);
    requestWalletRefresh();
    return next;
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const next = await loadLobby();
        if (alive) setState(next);
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

  /** 낙관적 변형 후 RPC 실행 → conflict면 refresh+1회 재시도 → 항상 권위 상태로 reconcile. */
  const runAction = useCallback(
    async (optimistic: (s: AquariumSnapshot) => AquariumSnapshot, rpc: () => Promise<unknown>) => {
      if (!state) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      setState({ ...state, snapshot: optimistic(state.snapshot) });
      try {
        try {
          await rpc();
        } catch (e) {
          if (isConflict(e)) {
            await refresh();
            await rpc();
          } else {
            throw e;
          }
        }
        await refresh();
      } catch (e) {
        setError(describe(e));
        await refresh().catch(() => undefined);
      } finally {
        setBusy(false);
      }
    },
    [state, refresh],
  );

  const onFeed = useCallback(() => {
    if (!state) return;
    const aquariumId = state.aquariumId;
    void runAction(
      (s) => ({ ...s, fish: s.fish.map((f) => ({ ...f, satisfied: true })) }),
      () => feedFish(aquariumId),
    );
  }, [state, runAction]);

  const onClean = useCallback(() => {
    if (!state) return;
    const aquariumId = state.aquariumId;
    void runAction(
      (s) => ({ ...s, waterQuality: 1, fish: s.fish.map((f) => ({ ...f, satisfied: true })) }),
      () => cleanAquarium(aquariumId),
    );
  }, [state, runAction]);

  const onCollect = useCallback(() => {
    if (!state || busy) return;
    const aquariumId = state.aquariumId;
    setBusy(true);
    setError(null);
    setNotice(null);
    (async () => {
      try {
        let coins: number;
        try {
          coins = await collectOffline(aquariumId);
        } catch (e) {
          if (!isConflict(e)) throw e;
          await refresh();
          coins = await collectOffline(aquariumId);
        }
        setNotice(`오프라인 적립 +${coins.toLocaleString()} 코인`);
        await refresh();
      } catch (e) {
        setError(describe(e));
        await refresh().catch(() => undefined);
      } finally {
        setBusy(false);
      }
    })();
  }, [state, busy, refresh]);

  return (
    <PageShell title="로비">
      {loading && <p>불러오는 중…</p>}
      {error && (
        <p style={{ color: '#ff8a8a' }}>
          오류: {error}
          {error.toLowerCase().includes('anonymous') && (
            <span style={{ opacity: 0.8 }}> (Supabase에서 Anonymous sign-ins 활성화 필요)</span>
          )}
        </p>
      )}
      {notice && <p style={{ color: '#8affb0' }}>{notice}</p>}

      {state && (
        <>
          <div style={{ marginBottom: 8, opacity: 0.85, fontSize: 14 }}>
            어항 #1 · 테마 {state.snapshot.themeId} · v{state.snapshot.version} · 수질{' '}
            {Math.round(state.snapshot.waterQuality * 100)}% · 물고기 {state.snapshot.fish.length}
          </div>
          <AquariumCanvas snapshot={state.snapshot} />
          <section style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <button type="button" onClick={onFeed} disabled={busy} style={btn}>
              먹이 (feed_fish)
            </button>
            <button type="button" onClick={onClean} disabled={busy} style={btn}>
              청소 (clean_aquarium)
            </button>
            <button type="button" onClick={onCollect} disabled={busy} style={btn}>
              오프라인 적립 (collect_offline)
            </button>
          </section>
        </>
      )}

      <p style={{ opacity: 0.6, marginTop: 16, fontSize: 13 }}>
        재화는 wallets SELECT-only. 모든 증감은 서버 RPC/Edge 경유(직접 write 금지). 낙관적 UI는
        표시용이며 권위는 RPC 결과(conflict → refresh 후 재시도).
      </p>
    </PageShell>
  );
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
