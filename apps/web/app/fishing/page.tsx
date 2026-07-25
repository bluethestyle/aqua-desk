'use client';

/**
 * Fishing (W4) — 낚시 미니게임 + 낙관적 연출 + 서버 멱등 정합 (설계서/04 §3·§4; 05 §1).
 *
 * FSM의 SoT는 @aquadesk/game-spec(fishing-fsm.ts). 여기서는 그 순수 전이를
 * fishingTransition()으로 그대로 구동하고, UI는 최소 동작 스텁(디자인 추후)이다.
 *
 *   casting ──cast(perfect?)──▶ waiting ──bite/tap──▶ reeling ──reel_success──▶ resolving ──resolved──▶ result
 *      └ cast_fail ───────────▶ fail   └ bite_timeout ▶ fail   └ zone_exit ───▶ fail ──to_result──▶ result(빈손)
 *
 * 흐름(설계서/04 §3·§4):
 *   0) 진입: start_fishing('home') → session_id 확보. 스태미나 -1 게이트 — 부족 시 서버 거부 → "스태미나 부족".
 *   1) 캐스팅: 타이밍 게이지로 castPerfect(boolean) 산출(중앙 Perfect 존이면 perfect).
 *   2) 입질 대기 → 탭(데모: 즉시 입질 표시 후 탭). 미탭 timeout 은 fail.
 *   3) 릴링: 슬라이더로 timeInZone(0..1) 산출(≥0.9 → Perfect Catch).
 *   4) 결과: fishing-resolve(session_id, {castPerfect, timeInZone}) → 보상(species/size/rarity) 표시.
 *      fail 전이면 resolve 미호출 빈손 result.
 *
 * 불변 규칙(설계서/04 §4): 서버는 "무엇을 잡았나"만 결정하고 "잡았나/못 잡았나"는 절대 뒤집지 않는다.
 *   - 보상 쓰기(fish_instances/dex_entries)는 전부 fishing-resolve Edge(service role). 클라는 결과 표시만.
 *   - 멱등키 = fishing_sessions.id. 응답 지연/단절 시 동일 session_id로 재호출해도 서버가 기존 reward를
 *     그대로 반환(중복 지급/물고기 증발 없음) — 아래 withResyncRetry가 스피너 유지 중 1회 재동기화.
 *   - 성공 후 requestWalletRefresh()로 전역 재화(스태미나 등) 재조회. 권위는 항상 서버 SELECT.
 *
 * ★직접 권위 테이블 write 없음(GUARDRAILS §1·§9·§10). 모든 증감은 RPC/Edge 경유.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  FISHING_INITIAL_STATE,
  FISHING_SKILL,
  fishingTransition,
  isPerfectCatch,
  type FishingSkill,
  type FishingState,
} from '@aquadesk/game-spec';
import { PageShell } from '../../components/page-shell';
import { requestWalletRefresh } from '../../components/wallet-bar';
import { fishingResolve, startFishing } from '../../lib/supabase/rpc';

/** 낚시터(설계서/04). 프로토는 홈 어항 풀('home') 고정. */
const SPOT_ID = 'home';

/** 연출 종료 후 resolve 응답 미도착 시 멱등 재동기화 타임아웃(ms) — 튜닝 대상. */
const RESOLVE_TIMEOUT_MS = 8000;

/** 캐스팅 게이지가 중앙(0.5)에서 이 반경 이내면 Perfect cast(데모용 판정). */
const CAST_PERFECT_RADIUS = 0.08;

/** fishing-resolve가 돌려주는 보상 행(설계서/04 §4 / Edge 계약). user_id 미포함. */
interface FishingReward {
  id: string;
  aquariumId: string;
  speciesId: string;
  /** 신선 성공 시에만 존재(멱등 재호출은 fish_instances 행이라 rarity 없음). */
  rarity?: string;
  nature: string;
  growthStage: number;
  sizePct: number;
}

/** Edge 응답: { idempotent, reward } — reward는 snake_case jsonb(미타입). */
interface ResolveResponse {
  idempotent?: boolean;
  reward?: Record<string, unknown> | null;
}

export default function FishingPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [fsm, setFsm] = useState<FishingState>(FISHING_INITIAL_STATE);

  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staminaBlocked, setStaminaBlocked] = useState(false);

  // 캐스팅 게이지(0..1) / 릴링 time-in-zone(0..1) — 데모 인터랙션 입력.
  const [castGauge, setCastGauge] = useState(0.5);
  const [timeInZone, setTimeInZone] = useState(0.5);

  // 누적 스킬(캐스팅 결과를 reeling resolve까지 보존).
  const [castPerfect, setCastPerfect] = useState(false);

  const [reward, setReward] = useState<FishingReward | null>(null);
  const [emptyHanded, setEmptyHanded] = useState(false);

  const inProgress = sessionId !== null && fsm !== 'result';

  /** FSM 전이 헬퍼 — game-spec 순수 전이를 그대로 적용(무효 이벤트는 동일 상태로 무시됨). */
  const advance = useCallback(
    (event: Parameters<typeof fishingTransition>[1]) =>
      setFsm((prev) => fishingTransition(prev, event)),
    [],
  );

  /** 0) 진입: 스태미나 게이트 + 세션 선점. 부족/에러 시 진입 차단. */
  const begin = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStaminaBlocked(false);
    setReward(null);
    setEmptyHanded(false);
    setCastPerfect(false);
    try {
      // start_fishing: lazy 스태미나 재생 → -1 → fishing_sessions insert. 부족 시 서버 거부.
      const id = await startFishing(SPOT_ID);
      setSessionId(id);
      setFsm(FISHING_INITIAL_STATE); // 'casting'
      // 진입 직후 스태미나가 1 줄었으니 전역 재화 갱신(표시용).
      requestWalletRefresh();
    } catch (e) {
      // 스태미나 부족은 서버가 거부 메시지로 알린다(설계서/04 §4). 휴리스틱 판별.
      if (isStaminaShortage(e)) setStaminaBlocked(true);
      else setError(describe(e));
    } finally {
      setBusy(false);
    }
  }, []);

  /** 1) 캐스팅: 게이지 → castPerfect 산출 후 waiting 또는 fail. */
  const onCast = useCallback(() => {
    if (fsm !== 'casting') return;
    const perfect = Math.abs(castGauge - 0.5) <= CAST_PERFECT_RADIUS;
    setCastPerfect(perfect);
    // 데모: 캐스팅 자체는 (타이밍과 무관히) 성공 전이. 'cast_fail'은 별도 버튼으로 시연.
    advance({ type: 'cast', perfect });
  }, [fsm, castGauge, advance]);

  /** 1') 캐스팅 실패 전이(시연용): casting → fail. */
  const onCastFail = useCallback(() => {
    if (fsm !== 'casting') return;
    setCastPerfect(false);
    advance({ type: 'cast_fail' });
  }, [fsm, advance]);

  /** 2) 입질: waiting → reeling. */
  const onBite = useCallback(() => {
    if (fsm !== 'waiting') return;
    advance({ type: 'bite' });
  }, [fsm, advance]);

  /** 2') 입질 timeout(시연용): waiting → fail (1.0s 내 미탭). */
  const onBiteTimeout = useCallback(() => {
    if (fsm !== 'waiting') return;
    advance({ type: 'bite_timeout' });
  }, [fsm, advance]);

  /** 3') 릴링 그린존 이탈(시연용): reeling → fail. */
  const onZoneExit = useCallback(() => {
    if (fsm !== 'reeling') return;
    advance({ type: 'zone_exit' });
  }, [fsm, advance]);

  /** fail → result 합류: resolve를 호출하지 않는 빈손 result. 스태미나는 반환하지 않음(설계 다이얼). */
  const finishEmptyHanded = useCallback(() => {
    setEmptyHanded(true);
    setReward(null);
    advance({ type: 'to_result' });
  }, [advance]);

  /**
   * 3) 릴링 성공 → 4) 결과: reeling → resolving 전이 후 fishing-resolve 호출.
   * 멱등: 응답 지연/단절 시 동일 session_id로 재호출해도 서버가 기존 reward를 그대로 반환.
   */
  const onReelSuccess = useCallback(async () => {
    if (fsm !== 'reeling' || !sessionId) return;
    advance({ type: 'reel_success' }); // → 'resolving'
    setResolving(true);
    setError(null);
    const skill: FishingSkill = { castPerfect, timeInZone };
    try {
      // 보상 쓰기는 전부 서버(fishing-resolve Edge). 클라는 결과 표시만.
      const raw = (await withResyncRetry(() => fishingResolve(sessionId, skill))) as ResolveResponse;
      const r = raw?.reward ?? null;
      if (r) {
        setReward(normalizeReward(r));
        setEmptyHanded(false);
      } else {
        // consumed인데 reward 없음 = 빈손 세션(멱등 보존). 빈손 result로 표시.
        setReward(null);
        setEmptyHanded(true);
      }
      advance({ type: 'resolved' }); // → 'result'
      // 보상은 서버가 fish_instances/dex/wallets에 기록 → 클라는 재조회(SELECT)만.
      requestWalletRefresh();
    } catch (e) {
      setError(describe(e));
      // 에러 시 resolving에 머무름 — 동일 session_id로 재시도 가능(멱등).
    } finally {
      setResolving(false);
    }
  }, [fsm, sessionId, castPerfect, timeInZone, advance]);

  /** 결과 닫고 새 라운드 준비(다시 begin 필요 — 새 세션/스태미나). */
  const resetRound = useCallback(() => {
    setSessionId(null);
    setFsm(FISHING_INITIAL_STATE);
    setReward(null);
    setEmptyHanded(false);
    setError(null);
    setStaminaBlocked(false);
    setCastPerfect(false);
    setCastGauge(0.5);
    setTimeInZone(0.5);
  }, []);

  const perfectCatch = useMemo(
    () => isPerfectCatch({ castPerfect, timeInZone }),
    [castPerfect, timeInZone],
  );

  return (
    <PageShell title="낚시">
      <p style={{ opacity: 0.85, fontSize: 14, marginTop: 0 }}>
        낚시 미니게임 (W4). game-spec FSM 구동 · 보상은 전부 서버(fishing-resolve) · 멱등키 = session_id.
      </p>

      {error && <p style={{ color: '#ff8a8a' }}>오류: {error}</p>}

      {/* 진입 전 / 스태미나 게이트 */}
      {!sessionId && (
        <section style={card}>
          <p style={{ margin: '0 0 8px' }}>
            상태: <strong>대기</strong> · 1회당 스태미나 −1 (재생 +1/30분)
          </p>
          {staminaBlocked && (
            <p style={{ color: '#ffd28a', margin: '0 0 8px' }}>
              스태미나 부족 — 잠시 후 다시 시도하세요(상단 ⚡ 확인).
            </p>
          )}
          <button type="button" onClick={() => void begin()} disabled={busy} style={btnPrimary}>
            {busy ? '입수 중…' : '낚시 시작 (start_fishing · 스태미나 −1)'}
          </button>
        </section>
      )}

      {/* 진행 중: FSM 단계별 인터랙션 */}
      {sessionId && fsm !== 'result' && (
        <section style={card}>
          <div style={{ marginBottom: 10, fontSize: 13, opacity: 0.85 }}>
            session_id: <code>{shortId(sessionId)}</code> · 단계: <strong>{stageLabel(fsm)}</strong>
            {castPerfect && fsm !== 'casting' && <span style={{ color: '#8affb0' }}> · Perfect 캐스팅</span>}
          </div>

          {/* 1) 캐스팅 */}
          {fsm === 'casting' && (
            <div>
              <label style={lbl}>
                캐스팅 타이밍 게이지 (중앙 0.50 ±{CAST_PERFECT_RADIUS} = Perfect): {castGauge.toFixed(2)}
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={castGauge}
                onChange={(e) => setCastGauge(Number(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button type="button" onClick={onCast} style={btnPrimary}>
                  캐스팅 (→ 입질 대기)
                </button>
                <button type="button" onClick={onCastFail} style={btn}>
                  캐스팅 실패(시연) — fail
                </button>
              </div>
            </div>
          )}

          {/* 2) 입질 대기 */}
          {fsm === 'waiting' && (
            <div>
              <p style={{ margin: '0 0 10px' }}>입질! &quot;!&quot; — 1.0s 내에 탭하세요.</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={onBite} style={btnPrimary}>
                  탭! (→ 릴링)
                </button>
                <button type="button" onClick={onBiteTimeout} style={btn}>
                  미탭 timeout(시연) — fail
                </button>
              </div>
            </div>
          )}

          {/* 3) 릴링 */}
          {fsm === 'reeling' && (
            <div>
              <label style={lbl}>
                릴링 time-in-zone (≥{FISHING_SKILL.perfectCatchTimeInZone} → Perfect Catch · 상위 크기):{' '}
                {timeInZone.toFixed(2)}
                {perfectCatch && <span style={{ color: '#8affb0' }}> · Perfect Catch</span>}
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={timeInZone}
                onChange={(e) => setTimeInZone(Number(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => void onReelSuccess()} disabled={resolving} style={btnPrimary}>
                  릴링 성공 (→ fishing-resolve)
                </button>
                <button type="button" onClick={onZoneExit} disabled={resolving} style={btn}>
                  그린존 이탈(시연) — fail
                </button>
              </div>
            </div>
          )}

          {/* resolving: 서버 응답 대기 스피너 */}
          {fsm === 'resolving' && (
            <div>
              <p style={{ margin: 0 }}>
                {resolving ? '결과 동기화 중… (서버가 무엇을 잡았는지 결정)' : '결과 대기'}
              </p>
              {!resolving && error && (
                <button type="button" onClick={() => void onReelSuccess()} style={btn}>
                  재동기화(멱등 재호출)
                </button>
              )}
            </div>
          )}

          {/* fail: 빈손 result로 합류 */}
          {fsm === 'fail' && (
            <div>
              <p style={{ margin: '0 0 10px', color: '#ffd28a' }}>
                놓쳤습니다 — 빈손. (resolve 미호출 · 스태미나는 반환되지 않음)
              </p>
              <button type="button" onClick={finishEmptyHanded} style={btnPrimary}>
                결과 확인(빈손)
              </button>
            </div>
          )}
        </section>
      )}

      {/* 4) 결과 */}
      {fsm === 'result' && (
        <section style={card}>
          <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>결과</h2>
          {reward ? (
            <ul style={{ margin: '0 0 12px', paddingLeft: 18, lineHeight: 1.7 }}>
              <li>종: {reward.speciesId}</li>
              {reward.rarity && <li>희귀도: {reward.rarity}</li>}
              <li>성격: {reward.nature}</li>
              <li>성장 단계: {reward.growthStage}</li>
              <li>크기: {Math.round(reward.sizePct * 100)}%{reward.sizePct >= FISHING_SKILL.perfectCatchSizeFloor && ' (상위 10%)'}</li>
            </ul>
          ) : (
            <p style={{ margin: '0 0 12px', color: '#ffd28a' }}>
              {emptyHanded ? '빈손 — 다음엔 더 신중하게!' : '보상 없음'}
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={resetRound} style={btnPrimary}>
              다시 낚시
            </button>
            <a href="/dex" style={linkBtn}>
              도감 보기
            </a>
            <a href="/lobby" style={linkBtn}>
              로비로
            </a>
          </div>
        </section>
      )}

      <p style={{ opacity: 0.6, marginTop: 16, fontSize: 13 }}>
        서버 권위(GUARDRAILS §1·§4): 서버는 &quot;무엇을 잡았나&quot;만 결정하고 보상 쓰기
        (fish_instances/dex_entries)는 전부 fishing-resolve Edge에서. 클라는 직접 테이블 write 없이
        결과 표시 + SELECT 재조회만. 멱등키 = fishing_sessions.id (응답 지연/단절 시 재호출 안전).
      </p>
      {inProgress && (
        <p style={{ opacity: 0.5, marginTop: 4, fontSize: 12 }}>
          진행 중인 세션이 있으면 이탈해도 동일 session_id로 resolve 재호출 시 결과가 복원됩니다.
        </p>
      )}
    </PageShell>
  );
}

/**
 * 멱등 재동기화 래퍼(설계서/04 §4):
 * 응답이 RESOLVE_TIMEOUT_MS 내 도착하지 않으면 동일 session_id로 한 번 더 resolve를 시도한다.
 * (resolve가 멱등이므로 중복 지급 없이 기존 reward를 복원한다.)
 */
async function withResyncRetry<T>(call: () => Promise<T>): Promise<T> {
  const first = call();
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), RESOLVE_TIMEOUT_MS),
  );
  const raced = await Promise.race([first, timeout]);
  if (raced !== 'timeout') return raced as T;
  // 지연 → 스피너 유지 상태에서 멱등 재호출(기존 first도 결국 같은 결과로 수렴).
  return call();
}

/** Edge reward(snake_case jsonb)를 명시 타입 FishingReward(camelCase)로 정규화. */
function normalizeReward(r: Record<string, unknown>): FishingReward {
  return {
    id: String(r.id ?? ''),
    aquariumId: String(r.aquarium_id ?? ''),
    speciesId: String(r.species_id ?? ''),
    rarity: typeof r.rarity === 'string' ? r.rarity : undefined,
    nature: String(r.nature ?? ''),
    growthStage: Number(r.growth_stage ?? 1),
    sizePct: Number(r.size_pct ?? 0),
  };
}

function stageLabel(s: FishingState): string {
  switch (s) {
    case 'casting':
      return '캐스팅';
    case 'waiting':
      return '입질 대기';
    case 'reeling':
      return '릴링';
    case 'resolving':
      return '결과 동기화';
    case 'fail':
      return '실패(빈손)';
    case 'result':
      return '결과';
    default:
      return s;
  }
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** 스태미나 부족 거부 메시지 휴리스틱(서버 메시지 다양성 대비). */
function isStaminaShortage(e: unknown): boolean {
  const msg = describe(e).toLowerCase();
  return msg.includes('stamina') || msg.includes('스태미나') || msg.includes('insufficient');
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return '알 수 없는 오류';
}

const card: React.CSSProperties = {
  padding: 16,
  borderRadius: 10,
  border: '1px solid #233040',
  background: '#0f1822',
  marginTop: 12,
};

const lbl: React.CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 13,
  opacity: 0.9,
};

const btn: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid #3a4656',
  background: '#16202b',
  color: '#cfe8ff',
  cursor: 'pointer',
};

const btnPrimary: React.CSSProperties = {
  ...btn,
  border: '1px solid #2e6cff',
  background: '#13315c',
  color: '#dbe8ff',
};

const linkBtn: React.CSSProperties = {
  ...btn,
  textDecoration: 'none',
  display: 'inline-block',
};
