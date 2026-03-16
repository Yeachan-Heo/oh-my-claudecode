import { db } from '../src/db/index.js';
import { affContents, needs } from '../src/db/schema.js';

async function main() {
  const allNeeds = await db.select().from(needs);
  console.log('=== 추출된 니즈 (' + allNeeds.length + '개) ===');
  for (const n of allNeeds) {
    console.log('[' + n.category + '] ' + n.problem);
    console.log('  구매연결: ' + n.purchase_linkage + ' | 신호강도: ' + n.signal_strength + ' | Threads적합도: ' + n.threads_fit);
    console.log('  대표표현: ' + JSON.stringify(n.representative_expressions));
    console.log('  상품카테고리: ' + JSON.stringify(n.product_categories));
    console.log('');
  }

  const contents = await db.select().from(affContents);
  console.log('=== 생성된 콘텐츠 (' + contents.length + '개) ===');
  for (const c of contents) {
    console.log('[' + c.format + '] ' + c.product_name + ' (need: ' + c.need_id + ')');
    console.log('  훅: ' + c.hook);
    const bodies = c.bodies as string[];
    console.log('  본문: ' + (bodies[0] || '').slice(0, 200) + '...');
    const selfComments = c.self_comments as string[];
    console.log('  셀프댓글: ' + JSON.stringify(selfComments));
    console.log('');
  }
}
main().catch(console.error);
