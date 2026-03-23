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

export interface QAResult {
  passed: boolean;
  score: number;           // 0-10
  feedback: string[];
  killerGates: { k1: boolean; k2: boolean; k3: boolean; k4: boolean };
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
