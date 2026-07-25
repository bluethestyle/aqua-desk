'use client';

/**
 * Shared aquarium viewer (B5/W5, P1) — read-only (설계서/04 §5 공유 보안 R6; GUARDRAILS §1.3, §10).
 *
 * 보안 불변(GUARDRAILS §1.3, §10):
 *  - URL/경로에는 **불투명 share_token만** 노출한다. user_id는 절대 노출/반환하지 않으며 표시도 않는다.
 *  - share_tokens는 클라 직접 SELECT/INSERT가 모두 거부(정책 없음)다. 접근은 RPC 전용:
 *    get_shared_aquarium(token) → read-only 스냅샷(user_id 미반환).
 *  - 이 라우트는 read-only 뷰어다. 먹이/청소 등 자기 어항 상태변경은 제공하지 않는다.
 *  - 유일한 사회적 액션 "하트 보내기"는 send_heart(to_token) RPC 경유다(자기선물 차단/일 5회
 *    레이트리밋은 전적으로 서버 권위, GUARDRAILS §1, §4.3). 직접 gifts 테이블 write 금지(§10).
 *
 * 동작:
 *  1) 'use client' + props { params: { token } } 로 토큰 수신.
 *  2) getSharedAquarium(token) → jsonb { status:'ok', version, themeId, dayNight, waterQuality,
 *     slots, fish[], pendingAnims } 또는 { status:'not_found' }.
 *  3) status==='ok'면 game-spec AquariumSnapshot 으로 구성 → AquariumCanvas 로 read-only 렌더.
 *     status==='not_found'(또는 무효 토큰)면 "수족관을 찾을 수 없음" 안내.
 *  4) 하트 보내기 버튼: sendHeart(token). 성공 후 requestWalletRefresh()(상대 hearts는 자기 행
 *     아니라 안 보이지만, 일관성 위해 전역 재화 재조회 트리거).
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  AquariumSnapshot,
  BodyType,
  DayNight,
  FishSnapshot,
  Nature,
  PendingAnim,
  SlotPlacement,
} from '@aquadesk/game-spec';
import { PageShell } from '../../../components/page-shell';
import { AquariumCanvas } from '../../../components/aquarium-canvas';
import { requestWalletRefresh } from '../../../components/wallet-bar';
import { getSharedAquarium, sendHeart } from '../../../lib/supabase/rpc';

/** 페이지 로드 결과: 정상 스냅샷 / 미존재(무효·만료 토큰). */
type ViewerState =
  | { kind: 'ok'; snapshot: AquariumSnapshot }
  | { kind: 'not_found' };

export default function SharedAquariumPage({
  params,
}: {
  params: { token: string };
}) {
  const { token } = params;

  const [state, setState] = useState<ViewerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 하트 보내기 상태(소셜 액션은 서버 권위; 낙관 표시는 버튼 라벨 정도로만).
  const [heartBusy, setHeartBusy] = useState(false);
  const [heartNotice, setHeartNotice] = useState<string | null>(null);
  const [heartError, setHeartError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const raw = await getSharedAquarium(token);
        if (!alive) return;
        setState(parseViewer(raw));
      } catch (e) {
        if (alive) setError(describe(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  const onSendHeart = useCallback(() => {
    if (heartBusy) return;
    setHeartBusy(true);
    setHeartError(null);
    setHeartNotice(null);
    (async () => {
      try {
        // send_heart(to_token): 자기선물 차단 + 일 5회 레이트리밋은 전적으로 서버 판정.
        await sendHeart(token);
        setHeartNotice('하트를 보냈어요 💗');
        // 보낸 쪽 재화엔 변화가 없지만, 향후 비용/카운트 변동 대비 전역 재화 재조회 트리거.
        requestWalletRefresh();
      } catch (e) {
        setHeartError(describe(e));
      } finally {
        setHeartBusy(false);
      }
    })();
  }, [token, heartBusy]);

  return (
    <PageShell title="공유 어항 (읽기 전용)">
      <p style={{ opacity: 0.75, fontSize: 13, margin: '0 0 12px' }}>
        불투명 토큰으로만 접근하는 소셜 뷰어입니다. 소유자 정보(user_id)는 노출되지 않습니다
        (get_shared_aquarium 전용).
      </p>

      {loading && <p>불러오는 중…</p>}

      {error && (
        <p style={{ color: '#ff8a8a' }}>
          오류: {error}
          {error.toLowerCase().includes('anonymous') && (
            <span style={{ opacity: 0.8 }}> (Supabase에서 Anonymous sign-ins 활성화 필요)</span>
          )}
        </p>
      )}

      {!loading && !error && state?.kind === 'not_found' && (
        <p style={{ color: '#ffcf8a' }}>
          수족관을 찾을 수 없음 — 토큰이 잘못되었거나 만료되었어요.
        </p>
      )}

      {state?.kind === 'ok' && (
        <>
          <div style={{ marginBottom: 8, opacity: 0.85, fontSize: 14 }}>
            테마 {state.snapshot.themeId} · v{state.snapshot.version} · 수질{' '}
            {Math.round(state.snapshot.waterQuality * 100)}% · 물고기 {state.snapshot.fish.length}
          </div>
          <AquariumCanvas snapshot={state.snapshot} />

          <section style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <button type="button" onClick={onSendHeart} disabled={heartBusy} style={btn}>
              {heartBusy ? '보내는 중…' : '하트 보내기 💗 (send_heart)'}
            </button>
          </section>

          {heartNotice && (
            <p style={{ color: '#8affb0', marginTop: 8 }}>{heartNotice}</p>
          )}
          {heartError && (
            <p style={{ color: '#ff8a8a', marginTop: 8 }}>
              하트를 보내지 못했어요: {heartError}
              <span style={{ opacity: 0.8 }}> (자기 어항이거나 오늘 한도 초과일 수 있어요.)</span>
            </p>
          )}

          <p style={{ opacity: 0.6, marginTop: 16, fontSize: 13 }}>
            토큰을 가진 사람만 볼 수 있는 소셜 공유입니다. 읽기 전용이라 먹이·청소 등 상태변경은
            불가하며, 하트는 서버(send_heart)가 자기선물 차단·일일 한도를 판정합니다.
          </p>
        </>
      )}
    </PageShell>
  );
}

/**
 * get_shared_aquarium 반환 jsonb(unknown) → ViewerState.
 * 서버 계약: { status:'ok', version, themeId, dayNight, waterQuality, slots, fish[], pendingAnims }
 *            또는 { status:'not_found' }. user_id는 계약상 부재(접근/표시 금지).
 * supabase 미타입이라 입력은 unknown — 여기서 명시 타입으로 안전 변환한다(TS strict).
 */
function parseViewer(raw: unknown): ViewerState {
  const obj = (raw ?? {}) as Record<string, unknown>;
  if (obj.status !== 'ok') return { kind: 'not_found' };

  const snapshot: AquariumSnapshot = {
    version: num(obj.version),
    themeId: str(obj.themeId, 'deepsea'),
    dayNight: parseDayNight(obj.dayNight),
    waterQuality: num(obj.waterQuality, 1),
    slots: parseSlots(obj.slots),
    fish: parseFish(obj.fish),
    pendingAnims: parsePendingAnims(obj.pendingAnims),
  };
  return { kind: 'ok', snapshot };
}

function parseSlots(raw: unknown): SlotPlacement[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    return {
      slotId: str(o.slotId, `slot-${i}`),
      itemId: str(o.itemId, ''),
      x: num(o.x),
      y: num(o.y),
      layer: num(o.layer),
    };
  });
}

function parseFish(raw: unknown): FishSnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((f, i) => {
    const o = (f ?? {}) as Record<string, unknown>;
    return {
      id: str(o.id, `fish-${i}`),
      speciesId: str(o.speciesId, ''),
      bodyType: parseBodyType(o.bodyType),
      nickname: typeof o.nickname === 'string' ? o.nickname : undefined,
      nature: parseNature(o.nature),
      growthStage: num(o.growthStage, 1),
      sizePct: num(o.sizePct),
      satisfied: o.satisfied !== false,
      x: num(o.x, 0.15 + (i % 5) * 0.17),
      y: num(o.y, 0.3 + ((i * 0.137) % 0.5)),
    };
  });
}

function parsePendingAnims(raw: unknown): PendingAnim[] {
  if (!Array.isArray(raw)) return [];
  const kinds: ReadonlyArray<PendingAnim['kind']> = ['feed-drop', 'clean', 'heart'];
  return raw.flatMap((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const kind = kinds.find((k) => k === o.kind);
    if (!kind) return [];
    return [{ kind, at: num(o.at), payload: o.payload }];
  });
}

const BODY_TYPES: ReadonlyArray<BodyType> = ['fusiform', 'disc', 'eel'];
function parseBodyType(v: unknown): BodyType {
  return BODY_TYPES.find((b) => b === v) ?? 'fusiform';
}

const NATURES: ReadonlyArray<Nature> = ['timid', 'gluttonous', 'curious', 'lone'];
function parseNature(v: unknown): Nature {
  return NATURES.find((n) => n === v) ?? 'curious';
}

const DAY_NIGHTS: ReadonlyArray<DayNight> = ['auto', 'day', 'night'];
function parseDayNight(v: unknown): DayNight {
  return DAY_NIGHTS.find((d) => d === v) ?? 'auto';
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
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
