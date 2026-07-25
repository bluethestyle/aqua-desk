// @ts-check

/**
 * Next.js config for @aquadesk/web (App Router).
 *
 * - `transpilePackages`: 모노레포 워크스페이스 패키지(@aquadesk/game-spec)를
 *   Next 빌드 파이프라인에서 트랜스파일한다(미리 빌드된 dist가 없어도 import 가능).
 * - reactStrictMode: 개발 중 부수효과 이중 호출로 잠재 버그 조기 발견.
 *
 * 서버 권위 원칙: 이 앱은 anon key(NEXT_PUBLIC_*)만 클라에 노출한다.
 * service role 키는 절대 NEXT_PUBLIC_ 프리픽스/번들에 포함하지 않는다(GUARDRAILS §7, §10).
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@aquadesk/game-spec'],
  // 네이티브 WebView(UA 'AquaDesk-Android') 감지 → safe-area/브리지 모드는 middleware.ts에서 처리.
};

export default nextConfig;
