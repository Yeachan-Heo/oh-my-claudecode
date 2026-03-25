import 'dotenv/config';
import { runSafetyGates } from './src/safety/gates.js';
import { db } from './src/db/index.js';
import { sql } from 'drizzle-orm';

const posts = [
  {
    content: `코큐텐 아티초크 같이 먹지 마\n\n코큐텐은 지용성이라 기름이랑 먹어야 흡수되거든\n근데 아티초크가 담즙 분비를 촉진해서 지방 소화를 방해함\n\n결과적으로 코큐텐 흡수율 박살 ㅋㅋ\n\n둘 다 먹고 싶으면 최소 2시간은 간격 두는 거 권장함\n좋다고 마구 같이 먹으면 안 되더라\n\n저장해두고 영양제 먹을 때마다 확인해`,
    category: '건강',
    time: '08:00',
    editor: 'hana-health-editor',
    brief: '코큐텐+아티초크 동시복용 금기 역발상',
    qaScore: 10,
    type: 'regular'
  },
  {
    content: `약사가 알려준 여드름 연고 3개\n\n1. 벤조일퍼옥사이드 5% — 초기 여드름, 약국에서 바로 살 수 있음\n2. 클린다마이신 겔 — 염증성 여드름, 하루 2번 여드름 위에 콕 발라주면 됨\n3. 아다팔렌 0.1% — 레티노이드 계열, 각질 들뜨는 거 잡아주고 재발도 줄어드는 느낌\n\n뭘 사야 할지 모르겠으면 이 3개 중에 골라봐`,
    category: '건강',
    time: '14:00',
    editor: 'hana-health-editor',
    brief: '약국 여드름 연고 총정리 리스트형',
    qaScore: 10,
    type: 'experiment'
  },
  {
    content: `나만 아직 겨울 선크림 쓰고 있어?ㅋㅋ\n\n자외선 지수가 2~3월부터 확 올라가거든\n겨울엔 3~5였는데 봄 되면 6~8까지 튀어오름\n\n겨울용은 보습 위주라 봄엔 유분 밀리고 차단도 부족함ㅜ\n토리든 워터리 선세럼 SPF50+ 신제품 나왔길래 이번에 바꿔볼 것 같음\n\n뭐 쓰고 있어? 알려줘`,
    category: '뷰티',
    time: '20:00',
    editor: 'bini-beauty-editor',
    brief: '봄 선크림 질문형 공감 토리든 연계',
    qaScore: 10,
    type: 'regular'
  }
];

async function main() {
  const results = [];
  
  for (const p of posts) {
    console.log(`\n--- Safety Gates: ${p.category} ${p.time} ---`);
    const report = await runSafetyGates(p.content, 'duribeon231', p.qaScore);
    
    if (!report.allPassed) {
      console.error(`BLOCKED: ${report.blockers.map((b: any) => b.reason).join(', ')}`);
      results.push({ ...p, status: 'blocked', reason: report.blockers.map((b: any) => b.reason).join(', ') });
    } else {
      console.log(`PASS: warnings=${report.warnings.length}`);
      if (report.warnings.length > 0) {
        for (const w of report.warnings) console.log(`  WARNING: ${(w as any).reason}`);
      }
      results.push({ ...p, status: 'ready' });
    }
  }

  // Register passed posts in aff_contents
  for (const r of results) {
    if (r.status === 'ready') {
      const scheduledTime = `2026-03-23 ${r.time}:00+09`;
      await db.execute(sql`
        INSERT INTO aff_contents (category, scheduled_time, status, editor_agent, brief, content, created_at)
        VALUES (${r.category}, ${scheduledTime}::timestamptz, 'ready', ${r.editor}, ${r.brief}, ${r.content}, NOW())
      `);
      console.log(`Registered: ${r.category} ${r.time} → aff_contents status='ready'`);
    }
  }

  // Show ready list
  const ready = await db.execute(sql`
    SELECT id, scheduled_time, category, editor_agent, LEFT(content, 60) AS preview
    FROM aff_contents
    WHERE status = 'ready'
      AND DATE(scheduled_time) = CURRENT_DATE
    ORDER BY scheduled_time ASC
  `);
  console.log('\n=== Ready for Publishing ===');
  for (const row of ready) console.log(JSON.stringify(row));

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
