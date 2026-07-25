/**
 * window.AquaDesk bridge wrapper (GUARDRAILS §5; 설계서/02 §7, 04 §2.1).
 *
 * 웹 → 네이티브 호출을 안전하게 감싼다:
 *  - game-spec 타입 사용: applySnapshot/requestSnapshot은 AquariumSnapshot 계약을 따른다.
 *  - minBridgeVersion 협상: 네이티브 브리지가 요구 버전 미만이면 안전 폴백(기능 비활성/업데이트 유도).
 *  - 실패 콜백: 모든 호출은 BridgeError 기반 실패/에러 콜백을 받는다(미설치 브라우저 포함).
 *
 * R8 — 세션 단일화: refresh의 단일 주체는 네이티브. 웹은 resume 시 getAuthSession()으로
 * 네이티브 세션을 읽어 재사용하고, 독립 refresh를 하지 않는다(설계서/04 §2.1).
 *
 * NOTE(드리프트 방지): 브리지 타입(AquaDeskBridge/BridgeError/AuthSession)의 단일 진실원은
 * 설계서/02 §7이다. 현재 @aquadesk/game-spec은 스냅샷 타입만 export하므로, 브리지 인터페이스는
 * 여기서 02 §7 계약을 글자 그대로 미러링한다.
 * TODO: game-spec이 bridge 타입을 export하면 이 로컬 정의를 제거하고 import로 전환한다.
 */

import type { AquariumSnapshot } from '@aquadesk/game-spec';

/** 이 웹 빌드가 요구하는 최소 네이티브 브리지 버전. 미만이면 안전 폴백. */
export const WEB_REQUIRED_BRIDGE_VERSION = 1;

/** 공통 실패/에러 콜백 페이로드 (설계서/02 §7). */
export interface BridgeError {
  code: string;
  message: string;
}

/** 네이티브가 보관하는 인증 세션(refresh token 단일 주체는 네이티브, R8). */
export interface AuthSession {
  refreshToken: string;
  /** 선택: 네이티브가 함께 전달할 수 있는 access token / 만료(있으면 사용). */
  accessToken?: string;
  expiresAt?: number;
}

/**
 * window.AquaDesk — Web → Native 브리지 (설계서/02 §7).
 * 모든 호출은 minBridgeVersion 협상 + 실패 콜백(BridgeError)을 포함한다.
 */
export interface AquaDeskBridge {
  /** ★버전 협상(하위 미충족 시 폴백). */
  minBridgeVersion: number;

  applySnapshot(s: AquariumSnapshot): Promise<void>; // 즉시 반영(실패 콜백 포함)
  requestSnapshot(): Promise<AquariumSnapshot>; // 현재 캐시 조회
  previewWallpaper(): void; // 배경 설정 화면 유도(ACTION_CHANGE_LIVE_WALLPAPER)
  getAuthSession(): Promise<AuthSession | null>; // ★네이티브 세션 읽기(R8)
  setAuthSession(refreshToken: string): Promise<void>; // ★백그라운드 인증(R8)
  clearAuthSession(): void;
  setLowPower(on: boolean): void; // 셰이더 게이팅 토글
}

declare global {
  interface Window {
    AquaDesk?: AquaDeskBridge;
  }
}

/** 브리지가 주입되어 있는지(네이티브 WebView 모드인지) 판별. */
export function hasBridge(): boolean {
  return typeof window !== 'undefined' && !!window.AquaDesk;
}

/** 브리지 핸들 반환(없으면 null). 호출부는 폴백을 처리한다. */
export function getBridge(): AquaDeskBridge | null {
  if (typeof window === 'undefined') return null;
  return window.AquaDesk ?? null;
}

/**
 * minBridgeVersion 협상.
 * 네이티브 브리지의 minBridgeVersion이 웹 요구치 이상이어야 호환으로 간주한다.
 * (브리지가 선언한 minBridgeVersion = 네이티브가 보장하는 계약 버전)
 */
export function isBridgeCompatible(
  required: number = WEB_REQUIRED_BRIDGE_VERSION,
): boolean {
  const bridge = getBridge();
  if (!bridge) return false;
  return typeof bridge.minBridgeVersion === 'number' && bridge.minBridgeVersion >= required;
}

/**
 * 안전 호출 래퍼: 브리지 부재/버전 미충족/예외를 BridgeError로 정규화해 onError 콜백에 넘긴다.
 * 성공 시 결과를 반환, 실패 시 null을 반환한다(호출부는 폴백 UI를 띄운다).
 */
async function safeCall<T>(
  op: string,
  fn: (bridge: AquaDeskBridge) => T | Promise<T>,
  onError?: (e: BridgeError) => void,
): Promise<T | null> {
  const bridge = getBridge();
  if (!bridge) {
    onError?.({ code: 'NO_BRIDGE', message: `AquaDesk bridge unavailable for "${op}"` });
    return null;
  }
  if (!isBridgeCompatible()) {
    onError?.({
      code: 'VERSION_MISMATCH',
      message: `Native bridge v${bridge.minBridgeVersion} < required v${WEB_REQUIRED_BRIDGE_VERSION} for "${op}"`,
    });
    return null;
  }
  try {
    return await fn(bridge);
  } catch (err) {
    onError?.({
      code: 'BRIDGE_CALL_FAILED',
      message: err instanceof Error ? err.message : `Bridge call "${op}" failed`,
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed, version-negotiated, failure-safe wrappers (설계서/02 §7)
// ─────────────────────────────────────────────────────────────────────────────

export function applySnapshot(
  snapshot: AquariumSnapshot,
  onError?: (e: BridgeError) => void,
): Promise<void | null> {
  return safeCall('applySnapshot', (b) => b.applySnapshot(snapshot), onError);
}

export function requestSnapshot(
  onError?: (e: BridgeError) => void,
): Promise<AquariumSnapshot | null> {
  return safeCall('requestSnapshot', (b) => b.requestSnapshot(), onError);
}

export function previewWallpaper(onError?: (e: BridgeError) => void): Promise<void | null> {
  return safeCall('previewWallpaper', (b) => b.previewWallpaper(), onError);
}

/** R8: 네이티브 세션 읽기(웹 독립 refresh 금지). */
export function getAuthSession(
  onError?: (e: BridgeError) => void,
): Promise<AuthSession | null> {
  return safeCall('getAuthSession', (b) => b.getAuthSession(), onError).then(
    (v) => v ?? null,
  );
}

/** R8: 백그라운드 인증(네이티브가 단일 refresh 주체로 보관). */
export function setAuthSession(
  refreshToken: string,
  onError?: (e: BridgeError) => void,
): Promise<void | null> {
  return safeCall('setAuthSession', (b) => b.setAuthSession(refreshToken), onError);
}

export function clearAuthSession(onError?: (e: BridgeError) => void): Promise<void | null> {
  return safeCall('clearAuthSession', (b) => b.clearAuthSession(), onError);
}

export function setLowPower(
  on: boolean,
  onError?: (e: BridgeError) => void,
): Promise<void | null> {
  return safeCall('setLowPower', (b) => b.setLowPower(on), onError);
}
