/**
 * BiniLab pixel office layout — 6 rooms + 11 agent positions.
 * Coordinates match the Agent Town tilemap grid (16px tiles).
 */
import type { SeatState, SeatFacing } from '@/types/game';

export interface OfficeRoom {
  name: string;
  code: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Office rooms (tile coordinates, 16px grid)
export const OFFICE_ROOMS: OfficeRoom[] = [
  { name: 'CEO실', code: 'owner_office', x: 1, y: 1, width: 4, height: 3 },
  { name: '분석실', code: 'analysis_room', x: 6, y: 1, width: 4, height: 3 },
  { name: '편집실', code: 'editor_room', x: 11, y: 1, width: 5, height: 3 },
  { name: 'QA실', code: 'desk', x: 1, y: 5, width: 3, height: 3 },
  { name: '회의실', code: 'meeting_room', x: 5, y: 5, width: 5, height: 3 },
  { name: '라운지', code: 'lounge', x: 11, y: 5, width: 5, height: 3 },
];

// 11 BiniLab agents as seats
export const BINILAB_SEATS: SeatState[] = [
  // === Resident agents (6) ===
  {
    seatId: 'minjun-ceo',
    label: '민준(CEO)',
    seatType: 'agent',
    roleTitle: 'CEO',
    assigned: true,
    spriteKey: 'char-red',
    spawnX: 3,
    spawnY: 2,
    spawnFacing: 'down' as SeatFacing,
    status: 'running',
    taskSnippet: '전략 수립 대기 중',
  },
  {
    seatId: 'seoyeon-analyst',
    label: '서연(분석팀장)',
    seatType: 'agent',
    roleTitle: '분석팀장',
    assigned: true,
    spriteKey: 'char-teal',
    spawnX: 7,
    spawnY: 2,
    spawnFacing: 'down' as SeatFacing,
    status: 'running',
    taskSnippet: '데이터 분석 중',
  },
  {
    seatId: 'bini-beauty-editor',
    label: '빈이(뷰티 에디터)',
    seatType: 'agent',
    roleTitle: '뷰티 크리에이터',
    assigned: true,
    spriteKey: 'char-pink',
    spawnX: 12,
    spawnY: 2,
    spawnFacing: 'down' as SeatFacing,
    status: 'running',
    taskSnippet: '포스트 작성 중',
  },
  {
    seatId: 'doyun-qa',
    label: '도윤(QA)',
    seatType: 'agent',
    roleTitle: '품질검수관',
    assigned: true,
    spriteKey: 'char-blue',
    spawnX: 2,
    spawnY: 6,
    spawnFacing: 'right' as SeatFacing,
    status: 'running',
    taskSnippet: 'QA 검수 대기 중',
  },
  {
    seatId: 'junho-researcher',
    label: '준호(트렌드헌터)',
    seatType: 'agent',
    roleTitle: '트렌드헌터',
    assigned: true,
    spriteKey: 'char-green',
    spawnX: 8,
    spawnY: 2,
    spawnFacing: 'left' as SeatFacing,
    status: 'running',
    taskSnippet: '트렌드 수집 중',
  },
  {
    seatId: 'taeho-engineer',
    label: '태호(엔지니어)',
    seatType: 'agent',
    roleTitle: '엔지니어',
    assigned: true,
    spriteKey: 'char-yellow',
    spawnX: 2,
    spawnY: 7,
    spawnFacing: 'up' as SeatFacing,
    status: 'running',
    taskSnippet: '시스템 모니터링',
  },
  // === On-demand agents (5) - initially idle at desks ===
  {
    seatId: 'jihyun-marketing-lead',
    label: '지현(마케팅팀장)',
    seatType: 'agent',
    roleTitle: '마케팅팀장',
    assigned: true,
    spriteKey: 'char-purple',
    spawnX: 13,
    spawnY: 2,
    spawnFacing: 'left' as SeatFacing,
    status: 'done',
    taskSnippet: '대기 중',
  },
  {
    seatId: 'hana-health-editor',
    label: '하나(건강 에디터)',
    seatType: 'agent',
    roleTitle: '건강 에디터',
    assigned: true,
    spriteKey: 'char-lime',
    spawnX: 14,
    spawnY: 2,
    spawnFacing: 'left' as SeatFacing,
    status: 'done',
    taskSnippet: '대기 중',
  },
  {
    seatId: 'sora-lifestyle-editor',
    label: '소라(생활 에디터)',
    seatType: 'agent',
    roleTitle: '생활 에디터',
    assigned: true,
    spriteKey: 'char-sky',
    spawnX: 12,
    spawnY: 6,
    spawnFacing: 'up' as SeatFacing,
    status: 'done',
    taskSnippet: '대기 중',
  },
  {
    seatId: 'jiu-diet-editor',
    label: '지우(다이어트 에디터)',
    seatType: 'agent',
    roleTitle: '다이어트 에디터',
    assigned: true,
    spriteKey: 'char-gold',
    spawnX: 13,
    spawnY: 6,
    spawnFacing: 'up' as SeatFacing,
    status: 'done',
    taskSnippet: '대기 중',
  },
  {
    seatId: 'sihun-owner',
    label: '시훈(오너)',
    seatType: 'agent',
    roleTitle: '오너',
    assigned: true,
    spriteKey: 'char-white',
    spawnX: 2,
    spawnY: 2,
    spawnFacing: 'right' as SeatFacing,
    status: 'running',
    taskSnippet: '모니터링 중',
  },
];

// Location code -> room mapping for behavior mirroring
export const LOCATION_TO_ROOM: Record<string, { x: number; y: number }> = {
  desk: { x: -1, y: -1 }, // Use agent's default spawnX/Y
  meeting_room: { x: 7, y: 6 },
  lounge: { x: 13, y: 6 },
  owner_office: { x: 3, y: 2 },
  analysis_room: { x: 7, y: 2 },
  editor_room: { x: 13, y: 2 },
};

export function getAgentPosition(seatId: string, location: string) {
  const seat = BINILAB_SEATS.find(s => s.seatId === seatId);
  if (!seat) return null;

  if (location === 'desk' || !LOCATION_TO_ROOM[location]) {
    return { x: seat.spawnX ?? 5, y: seat.spawnY ?? 5 };
  }

  return LOCATION_TO_ROOM[location];
}
