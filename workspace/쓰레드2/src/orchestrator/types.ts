/**
 * @file types.ts — daily-pipeline 오케스트레이터 타입 정의.
 */

export interface TimeSlot {
  time: string;            // "08:00"
  category: string;        // "뷰티"
  type: 'regular' | 'experiment';
  editor: string;          // "bini-beauty-editor"
  brief: string;
  experiment_id?: string;
}

export interface PostContract {
  slot_index: number;         // time_slots 배열 인덱스
  category: string;
  strategy: 'empathy' | 'story' | 'curiosity' | 'comparison' | 'list';
  topic_signal?: string;      // DB에서 발견된 니즈 신호 (있으면)
  min_hook_score: number;     // 1-10, 기본 6
  min_originality_score: number; // 1-10, 기본 5
  success_criteria: string;   // 한 줄 요약
}

export interface DailyDirective {
  date: string;
  total_posts: number;
  category_allocation: Record<string, number>;
  regular_posts: number;
  experiment_posts: number;
  time_slots: TimeSlot[];
  experiments: Array<{ id: string; hypothesis: string; variable: string }>;
  recycle_candidates: string[];
  diversity_warnings: string[];
  roi_summary: Record<string, { score: number; grade: string }>;
  post_contracts?: PostContract[];
  notes?: string;
}

export interface ContentDraft {
  text: string;
  hook: string;
  format: string;
  category: string;
  editor: string;
  agent_file: string;      // ".claude/agents/bini-beauty-editor.md"
  persona_file?: string;   // "souls/bini-persona.md"
}

export interface QAScores {
  hook: number;         // 1-10: 첫 문장이 스크롤 멈추게 하는가?
  originality: number;  // 1-10: AI냄새 없이 사람 느낌? 템플릿 반복 없는가?
  authenticity: number; // 1-10: 비전문가 관점? 성분명/의학용어 없는가?
  conversion: number;   // 1-10: 구체적 CTA? 제품 연결 자연스러운가?
}

export interface QAResult {
  passed: boolean;
  score: number;           // 0-10 (QAScores 가중 평균)
  scores?: QAScores;       // 4축 상세 점수
  feedback: string[];
  killerGates: { k1: boolean; k2: boolean; k3: boolean; k4: boolean };
  iteration?: number;              // 몇 번째 시도인지 (1-3)
  max_retries_exhausted?: boolean; // 3회 실패 시 true
}

// SafetyReport is defined and owned by src/safety/gates.ts (Worker A).
// Import it from there: import type { SafetyReport } from '../safety/gates.js'

export interface PipelineOptions {
  dryRun: boolean;
  autonomous: boolean;
  posts: number;           // default 10
  phase?: number;          // run specific phase only
}

export interface PhaseGateResult {
  phase: number;
  passed: boolean;
  reason?: string;
  metrics?: Record<string, number>;
}

export interface PipelineResult {
  phases_completed: number[];
  directive?: DailyDirective;
  drafts: ContentDraft[];
  qa_results: QAResult[];
  safety_passed: boolean;
  ready_count: number;     // aff_contents status='ready'
  errors: string[];
  gate_results?: PhaseGateResult[];
}
