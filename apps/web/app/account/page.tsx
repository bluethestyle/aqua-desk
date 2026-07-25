'use client';

/**
 * Account — 게스트(익명) ↔ 정식(이메일) 계정 관리 (설계서/04 §2 (auth) 게이트의 프로토 구현).
 *
 * 동작 3종(전부 Supabase Auth 경유 — 게임 데이터는 건드리지 않는다):
 *  1) 게스트 → 정식 전환: supabase.auth.updateUser({ email, password })
 *     - 같은 auth.users 행이 승격되므로 **지갑/어항/물고기 데이터가 그대로 승계**된다.
 *     - 이메일 확인이 켜져 있으면 확인 메일 후 적용(개발 설정은 OFF → 즉시).
 *  2) 기존 계정 로그인: signInWithPassword — 세션 교체 후 전체 리로드(/lobby)로 상태 초기화.
 *     - 현재 게스트 세션은 버려진다(게스트 데이터는 그 익명 계정에 남음) → UI에 경고.
 *  3) 로그아웃: signOut — 다음 진입 시 새 게스트가 시작된다. 게스트 상태 로그아웃은
 *     복구 불가(익명 계정 접근 상실)라 경고를 띄운다.
 *
 * 서버 권위(GUARDRAILS §1): 이 페이지는 인증(auth.*)만 다루고 권위 테이블 쓰기 없음.
 */

import { useCallback, useEffect, useState } from 'react';
import { PageShell } from '../../components/page-shell';
import { requestWalletRefresh } from '../../components/wallet-bar';
import { getSupabaseClient } from '../../lib/supabase/client';
import { ensureSession } from '../../lib/supabase/session';

interface AccountState {
  userId: string;
  email: string | null;
  isAnonymous: boolean;
}

export default function AccountPage() {
  const [state, setState] = useState<AccountState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 폼 입력(전환/로그인 공용 아님 — 각자 별도 상태로 명확히).
  const [upEmail, setUpEmail] = useState('');
  const [upPassword, setUpPassword] = useState('');
  const [inEmail, setInEmail] = useState('');
  const [inPassword, setInPassword] = useState('');

  const refresh = useCallback(async () => {
    await ensureSession();
    const supabase = getSupabaseClient();
    const { data, error: e } = await supabase.auth.getUser();
    if (e) throw e;
    const u = data.user;
    if (!u) throw new Error('no_user');
    setState({
      userId: u.id,
      email: u.email ?? null,
      // supabase-js v2: user.is_anonymous. 이메일이 붙으면 정식 계정으로 본다.
      isAnonymous: (u as { is_anonymous?: boolean }).is_anonymous === true && !u.email,
    });
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await refresh();
      } catch (e) {
        if (alive) setError(describe(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  /** 1) 게스트 → 정식 전환(데이터 승계 — 같은 유저 행 승격). */
  const onUpgrade = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    (async () => {
      try {
        if (!upEmail.includes('@') || upPassword.length < 6) {
          throw new Error('이메일 형식과 6자 이상 비밀번호를 확인하세요.');
        }
        const supabase = getSupabaseClient();
        const { error: e } = await supabase.auth.updateUser({
          email: upEmail.trim(),
          password: upPassword,
        });
        if (e) throw e;
        setNotice('정식 계정으로 전환됐어요 — 지갑·어항·물고기가 그대로 유지됩니다.');
        setUpEmail('');
        setUpPassword('');
        await refresh();
        requestWalletRefresh();
      } catch (e) {
        setError(describe(e));
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, upEmail, upPassword, refresh]);

  /** 2) 기존 계정 로그인(세션 교체 → 전체 리로드로 페이지 상태 초기화). */
  const onSignIn = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    (async () => {
      try {
        const supabase = getSupabaseClient();
        const { error: e } = await supabase.auth.signInWithPassword({
          email: inEmail.trim(),
          password: inPassword,
        });
        if (e) throw e;
        // 세션이 바뀌었으므로 SPA 상태를 신뢰하지 않는다 — 전체 리로드.
        window.location.assign('/lobby');
      } catch (e) {
        setError(describe(e));
        setBusy(false);
      }
    })();
  }, [busy, inEmail, inPassword]);

  /** 3) 로그아웃(게스트면 복구 불가 경고는 UI 문구로). */
  const onSignOut = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setError(null);
    (async () => {
      try {
        const supabase = getSupabaseClient();
        await supabase.auth.signOut();
        window.location.assign('/lobby'); // 다음 진입 시 새 게스트 시작.
      } catch (e) {
        setError(describe(e));
        setBusy(false);
      }
    })();
  }, [busy]);

  return (
    <PageShell title="계정">
      {loading && <p>불러오는 중…</p>}
      {error && <p style={{ color: '#ff8a8a' }}>오류: {error}</p>}
      {notice && <p style={{ color: '#8affb0' }}>{notice}</p>}

      {state && (
        <>
          <section style={card}>
            <h2 style={h2}>현재 세션</h2>
            <p style={{ margin: 0, fontSize: 14 }}>
              {state.isAnonymous ? (
                <>
                  <strong>게스트(익명)</strong> — 이 기기/브라우저에서만 유지됩니다. 브라우저
                  데이터를 지우면 진행이 사라져요.
                </>
              ) : (
                <>
                  <strong>정식 계정</strong> · {state.email}
                </>
              )}
            </p>
          </section>

          {state.isAnonymous && (
            <section style={card}>
              <h2 style={h2}>정식 계정으로 전환 (진행 데이터 유지)</h2>
              <p style={{ margin: '0 0 10px', opacity: 0.75, fontSize: 13 }}>
                이메일을 등록하면 지금 게스트의 지갑·어항·물고기를 그대로 가진 채 어느 기기에서든
                로그인할 수 있어요.
              </p>
              <div style={formRow}>
                <input
                  type="email"
                  placeholder="이메일"
                  value={upEmail}
                  onChange={(e) => setUpEmail(e.target.value)}
                  disabled={busy}
                  style={input}
                  autoComplete="email"
                />
                <input
                  type="password"
                  placeholder="비밀번호 (6자 이상)"
                  value={upPassword}
                  onChange={(e) => setUpPassword(e.target.value)}
                  disabled={busy}
                  style={input}
                  autoComplete="new-password"
                />
                <button type="button" onClick={onUpgrade} disabled={busy} style={btnPrimary}>
                  {busy ? '처리 중…' : '전환하기'}
                </button>
              </div>
            </section>
          )}

          <section style={card}>
            <h2 style={h2}>기존 계정으로 로그인</h2>
            {state.isAnonymous && (
              <p style={{ margin: '0 0 10px', color: '#ffd28a', fontSize: 13 }}>
                주의: 로그인하면 지금 게스트 진행에는 더 이상 접근할 수 없어요. 게스트 진행을
                지키려면 위의 &quot;정식 계정으로 전환&quot;을 사용하세요.
              </p>
            )}
            <div style={formRow}>
              <input
                type="email"
                placeholder="이메일"
                value={inEmail}
                onChange={(e) => setInEmail(e.target.value)}
                disabled={busy}
                style={input}
                autoComplete="email"
              />
              <input
                type="password"
                placeholder="비밀번호"
                value={inPassword}
                onChange={(e) => setInPassword(e.target.value)}
                disabled={busy}
                style={input}
                autoComplete="current-password"
              />
              <button type="button" onClick={onSignIn} disabled={busy} style={btn}>
                로그인
              </button>
            </div>
          </section>

          <section style={card}>
            <h2 style={h2}>로그아웃</h2>
            <p style={{ margin: '0 0 10px', opacity: 0.75, fontSize: 13 }}>
              {state.isAnonymous
                ? '게스트 상태에서 로그아웃하면 이 진행으로 다시 돌아올 수 없어요(익명 계정은 복구 불가).'
                : '로그아웃 후 다시 접속하면 새 게스트로 시작됩니다. 이 계정으로는 언제든 다시 로그인할 수 있어요.'}
            </p>
            <button type="button" onClick={onSignOut} disabled={busy} style={btnDanger}>
              로그아웃
            </button>
          </section>
        </>
      )}

      <p style={{ opacity: 0.6, marginTop: 16, fontSize: 13 }}>
        인증은 Supabase Auth 경유(auth.users 승격/세션 교체). 게임 데이터 자체는 건드리지 않으며
        전환 시 같은 유저 행이 승격되므로 진행이 승계됩니다(GUARDRAILS §1 서버 권위 유지).
      </p>
    </PageShell>
  );
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return '알 수 없는 오류';
}

const card: React.CSSProperties = {
  marginTop: 12,
  padding: 14,
  borderRadius: 10,
  border: '1px solid #233040',
  background: '#0f1822',
};

const h2: React.CSSProperties = { fontSize: 15, margin: '0 0 8px', opacity: 0.9 };

const formRow: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  alignItems: 'center',
};

const input: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid #3a4656',
  background: '#0c141d',
  color: '#e8f1ff',
  fontSize: 14,
  minWidth: 200,
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

const btnDanger: React.CSSProperties = {
  ...btn,
  border: '1px solid #7a3a3a',
  background: '#2b1416',
  color: '#ffd0d0',
};
