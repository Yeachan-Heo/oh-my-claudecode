/**
 * @file Autonomous chat triggers — agents start conversations based on conditions. Phase 4.
 */
import { createRoom, sendChatMessage } from './chat-system.js';

export interface TriggerContext {
  postViews?: Record<string, number>;
  avgViews?: number;
  qaScores?: Record<string, number>;
  trendKeywords?: string[];
  categoryRoi?: Record<string, number[]>;
  contentCount?: number;
  brandEvents?: Array<{ id: string; urgency: string; category: string }>;
}

export interface ChatTrigger {
  id: string;
  name: string;
  condition: (ctx: TriggerContext) => boolean;
  action: {
    roomType: 'dm' | 'meeting';
    sender: string;
    getRecipients: (ctx: TriggerContext) => string[];
    getMessage: (ctx: TriggerContext) => string;
  };
  cooldownHours: number;
  priority: 'high' | 'medium' | 'low';
}

// Category → editor mapping
const CATEGORY_EDITORS: Record<string, string> = {
  '뷰티': 'bini-beauty-editor',
  '건강': 'hana-health-editor',
  '생활': 'sora-lifestyle-editor',
  '다이어트': 'jiu-diet-editor',
};

export const CHAT_TRIGGERS: ChatTrigger[] = [
  {
    id: 'performance-anomaly-high',
    name: '성과 이상치 감지 (고성과)',
    condition: (ctx) => {
      if (!ctx.postViews || !ctx.avgViews) return false;
      return Object.values(ctx.postViews).some(v => v > ctx.avgViews! * 3);
    },
    action: {
      roomType: 'dm',
      sender: 'seoyeon-analyst',
      getRecipients: () => ['bini-beauty-editor'],
      getMessage: () => `포스트 성과 이상치 감지: 평균의 3배 이상 조회수. 패턴 분석이 필요합니다.`,
    },
    cooldownHours: 24,
    priority: 'medium',
  },
  {
    id: 'performance-anomaly-low',
    name: '성과 이상치 감지 (저성과)',
    condition: (ctx) => {
      if (!ctx.postViews || !ctx.avgViews) return false;
      return Object.values(ctx.postViews).some(v => v < ctx.avgViews! * 0.3);
    },
    action: {
      roomType: 'dm',
      sender: 'seoyeon-analyst',
      getRecipients: () => ['bini-beauty-editor'],
      getMessage: () => `포스트 성과가 평균의 30% 미만입니다. 원인 분석이 필요해요.`,
    },
    cooldownHours: 24,
    priority: 'medium',
  },
  {
    id: 'qa-reject',
    name: 'QA 반려 피드백',
    condition: (ctx) => {
      if (!ctx.qaScores) return false;
      return Object.values(ctx.qaScores).some(s => s < 6.0);
    },
    action: {
      roomType: 'dm',
      sender: 'doyun-qa',
      getRecipients: () => ['bini-beauty-editor'],
      getMessage: () => `QA 점수 6.0 미만 — REJECT. 구체적 수정 방향을 DM으로 전달합니다.`,
    },
    cooldownHours: 0,
    priority: 'high',
  },
  {
    id: 'trend-discovery',
    name: '트렌드 소재 발견',
    condition: (ctx) => (ctx.trendKeywords?.length ?? 0) > 0,
    action: {
      roomType: 'dm',
      sender: 'junho-researcher',
      getRecipients: () => ['jihyun-marketing-lead'],
      getMessage: (ctx) => `새 트렌드 발견: ${ctx.trendKeywords?.join(', ')}`,
    },
    cooldownHours: 12,
    priority: 'medium',
  },
  {
    id: 'strategy-change',
    name: '전략 변경 논의',
    condition: (ctx) => {
      if (!ctx.categoryRoi) return false;
      return Object.values(ctx.categoryRoi).some(
        roi => roi.length >= 3 && roi.slice(-3).every((v, i, arr) => i === 0 || v < arr[i - 1])
      );
    },
    action: {
      roomType: 'meeting',
      sender: 'minjun-ceo',
      getRecipients: () => ['seoyeon-analyst', 'jihyun-marketing-lead'],
      getMessage: () => `카테고리 ROI 3일 연속 하락 — 긴급 전략 회의 소집.`,
    },
    cooldownHours: 72,
    priority: 'high',
  },
  {
    id: 'warmup-complete',
    name: '워밍업 완료 알림',
    condition: (ctx) => (ctx.contentCount ?? 0) >= 20,
    action: {
      roomType: 'dm',
      sender: 'taeho-engineer',
      getRecipients: () => ['minjun-ceo'],
      getMessage: () => `워밍업 완료! content_lifecycle 20개 달성. 제휴 콘텐츠 시작 가능합니다.`,
    },
    cooldownHours: 168,
    priority: 'high',
  },
  {
    id: 'brand-event-urgent',
    name: '브랜드 이벤트 긴급',
    condition: (ctx) => ctx.brandEvents?.some(e => e.urgency === 'high') ?? false,
    action: {
      roomType: 'dm',
      sender: 'junho-researcher',
      getRecipients: (ctx) => {
        const urgent = ctx.brandEvents?.find(e => e.urgency === 'high');
        return [CATEGORY_EDITORS[urgent?.category ?? '뷰티'] ?? 'bini-beauty-editor'];
      },
      getMessage: (ctx) => {
        const urgent = ctx.brandEvents?.find(e => e.urgency === 'high');
        return `긴급 브랜드 이벤트: ${urgent?.id}. 빠른 콘텐츠 대응이 필요합니다.`;
      },
    },
    cooldownHours: 6,
    priority: 'high',
  },
  {
    id: 'daily-standup',
    name: '일일 스탠드업',
    condition: () => true,
    action: {
      roomType: 'meeting',
      sender: 'minjun-ceo',
      getRecipients: () => [
        'seoyeon-analyst', 'bini-beauty-editor', 'doyun-qa',
        'junho-researcher', 'taeho-engineer',
      ],
      getMessage: () => `일일 스탠드업 시작. 각자 어제 성과와 오늘 계획을 공유해주세요.`,
    },
    cooldownHours: 24,
    priority: 'low',
  },
];

// Cooldown tracker (in-memory, reset on restart)
const lastFired = new Map<string, number>();

export async function evaluateTriggers(ctx: TriggerContext): Promise<string[]> {
  const firedTriggers: string[] = [];

  for (const trigger of CHAT_TRIGGERS) {
    // Check cooldown
    const lastTime = lastFired.get(trigger.id) ?? 0;
    const cooldownMs = trigger.cooldownHours * 3600000;
    if (Date.now() - lastTime < cooldownMs) continue;

    // Check condition
    if (!trigger.condition(ctx)) continue;

    // Fire trigger
    try {
      const recipients = trigger.action.getRecipients(ctx);
      const allParticipants = [trigger.action.sender, ...recipients];
      const room = await createRoom({
        type: trigger.action.roomType,
        name: trigger.name,
        participants: allParticipants,
        createdBy: trigger.action.sender,
      });

      await sendChatMessage(
        trigger.action.sender,
        room.id,
        trigger.action.getMessage(ctx),
        { messageType: 'alert' },
      );

      lastFired.set(trigger.id, Date.now());
      firedTriggers.push(trigger.id);
    } catch {
      // Silently skip failed triggers
    }
  }

  return firedTriggers;
}
