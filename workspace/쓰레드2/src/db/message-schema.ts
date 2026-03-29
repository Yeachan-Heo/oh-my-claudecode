/**
 * @file message-schema.ts — 구조화된 메시지 페이로드 타입 + 빌더.
 *
 * AgentScope 구조화 통신 프로토콜 적용.
 * DB 마이그레이션 없이 기존 agent_messages.payload (jsonb) 필드를 활용.
 *
 * Usage:
 *   import { buildStructuredPayload, type StructuredPayload } from './db/message-schema.js';
 */

export type MessagePriority = 'critical' | 'high' | 'normal' | 'low';

export type ResponseFormat =
  | 'orient_result'    // Phase 2 Orient 응답
  | 'directive_result' // Phase 3 Decide 응답
  | 'content_draft'    // Phase 4 콘텐츠 초안
  | 'qa_verdict'       // Phase 4 QA 판정
  | 'free_text';       // 자유형 (기본)

export interface StructuredPayload {
  schema_version: number;
  priority: MessagePriority;
  expected_response_format: ResponseFormat;
  data: Record<string, unknown>;
}

/**
 * 구조화된 메시지 페이로드 빌더.
 * priority 기본값: 'normal', expectedResponseFormat 기본값: 'free_text'.
 */
export function buildStructuredPayload(opts: {
  priority?: MessagePriority;
  expectedResponseFormat?: ResponseFormat;
  data: Record<string, unknown>;
}): StructuredPayload {
  return {
    schema_version: 1,
    priority: opts.priority ?? 'normal',
    expected_response_format: opts.expectedResponseFormat ?? 'free_text',
    data: opts.data,
  };
}
