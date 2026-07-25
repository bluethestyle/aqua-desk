/**
 * DB 스모크 테스트 — Docker/관리자 없이 embedded Postgres로 supabase/ 마이그레이션·트리거·RPC·RLS를
 * 실제 실행 검증한다. Supabase 전용 `auth` 스키마(auth.users/uid()/role())는 최소 스텁으로 대체한다.
 *
 * 실행: node scripts/db-smoke.mjs
 * 주의: GoTrue/PostgREST는 없으므로 웹↔인증 end-to-end가 아니라 "DB SQL 계층"을 검증한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from 'embedded-postgres';

const EmbeddedPostgres = pkg.default ?? pkg.EmbeddedPostgres ?? pkg;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.tmp-pgdata');
const PORT = 54329;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const PRELUDE = `
create extension if not exists pgcrypto;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
`;

const GRANTS = `
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
`;

async function setClaims(client, sub, role) {
  await client.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub ?? '']);
  await client.query(`select set_config('request.jwt.claim.role', $1, false)`, [role ?? 'anon']);
}

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
    // 한글 Windows 로케일(CP949)은 UTF8 클러스터 초기화 중 invalid byte(0xb5)를 유발한다.
    // C 로케일 + SQL_ASCII(바이트 검증 비활성)로 우회 — 기능 검증(카운트/version/status)엔 무영향.
    initdbFlags: ['--locale=C', '--encoding=SQL_ASCII'],
  });

  console.log('• embedded postgres 초기화(첫 실행 시 바이너리 다운로드)…');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('aqua');
  const client = pg.getPgClient();
  client.database = 'aqua';
  await client.connect();

  try {
    // ── 스키마 적용 ────────────────────────────────────────────────────
    await client.query(PRELUDE);
    const migDir = path.join(ROOT, 'supabase', 'migrations');
    const migs = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migs) {
      await client.query(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }
    check('migrations 적용', true, migs.join(' → '));

    await client.query(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
    check('seed 적용', true);

    // 격리 스키마로 검색경로 고정 — 이후 unqualified 쿼리/RPC는 aquadesk 대상.
    // (권한은 마이그 0005_grants.sql이 부여하므로 별도 GRANTS 불필요.)
    await client.query('set search_path = aquadesk, extensions, public');

    // ── TEST 1: 신규 가입 부트스트랩 트리거 ─────────────────────────────
    const uid = (await client.query(`select gen_random_uuid() as id`)).rows[0].id;
    await client.query(`insert into auth.users(id) values ($1)`, [uid]);
    const prof = (await client.query(`select count(*)::int n from profiles where id=$1`, [uid])).rows[0].n;
    const wal = (await client.query(`select count(*)::int n from wallets where user_id=$1`, [uid])).rows[0].n;
    const aqRow = (await client.query(`select id, version, water_quality from aquariums where user_id=$1 and idx=1`, [uid])).rows[0];
    const fishN = (await client.query(`select count(*)::int n from fish_instances where aquarium_id=$1`, [aqRow?.id])).rows[0].n;
    check('가입 트리거: profiles+wallets 생성', prof === 1 && wal === 1, `profiles=${prof}, wallets=${wal}`);
    check('가입 트리거: 기본 어항 #1 생성', !!aqRow, aqRow ? `id=${aqRow.id.slice(0, 8)} v=${aqRow.version}` : 'none');
    check('가입 트리거: 환영 물고기 1마리', fishN === 1, `fish=${fishN}`);

    const aqId = aqRow.id;
    await setClaims(client, uid, 'authenticated');

    // ── TEST 2: feed_fish RPC (서버 권위 + version CAS + GUC 트리거 통과) ──
    // 먼저 hunger를 낮춰 회복을 관찰.
    await client.query(`update fish_instances set hunger=0.2 where aquarium_id=$1`, [aqId]);
    const feed = (await client.query(`select feed_fish($1) as r`, [aqId])).rows[0].r;
    const aq2 = (await client.query(`select version from aquariums where id=$1`, [aqId])).rows[0];
    const hunger2 = (await client.query(`select min(hunger) m from fish_instances where aquarium_id=$1`, [aqId])).rows[0].m;
    check('feed_fish: status=ok + version 증가', feed?.status === 'ok' && aq2.version === 2, `status=${feed?.status} v=${aq2.version}`);
    check('feed_fish: hunger 회복(0.2→0.7)', Number(hunger2) > 0.6, `min hunger=${hunger2}`);

    // ── TEST 3: ★GUC 보호 트리거 실증 (앞 턴에서 고친 핵심 결함) ────────
    // (a) 권위 컨텍스트가 아닌 직접 UPDATE는 guard 트리거가 보호 컬럼을 되돌려야 한다.
    await client.query(`update aquariums set water_quality=0.123 where id=$1`, [aqId]);
    const wqRaw = (await client.query(`select water_quality from aquariums where id=$1`, [aqId])).rows[0].water_quality;
    check('guard 트리거: 직접 water_quality 쓰기 차단(원값 복원)', Number(wqRaw) !== 0.123, `water_quality=${wqRaw} (0.123이면 실패)`);
    // (b) clean_aquarium RPC는 GUC를 켜므로 보호 컬럼 쓰기가 통과해야 한다.
    await client.query(`update fish_instances set hunger=0.1 where aquarium_id=$1`, [aqId]);
    await client.query(`update aquariums set water_quality=0.4 where id=$1`, [aqId]); // guard가 되돌림(무시됨)
    const cleaned = (await client.query(`select clean_aquarium($1) as r`, [aqId])).rows[0].r;
    const wq2 = (await client.query(`select water_quality from aquariums where id=$1`, [aqId])).rows[0].water_quality;
    check('clean_aquarium RPC: GUC로 water_quality=1 통과', cleaned?.status === 'ok' && Number(wq2) === 1, `status=${cleaned?.status} wq=${wq2}`);

    // ── TEST 4: collect_offline RPC (오프라인 코인 적립 bigint) ──────────
    // last_collected_at을 과거로 밀어 적립 발생 유도.
    await client.query(`update aquariums set last_collected_at = now() - interval '3 hours' where id=$1`, [aqId]);
    // (위 직접 update도 guard가 되돌리므로 의미 없을 수 있음 → 서버는 collect 시 now 기준으로만 계산.
    //  대신 born 직후라 0일 수 있으니, 값과 무관하게 RPC가 에러 없이 bigint를 반환하는지 검증.)
    const coins = (await client.query(`select collect_offline($1) as c`, [aqId])).rows[0].c;
    check('collect_offline: bigint 반환(에러 없음, ≥0)', coins !== null && Number(coins) >= 0, `coins=${coins}`);

    // ── TEST 5: start_fishing RPC (스태미나 게이트 + 세션 생성) ──────────
    const stBefore = (await client.query(`select stamina from wallets where user_id=$1`, [uid])).rows[0].stamina;
    const sess = (await client.query(`select start_fishing('home') as s`)).rows[0].s;
    const stAfter = (await client.query(`select stamina from wallets where user_id=$1`, [uid])).rows[0].stamina;
    const sessRow = (await client.query(`select count(*)::int n from fishing_sessions where id=$1 and user_id=$2`, [sess, uid])).rows[0].n;
    check('start_fishing: session uuid 반환 + fishing_sessions insert', !!sess && sessRow === 1, `session=${String(sess).slice(0, 8)}`);
    check('start_fishing: 스태미나 -1 차감', Number(stAfter) === Number(stBefore) - 1, `${stBefore}→${stAfter}`);

    // ── TEST 6: 공유 토큰 (불투명 + user_id 비노출) ─────────────────────
    const token = (await client.query(`select issue_share_token(1) as t`)).rows[0].t;
    const shared = (await client.query(`select get_shared_aquarium($1) as a`, [token])).rows[0].a;
    const sharedStr = JSON.stringify(shared);
    check('issue_share_token: 토큰 발급(길이 16+)', typeof token === 'string' && token.length >= 16, `len=${token?.length}`);
    check('get_shared_aquarium: 스냅샷 형태(version/themeId/dayNight/fish/pendingAnims)',
      shared?.status === 'ok' && 'dayNight' in shared && Array.isArray(shared.fish) && 'pendingAnims' in shared,
      `keys=${Object.keys(shared ?? {}).join(',')}`);
    check('get_shared_aquarium: ★user_id 미노출', !sharedStr.includes(uid) && !sharedStr.toLowerCase().includes('user_id'), 'user_id/uuid 미포함');

    // ── TEST 7: RLS — 클라(authenticated)는 권위 테이블 직접 쓰기 거부 ───
    await client.query(`set role authenticated`);
    const upd = await client.query(`update wallets set coins = coins + 999999 where user_id=$1`, [uid]);
    const shareSel = await client.query(`select count(*)::int n from share_tokens`);
    await client.query(`reset role`);
    const coinsNow = (await client.query(`select coins from wallets where user_id=$1`, [uid])).rows[0].coins;
    check('RLS: authenticated의 wallets 직접 UPDATE 거부(0행)', upd.rowCount === 0, `rowCount=${upd.rowCount}, coins=${coinsNow}`);
    check('RLS: authenticated의 share_tokens 직접 SELECT 거부(0행=정책없음)', shareSel.rows[0].n === 0, `visible=${shareSel.rows[0].n}`);

  } finally {
    await client.end().catch(() => {});
    await pg.stop().catch(() => {});
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n=== DB 스모크 결과: ${pass}/${results.length} PASS, ${fail} FAIL ===`);
  if (fail > 0) {
    console.log(results.filter((r) => !r.ok).map((r) => `  ✗ ${r.name} — ${r.detail}`).join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('스모크 실행 오류:', e?.message ?? e);
  process.exit(2);
});
