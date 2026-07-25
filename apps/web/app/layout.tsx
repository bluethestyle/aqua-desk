/**
 * Root layout (App Router) — @aquadesk/web.
 *
 * 네이티브 WebView 모드(설계서/04 §1)에서는 safe-area inset을 존중해야 하므로
 * viewport에 viewport-fit=cover를 두고, 본문에 env(safe-area-inset-*) 패딩을 적용한다.
 * 모드 판별 헤더(x-aquadesk-native)는 middleware.ts가 부여한다.
 */

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Aqua Desk',
  description: '도트 수족관 라이브 배경 + 하이브리드 앱 — 수집·꾸미기·낚시·상점 (Cozy/Zen)',
};

export const viewport: Viewport = {
  // 네이티브 WebView safe-area 지원(설계서/04 §1).
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b1f3a',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          // safe-area inset (네이티브 WebView). 브라우저에서는 0으로 평가됨.
          paddingTop: 'env(safe-area-inset-top)',
          paddingRight: 'env(safe-area-inset-right)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          paddingLeft: 'env(safe-area-inset-left)',
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans KR", sans-serif',
          background: '#0b1f3a',
          color: '#e8f1ff',
        }}
      >
        {children}
      </body>
    </html>
  );
}
