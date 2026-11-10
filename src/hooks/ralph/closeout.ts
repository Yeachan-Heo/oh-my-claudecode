/**
 * Ralph terminal closeout record.
 *
 * The skill's Step 7.5 deslop pass and Step 8 closeout are prose: nothing
 * failed when an agent skipped them and reported success. This module backs
 * an explicit, revision-bound record that `omc ralph verify` requires once
 * every PRD story is complete.
 *
 * It records the closeout step, not the deslop work itself — an agent can
 * still lie. What it removes is silence: a completed run now has to state
 * whether the pass ran, and a stale record cannot be reused after the story
 * criteria change.
 */

import * as fs from 'fs';
import { join } from 'path';

export const RALPH_CLOSEOUT_FILENAME = 'ralph-closeout.json';

export const DESLOP_STATUSES = ['completed', 'skipped'] as const;
export type DeslopStatus = (typeof DESLOP_STATUSES)[number];

export interface RalphCloseout {
  version: 1;
  sessionId: string;
  deslop: DeslopStatus;
  /** Criteria revision the record was written against; a later criteria edit invalidates it. */
  criteriaRevision: string;
  recordedAt: string;
}

export function isDeslopStatus(value: unknown): value is DeslopStatus {
  return typeof value === 'string' && (DESLOP_STATUSES as readonly string[]).includes(value);
}

export function closeoutPath(stateRoot: string, sessionId: string): string {
  return join(stateRoot, 'state', 'sessions', sessionId, RALPH_CLOSEOUT_FILENAME);
}

export function readCloseout(path: string): RalphCloseout | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Partial<RalphCloseout>;
    if (record.version !== 1 || !isDeslopStatus(record.deslop)) return null;
    if (typeof record.criteriaRevision !== 'string' || record.criteriaRevision.length === 0) return null;
    return {
      version: 1,
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
      deslop: record.deslop,
      criteriaRevision: record.criteriaRevision,
      recordedAt: typeof record.recordedAt === 'string' ? record.recordedAt : '',
    };
  } catch {
    return null;
  }
}

export function writeCloseout(
  path: string,
  record: Omit<RalphCloseout, 'version' | 'recordedAt'>,
  now: Date = new Date(),
): boolean {
  try {
    fs.mkdirSync(join(path, '..'), { recursive: true });
    const payload: RalphCloseout = { version: 1, ...record, recordedAt: now.toISOString() };
    fs.writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the record covers the criteria revision that is complete now.
 * A record written before a criteria amendment must not satisfy the gate.
 */
export function isCloseoutSatisfied(record: RalphCloseout | null, criteriaRevision: string): boolean {
  return record !== null
    && isDeslopStatus(record.deslop)
    && record.criteriaRevision === criteriaRevision;
}
