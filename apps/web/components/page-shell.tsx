/**
 * Minimal shared page shell (네비게이션 + 제목 + 서버권위 주석 배너).
 * 프로토타입 스텁 — 디자인은 추후. 모든 페이지가 공통 레이아웃을 쓰도록 한다.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { WalletBar } from './wallet-bar';

const NAV: Array<{ href: string; label: string }> = [
  { href: '/lobby', label: '로비' },
  { href: '/decorate', label: '꾸미기' },
  { href: '/shop', label: '상점' },
  { href: '/fishing', label: '낚시' },
  { href: '/dex', label: '도감' },
  { href: '/account', label: '계정' },
];

export function PageShell({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px' }}>
      <nav style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} style={{ color: '#7fd0ff', textDecoration: 'none' }}>
            {n.label}
          </Link>
        ))}
      </nav>
      <WalletBar />
      <h1 style={{ fontSize: 22, margin: '0 0 12px' }}>{title}</h1>
      {children}
    </main>
  );
}
