/**
 * @file Shared ID generation utility.
 *
 * Uses crypto.randomUUID() for collision-safe unique identifiers.
 */

import crypto from 'crypto';

/**
 * prefix 기반 고유 ID를 생성한다.
 * 형식: `{prefix}-{uuid}` (예: `lc-550e8400-e29b-41d4-a716-446655440000`)
 */
export function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
