/**
 * hosted Supabase에 마이그레이션 + 시드를 적용한다 (Docker/CLI 로그인 불필요).
 *
 * 사용:
 *   $env:SUPABASE_DB_URL="postgresql://postgres:[PW]@[HOST]:5432/postgres"   # PowerShell
 *   npm run db:apply
 *   # 새로 다시 깔끔히 적용하려면(개발용, public 스키마 초기화):
 *   npm run db:apply -- --reset
 *
 * 연결 문자열: Supabase 대시보드 > Connect > "Session pooler"(IPv4) 또는 "Direct connection" URI.
 * .env.local 등에 두고(커밋 금지) 위처럼 환경변수로 주입한다.
 *
 * 주의: 이 스크립트는 DB SQL(스키마/RLS/트리거/RPC/시드)만 적용한다. Edge Functions
 * (fishing-resolve 등)는 `supabase functions deploy`로 별도 배포해야 하며, 익명 인증은
 * 대시보드(Authentication > Providers > Anonymous)에서 켠다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.SUPABASE_DB_URL;
const RESET = process.argv.includes('--reset');

if (!url) {
  console.error(
    'SUPABASE_DB_URL 환경변수가 필요합니다.\n' +
      '  Supabase 대시보드 > Connect > Session pooler(또는 Direct) 의 URI를 복사해 설정하세요.\n' +
      '  예) $env:SUPABASE_DB_URL="postgresql://postgres.xxxx:[PW]@aws-0-...pooler.supabase.com:5432/postgres"',
  );
  process.exit(2);
}

const RESET_SQL = `
-- 격리 스키마만 초기화(기존 public/다른 데이터는 절대 건드리지 않음). 0001이 aquadesk를 재생성한다.
drop schema if exists aquadesk cascade;
`;

async function main() {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('begin');

    if (RESET) {
      console.log('• --reset: public 스키마 초기화');
      await client.query(RESET_SQL);
    }

    const migDir = path.join(ROOT, 'supabase', 'migrations');
    const migs = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migs) {
      console.log('• apply', f);
      await client.query(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }
    console.log('• apply seed.sql');
    await client.query(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));

    await client.query('commit');
    console.log('\n✓ hosted DB에 마이그레이션 + 시드 적용 완료.');
    console.log('  다음: ① Authentication > Providers > Anonymous 켜기  ② apps/web/.env.local 설정  ③ npm run dev -w apps/web');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.error('\n✗ 적용 실패(rollback됨):', e?.message ?? e);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error('연결/실행 오류:', e?.message ?? e);
  process.exit(1);
});
