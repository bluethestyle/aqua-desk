/**
 * Playwright E2E — OS별 디바이스 프로파일 (설계서/04: 하이브리드 웹뷰 대상 화면).
 *  - android: Pixel 7 (Chromium)  — Android WebView 근사
 *  - ios:     iPhone 14 (WebKit)  — iOS WKWebView 근사
 *  - desktop: Desktop Chrome
 * hosted Supabase(.env.local)에 실제로 붙어 서버 권위 왕복까지 검증한다.
 * 각 테스트는 새 브라우저 컨텍스트 = 새 익명 유저(부트스트랩 트리거 경유)로 격리된다.
 */
import { defineConfig, devices } from '@playwright/test';
import './e2e/env'; // .env.local 로드 (테스트 헬퍼가 REST 직접 호출에 사용)

/**
 * E2E_BASE_URL 지정 시 배포본(예: Vercel 프로덕션)을 대상으로 실행한다.
 *   PowerShell: $env:E2E_BASE_URL='https://aqua-desk-web.vercel.app'; npm run test:e2e -w apps/web
 * 미지정이면 로컬 dev 서버(자동 기동/재사용) 대상.
 */
const EXTERNAL_BASE_URL = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  reporter: [['line'], ['html', { open: 'never' }]],
  use: {
    baseURL: EXTERNAL_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'android', use: { ...devices['Pixel 7'] } },
    { name: 'ios', use: { ...devices['iPhone 14'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
  // 배포본 대상(E2E_BASE_URL)일 땐 로컬 dev 서버를 띄우지 않는다.
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:3000/lobby',
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
