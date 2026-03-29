/**
 * @file message-schema.test.ts — 구조화된 메시지 페이로드 빌더 테스트.
 *
 * TDD RED→GREEN: buildStructuredPayload 함수 + 타입 export 검증.
 */

import { describe, it, expect } from 'vitest';
import { buildStructuredPayload, type MessagePriority, type ResponseFormat, type StructuredPayload } from '../db/message-schema.js';

describe('buildStructuredPayload', () => {
  it('should create payload with priority and format', () => {
    const payload = buildStructuredPayload({
      priority: 'high',
      expectedResponseFormat: 'orient_result',
      data: { weeklyStats: { views: 100 } },
    });

    expect(payload.priority).toBe('high');
    expect(payload.expected_response_format).toBe('orient_result');
    expect(payload.data.weeklyStats).toEqual({ views: 100 });
    expect(payload.schema_version).toBe(1);
  });

  it('should default priority to normal', () => {
    const payload = buildStructuredPayload({
      data: { note: 'test' },
    });
    expect(payload.priority).toBe('normal');
  });

  it('should default expected_response_format to free_text', () => {
    const payload = buildStructuredPayload({
      data: { note: 'test' },
    });
    expect(payload.expected_response_format).toBe('free_text');
  });

  it('should always set schema_version to 1', () => {
    const payload = buildStructuredPayload({
      priority: 'critical',
      expectedResponseFormat: 'content_draft',
      data: {},
    });
    expect(payload.schema_version).toBe(1);
  });

  it('should preserve all data fields', () => {
    const payload = buildStructuredPayload({
      priority: 'low',
      expectedResponseFormat: 'qa_verdict',
      data: { passed: true, score: 95, issues: ['minor formatting'] },
    });
    expect(payload.data).toEqual({
      passed: true,
      score: 95,
      issues: ['minor formatting'],
    });
  });
});

// Type-level verification — these just need to compile
describe('type exports', () => {
  it('MessagePriority accepts valid values', () => {
    const priorities: MessagePriority[] = ['critical', 'high', 'normal', 'low'];
    expect(priorities).toHaveLength(4);
  });

  it('ResponseFormat accepts valid values', () => {
    const formats: ResponseFormat[] = [
      'orient_result',
      'directive_result',
      'content_draft',
      'qa_verdict',
      'free_text',
    ];
    expect(formats).toHaveLength(5);
  });

  it('StructuredPayload has correct shape', () => {
    const payload: StructuredPayload = {
      schema_version: 1,
      priority: 'normal',
      expected_response_format: 'free_text',
      data: {},
    };
    expect(payload).toBeDefined();
  });
});
