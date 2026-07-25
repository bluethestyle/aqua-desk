'use client';

/**
 * Dex (W5) — 도감(수집 메타) (설계서/04 §1, 기획서/04 §4.1).
 *
 * 서버 권위(GUARDRAILS §1, §4.1, §9):
 *  - dex_entries는 권위 테이블 → 클라는 **자기 행 SELECT만**. 쓰기는 fishing-resolve(Edge)가 upsert.
 *  - 세트 완성 버프(coin_rate_bonus += DEX_BUFF.coinRateBonusPerSet)는 서버가 wallets에 반영(GUARDRAILS §6).
 *    이 페이지는 **표시만** 한다(직접 write 없음).
 *  - fish_species 카탈로그(public read)와 자기 dex 행을 join해(loadDex) 미수집/수집 그리드를 그린다.
 *    카탈로그는 public read라 미로그인도 종 목록은 보이되, caught(count)는 자기 행 기준.
 *
 * UI: 희귀도 티어(common/rare/mythic)별 그룹 그리드. 보유 종은 강조+count, 미보유는 실루엣(물음표).
 *     히어로 종(isHero) 배지. 상단에 완성도(% · caughtCount/total) + 세트 완성 버프 안내.
 *     로딩/에러 패턴은 로비(page.tsx)와 동일.
 *
 * ★직접 테이블 write 없음(읽기 전용 메타 뷰).
 */

import { useEffect, useState } from 'react';
import type { Rarity } from '@aquadesk/game-spec';
import { DEX_BUFF } from '@aquadesk/game-spec';
import { PageShell } from '../../components/page-shell';
import { loadDex, type DexView, type SpeciesEntry } from '../../lib/supabase/queries';

/** 희귀도 티어 표시 순서/라벨/색(common → rare → mythic). */
const RARITY_TIERS: ReadonlyArray<{ rarity: Rarity; label: string; color: string }> = [
  { rarity: 'common', label: '일반 (common)', color: '#9fb6c7' },
  { rarity: 'rare', label: '희귀 (rare)', color: '#7fd0ff' },
  { rarity: 'mythic', label: '신화 (mythic)', color: '#d6a3ff' },
];

export default function DexPage() {
  const [dex, setDex] = useState<DexView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const next = await loadDex();
        if (alive) setDex(next);
      } catch (e) {
        if (alive) setError(describe(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <PageShell title="도감">
      {loading && <p>불러오는 중…</p>}
      {error && (
        <p style={{ color: '#ff8a8a' }}>
          오류: {error}
          {error.toLowerCase().includes('anonymous') && (
            <span style={{ opacity: 0.8 }}> (Supabase에서 Anonymous sign-ins 활성화 필요)</span>
          )}
        </p>
      )}

      {dex && (
        <>
          {/* 완성도 헤더 + 세트 완성 버프 안내 */}
          <section style={progressCard}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 8,
              }}
            >
              <strong style={{ fontSize: 16 }}>완성도 {Math.round(dex.completion * 100)}%</strong>
              <span style={{ opacity: 0.85, fontSize: 13 }}>
                {dex.caughtCount} / {dex.total} 종 수집
              </span>
            </div>
            {/* 진행도 바 */}
            <div style={progressTrack}>
              <div style={{ ...progressFill, width: `${Math.round(dex.completion * 100)}%` }} />
            </div>
            <p style={{ margin: '8px 0 0', opacity: 0.8, fontSize: 13 }}>
              세트 완성 시 coin_rate_bonus +{DEX_BUFF.coinRateBonusPerSet} (오프라인 코인 적립률
              상향). 버프 값은 서버(wallets) 권위이며 여기서는 안내만 표시합니다.
            </p>
          </section>

          {/* 희귀도 티어별 그룹 그리드 */}
          {RARITY_TIERS.map(({ rarity, label, color }) => {
            const group = dex.species.filter((s) => s.rarity === rarity);
            if (group.length === 0) return null;
            const tierCaught = group.filter((s) => dex.caught[s.id]).length;
            return (
              <section key={rarity} style={{ marginTop: 20 }}>
                <h2 style={{ fontSize: 15, margin: '0 0 8px', color }}>
                  {label}{' '}
                  <span style={{ opacity: 0.6, fontWeight: 400, fontSize: 13 }}>
                    {tierCaught}/{group.length}
                  </span>
                </h2>
                <div style={grid}>
                  {group.map((sp) => (
                    <SpeciesCell
                      key={sp.id}
                      species={sp}
                      count={dex.caught[sp.id]?.count}
                      tierColor={color}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}

      <p style={{ opacity: 0.6, marginTop: 24, fontSize: 13 }}>
        주의: dex_entries는 SELECT-only(자기 행). 수집 갱신은 낚시(fishing-resolve)가, 세트 완성
        버프는 서버(wallets)가 권위로 반영합니다. 카탈로그(fish_species)는 public read.
      </p>
    </PageShell>
  );
}

/** 단일 종 셀: 보유 시 강조+count, 미보유 시 실루엣(물음표). 히어로 배지. */
function SpeciesCell({
  species,
  count,
  tierColor,
}: {
  species: SpeciesEntry;
  count: number | undefined;
  tierColor: string;
}) {
  const caught = count != null;
  return (
    <div
      title={caught ? `${species.id} ×${count}` : `미수집 (${species.rarity})`}
      style={{
        ...cell,
        borderColor: caught ? tierColor : '#233040',
        background: caught ? '#16202b' : '#0e151d',
        opacity: caught ? 1 : 0.7,
      }}
    >
      {/* 히어로 배지 */}
      {species.isHero && (
        <span style={heroBadge} title="히어로 종">
          ★ 히어로
        </span>
      )}
      <span style={{ fontSize: 28, filter: caught ? undefined : 'grayscale(1)' }}>
        {caught ? '🐟' : '❓'}
      </span>
      <span
        style={{
          fontSize: 12,
          color: caught ? '#cfe8ff' : '#5d6b78',
          textAlign: 'center',
          wordBreak: 'break-all',
        }}
      >
        {caught ? species.id : '미수집'}
      </span>
      {caught && <span style={{ fontSize: 11, opacity: 0.85, color: tierColor }}>×{count}</span>}
    </div>
  );
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return '알 수 없는 오류';
}

const progressCard: React.CSSProperties = {
  padding: '12px 14px',
  borderRadius: 10,
  background: '#0f1822',
  border: '1px solid #233040',
};

const progressTrack: React.CSSProperties = {
  marginTop: 8,
  height: 8,
  borderRadius: 4,
  background: '#1c2733',
  overflow: 'hidden',
};

const progressFill: React.CSSProperties = {
  height: '100%',
  background: 'linear-gradient(90deg, #7fd0ff, #8affb0)',
  transition: 'width .3s',
};

const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
  gap: 8,
};

const cell: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  minHeight: 96,
  padding: '10px 6px',
  borderRadius: 10,
  border: '1px solid #233040',
};

const heroBadge: React.CSSProperties = {
  position: 'absolute',
  top: 4,
  right: 4,
  padding: '1px 5px',
  borderRadius: 6,
  fontSize: 9,
  fontWeight: 700,
  color: '#1a0b2e',
  background: '#d6a3ff',
};
