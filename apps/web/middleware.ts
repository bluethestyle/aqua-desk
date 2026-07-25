/**
 * Edge middleware — 네이티브 WebView 감지 (설계서/04 §1, §2.1; GUARDRAILS §9).
 *
 * UA에 'AquaDesk-Android'가 있으면 네이티브 셸(WebView) 안에서 실행 중이다.
 *  → 다운스트림(레이아웃/페이지)이 safe-area CSS + 브리지 활성화 + R8 세션 단일화를
 *    적용할 수 있도록 응답에 'x-aquadesk-native' 헤더를 부여한다.
 *
 * 서버 권위/보안: 여기서는 라우팅 힌트만 부여한다. 인증·경제 판단은 하지 않는다(서버 RPC 권위).
 */

import { NextResponse, type NextRequest } from 'next/server';

/** 네이티브 WebView UA 토큰(설계서/04 §1). */
const NATIVE_UA_TOKEN = 'AquaDesk-Android';

export function middleware(request: NextRequest): NextResponse {
  const userAgent = request.headers.get('user-agent') ?? '';
  const isNative = userAgent.includes(NATIVE_UA_TOKEN);

  const response = NextResponse.next();
  // 다운스트림에서 모드 판별(safe-area / 브리지 / R8 세션 읽기 활성화)에 사용.
  response.headers.set('x-aquadesk-native', isNative ? '1' : '0');
  return response;
}

export const config = {
  // 정적 자원·이미지·Next 내부 경로는 제외하고 페이지 라우트에만 적용.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sprites|.*\\.).*)'],
};
