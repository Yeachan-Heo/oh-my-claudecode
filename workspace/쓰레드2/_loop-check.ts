import { client } from './src/db/index.js';
async function main() {
  // 실험 로그 데이터 확인
  const exp = await client`SELECT COUNT(*) as cnt FROM content_lifecycle WHERE experiment_id IS NOT NULL`;
  console.log('실험 기록:', exp[0].cnt, '개');

  // content_lifecycle 데이터
  const cl = await client`SELECT COUNT(*) as cnt FROM content_lifecycle`;
  console.log('content_lifecycle:', cl[0].cnt, '개');

  // daily_performance_reports
  const dpr = await client`SELECT COUNT(*) as cnt FROM daily_performance_reports`;
  console.log('daily_performance_reports:', dpr[0].cnt, '개');

  // strategy_archive
  const sa = await client`SELECT COUNT(*) as cnt FROM strategy_archive`;
  console.log('strategy_archive:', sa[0].cnt, '개');

  // post_snapshots
  const ps = await client`SELECT COUNT(*) as cnt FROM post_snapshots`;
  console.log('post_snapshots:', ps[0].cnt, '개');

  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
