#!/usr/bin/env npx tsx
/**
 * _dispatch.ts — 에이전트 간 메시지 전달 CLI
 *
 * 에이전트가 tmux에서 다른 에이전트에게 메시지를 보낼 때 사용.
 * PENDING_RESPONSE 마커를 생성하여 watch-pending.ts가 대상 에이전트에 전달한다.
 *
 * 사용법:
 *   npx tsx _dispatch.ts <SENDER_ID> <TARGET_AGENT_ID> <ROOM_ID> '<메시지>'
 *
 * 예시:
 *   npx tsx _dispatch.ts seoyeon-analyst minjun-ceo report-001 '분석 결과 보고합니다'
 *   npx tsx _dispatch.ts minjun-ceo bini-beauty-editor room-123 '오늘 뷰티 콘텐츠 3개 준비해줘'
 */
import 'dotenv/config';
import { dispatchToAgent } from './src/orchestrator/agent-actions.js';

const [senderId, targetId, roomId, ...messageParts] = process.argv.slice(2);
const message = messageParts.join(' ');

if (!senderId || !targetId || !roomId || !message) {
  console.error('Usage: npx tsx _dispatch.ts <SENDER_ID> <TARGET_AGENT_ID> <ROOM_ID> \'<메시지>\'');
  console.error('Example: npx tsx _dispatch.ts seoyeon-analyst minjun-ceo report-001 \'분석 결과 보고합니다\'');
  process.exit(1);
}

async function main() {
  const markerId = await dispatchToAgent({
    sender: senderId,
    target: targetId,
    roomId,
    message,
  });
  console.log(`[_dispatch] ${senderId} → ${targetId} (room: ${roomId}) marker: ${markerId}`);
}

main().catch(e => { console.error('[_dispatch] 에러:', e); process.exit(1); });
