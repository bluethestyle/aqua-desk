/**
 * Supabase browser client (anon key, RLS-enforced).
 *
 * 서버 권위 원칙(GUARDRAILS §1, §7):
 *  - 클라이언트는 **anon key**만 사용한다. service role 키는 절대 클라 번들/로그에 노출하지 않는다.
 *  - env는 NEXT_PUBLIC_* (빌드 시 클라 번들에 인라인됨을 전제)만 허용.
 *  - 이 클라이언트로는 **자기 행 SELECT만** 한다. 경제·수집·결제·토큰 테이블의 쓰기는
 *    전부 RPC/Edge Function 경유다(lib/supabase/rpc.ts). 직접 테이블 write 금지.
 *
 * R8 — 세션 단일화: 토큰 refresh의 단일 주체는 네이티브다(설계서/04 §2.1).
 *  - 네이티브 WebView 모드에서는 웹이 독립적으로 refresh하지 않고, 브리지
 *    getAuthSession()으로 네이티브 세션을 읽어 재사용한다(lib/bridge/index.ts).
 *  - 따라서 네이티브 모드에서는 autoRefreshToken/persistSession을 끄는 것이 원칙이나,
 *    웹 단독 실행(브라우저)에서는 기본 동작이 필요하므로 호출부에서 모드를 판별해 주입한다.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Singleton browser Supabase client.
 * Use `getSupabaseClient()` so we create a single instance per browser context.
 *
 * env 검증은 모듈 import 시점이 아니라 **클라이언트 최초 생성 시점**에 한다.
 * (빌드/정적 분석 단계에서 env 부재로 import 자체가 실패하지 않도록.)
 */
let browserClient: SupabaseClient | null = null;

/**
 * 네이티브 WebView 모드 감지(R8) — UA 토큰 'AquaDesk-Android'(설계서/03 §8).
 * 브리지 주입(window.AquaDesk)보다 UA가 먼저 확정되므로 클라 생성 시점 판별은 UA 기준.
 */
export function isNativeMode(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('AquaDesk-Android');
}

export function getSupabaseClient(): SupabaseClient {
  if (browserClient) return browserClient;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    // 누락을 호출 시점에 드러낸다. (값이 없으면 RLS 보호 데이터 접근 불가)
    // service role 키를 대체로 쓰지 않는다 — anon key가 단일 클라 자격이다.
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
        'Copy .env.local.example to .env.local and fill anon credentials.',
    );
  }

  browserClient = createClient(supabaseUrl, supabaseAnonKey, {
    // ★스키마 격리(배포 변형): 모든 from()/rpc()는 aquadesk 스키마를 대상으로 한다.
    //   대시보드 Settings → API → Exposed schemas 에 'aquadesk' 추가 필요.
    db: { schema: 'aquadesk' },
    auth: {
      // R8 세션 단일화(설계서/03 §6.1, A5): 네이티브 모드에서는 refresh의 단일 주체가
      // 네이티브(SyncWorker/TokenRefresher)다.
      //  - autoRefreshToken:false 만으로는 부족하다 — supabase-js는 getSession()/모든 RPC 전에
      //    access 만료 시 저장된 refresh로 lazy refresh를 수행한다. 따라서 persistSession도 꺼서
      //    웹이 '낡은 refresh token을 보관·사용하는' 경로 자체를 제거한다(메모리 세션만).
      //  - 콜드스타트 승계/위탁은 lib/supabase/native-session.ts + native-session-sync.tsx가
      //    브리지(getAuthSession/setAuthSession)로 수행하며, 만료 전 access만 주입한다.
      persistSession: !isNativeMode(),
      autoRefreshToken: !isNativeMode(),
      detectSessionInUrl: true,
    },
    // 미타입 클라이언트라 db.schema 제네릭('aquadesk')만 달라진다 → 기본 SupabaseClient로 캐스트
    // (런타임 스키마는 위 db.schema 옵션이 그대로 적용됨).
  }) as unknown as SupabaseClient;
  return browserClient;
}

/** Convenience default export for ergonomic imports in client components. */
export const supabase = getSupabaseClient;
