'use client';

/**
 * WalletBar — 전역 재화 표시(자기 행 SELECT only). 모든 페이지 상단에 노출.
 * 증감은 직접 하지 않는다(서버 RPC 결과를 재조회로 반영). GUARDRAILS §1, §9.
 *
 * 다른 페이지에서 RPC 후 재조회를 트리거하려면 window 이벤트 'aqua:wallet-refresh'를 dispatch.
 */

import { useCallback, useEffect, useState } from 'react';
import { loadWallet, type WalletView } from '../lib/supabase/queries';

export const WALLET_REFRESH_EVENT = 'aqua:wallet-refresh';

/** 다른 컴포넌트에서 호출해 WalletBar 재조회를 유발. */
export function requestWalletRefresh(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(WALLET_REFRESH_EVENT));
}

export function WalletBar() {
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [err, setErr] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setWallet(await loadWallet());
      setErr(false);
    } catch {
      setErr(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const handler = () => void refresh();
    window.addEventListener(WALLET_REFRESH_EVENT, handler);
    return () => window.removeEventListener(WALLET_REFRESH_EVENT, handler);
  }, [refresh]);

  return (
    <div
      style={{
        display: 'flex',
        gap: 14,
        flexWrap: 'wrap',
        padding: '8px 12px',
        marginBottom: 12,
        borderRadius: 8,
        background: '#0f1822',
        border: '1px solid #233040',
        fontSize: 13,
      }}
    >
      {err || !wallet ? (
        <span style={{ opacity: 0.6 }}>{err ? '재화 로드 실패 (로그인/DB 확인)' : '재화 불러오는 중…'}</span>
      ) : (
        <>
          <span>🪙 {wallet.coins.toLocaleString()}</span>
          <span>🦪 {wallet.pearls}</span>
          <span>⚡ {wallet.staminaDisplay}/{wallet.staminaCap}</span>
          <span>💗 {wallet.hearts}</span>
        </>
      )}
    </div>
  );
}
