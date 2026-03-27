#!/usr/bin/env npx tsx
/**
 * _create-meeting.ts — CEO 회의 소집 CLI
 *
 * CEO(또는 권한 있는 에이전트)가 회의를 소집할 때 사용.
 * meetings 테이블에 회의를 생성하고, 각 참여자에게 PENDING_RESPONSE를 발송한다.
 *
 * 사용법:
 *   npx tsx _create-meeting.ts <CREATOR_ID> <MEETING_TYPE> '<안건>' '<참여자1,참여자2,...>'
 *
 * MEETING_TYPE: standup | planning | review | emergency | weekly | free
 *
 * 예시:
 *   npx tsx _create-meeting.ts minjun-ceo standup '오늘의 수집/분석 현황 공유' 'seoyeon-analyst,junho-researcher,jihyun-marketing-lead'
 *   npx tsx _create-meeting.ts minjun-ceo planning '이번 주 콘텐츠 전략' 'seoyeon-analyst,bini-beauty-editor,hana-health-editor,jihyun-marketing-lead'
 */
import 'dotenv/config';
import { createAgentMeeting } from './src/orchestrator/agent-actions.js';
import type { MeetingType } from './src/orchestrator/meeting.js';

const VALID_TYPES: MeetingType[] = ['standup', 'planning', 'review', 'emergency', 'weekly', 'free'];

const [creatorId, meetingType, agenda, participantsStr] = process.argv.slice(2);

if (!creatorId || !meetingType || !agenda || !participantsStr) {
  console.error('Usage: npx tsx _create-meeting.ts <CREATOR_ID> <MEETING_TYPE> \'<안건>\' \'<참여자1,참여자2,...>\'');
  console.error(`MEETING_TYPE: ${VALID_TYPES.join(' | ')}`);
  console.error('Example: npx tsx _create-meeting.ts minjun-ceo standup \'오늘 현황 공유\' \'seoyeon-analyst,junho-researcher\'');
  process.exit(1);
}

if (!VALID_TYPES.includes(meetingType as MeetingType)) {
  console.error(`[_create-meeting] 잘못된 회의 타입: ${meetingType}`);
  console.error(`유효한 타입: ${VALID_TYPES.join(', ')}`);
  process.exit(1);
}

const participants = participantsStr.split(',').map(p => p.trim()).filter(Boolean);
if (participants.length === 0) {
  console.error('[_create-meeting] 참여자가 없습니다');
  process.exit(1);
}

// 소집자를 참여자에 포함 (없으면 추가)
if (!participants.includes(creatorId)) {
  participants.unshift(creatorId);
}

async function main() {
  const result = await createAgentMeeting({
    creator: creatorId,
    type: meetingType as MeetingType,
    agenda,
    participants,
  });
  console.log(`[_create-meeting] 회의 생성: ${result.meetingId}`);
  console.log(`[_create-meeting] 타입: ${meetingType}, 안건: ${agenda}`);
  console.log(`[_create-meeting] 참여자: ${participants.join(', ')}`);
  console.log(`[_create-meeting] 초대 발송: ${result.dispatched.join(', ')}`);
}

main().catch(e => { console.error('[_create-meeting] 에러:', e); process.exit(1); });
