/**
 * AquariumCanvas — AquariumSnapshot 시각 렌더(프로토 데모용, 순수 표시 컴포넌트).
 *
 * 설계 노트: 네이티브 배경(GL ES)이 본 렌더의 권위지만, 웹에서도 스냅샷을 같은 계약으로
 * 받아 미러 뷰/공유 뷰어에 보여준다(설계서/03 Mirror, /02 §6). 여기서는 x/y(초기 배치 힌트)에
 * 도트풍 이모지를 배치하는 경량 표현이다(아트는 추후).
 */

import type { AquariumSnapshot, FishSnapshot } from '@aquadesk/game-spec';

const DEFAULT_BG: [string, string] = ['#0b2233', '#06121c'];

const THEME_BG: Record<string, [string, string]> = {
  deepsea: DEFAULT_BG,
  cyberpunk: ['#1a0b2e', '#2b0f3a'],
  emerald: ['#0b3324', '#072018'],
};

const BODY_EMOJI: Record<string, string> = {
  fusiform: '🐟',
  disc: '🐠',
  eel: '🐍',
};

function fishEmoji(f: FishSnapshot): string {
  return BODY_EMOJI[f.bodyType] ?? '🐟';
}

export function AquariumCanvas({
  snapshot,
  height = 220,
}: {
  snapshot: AquariumSnapshot;
  height?: number;
}) {
  const [top, bottom] = THEME_BG[snapshot.themeId] ?? DEFAULT_BG;
  const night = snapshot.dayNight === 'night';

  return (
    <div
      aria-label={`수족관 (테마 ${snapshot.themeId})`}
      style={{
        position: 'relative',
        height,
        borderRadius: 12,
        overflow: 'hidden',
        background: `linear-gradient(180deg, ${top}, ${bottom})`,
        boxShadow: 'inset 0 0 60px rgba(0,0,0,0.5)',
        filter: night ? 'brightness(0.7) saturate(0.85)' : undefined,
      }}
    >
      {/* 수질 오버레이(낮을수록 탁함) */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: '#5b7a3a',
          opacity: (1 - snapshot.waterQuality) * 0.35,
          pointerEvents: 'none',
        }}
      />
      {/* 장식 슬롯 */}
      {snapshot.slots.map((s) => (
        <span
          key={s.slotId}
          title={s.itemId}
          style={{
            position: 'absolute',
            left: `${s.x * 100}%`,
            top: `${s.y * 100}%`,
            transform: 'translate(-50%, -50%)',
            fontSize: 22,
            opacity: 0.9,
          }}
        >
          🪸
        </span>
      ))}
      {/* 물고기 */}
      {snapshot.fish.map((f) => (
        <span
          key={f.id}
          title={`${f.nickname ?? f.speciesId} · ${Math.round(f.sizePct * 100)}%`}
          style={{
            position: 'absolute',
            left: `${f.x * 100}%`,
            top: `${f.y * 100}%`,
            transform: 'translate(-50%, -50%)',
            fontSize: 18 + f.sizePct * 18,
            opacity: f.satisfied ? 1 : 0.45,
            transition: 'opacity .3s',
          }}
        >
          {fishEmoji(f)}
        </span>
      ))}
      {snapshot.fish.length === 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: '#9fb6c7',
            fontSize: 13,
          }}
        >
          비어 있는 수족관 — 낚시로 물고기를 잡아보세요.
        </div>
      )}
    </div>
  );
}
