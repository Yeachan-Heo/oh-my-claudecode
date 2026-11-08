/**
 * Factory chain audit view (D2): a read-only summary of what the chain did in
 * this project. Everything here reads the same durable artifacts the runtime
 * writes — the decisions trail, stop markers, link ledgers, the authoritative
 * route table — so the view can never disagree with the state the chain left
 * behind. Pure reads; no locking, no writes.
 */

import * as fs from 'fs';
import { join } from 'path';
import { detectStalledLinks, type StalledLink } from './watchdog.js';
import { factoryStateDir, readProjectRoutes } from '../hooks/session-end/chain-enqueuer.js';

export interface ChainIntentSummary {
  intentId: string;
  decisionCount: number;
  /** decision name -> occurrences, e.g. { enqueued: 3, 'chain-terminal': 1 }. */
  counts: Record<string, number>;
  lastDecision?: string;
  /** ISO 8601, from the decision record. */
  lastDecisionAt?: string;
  stopped?: { reason: string; stoppedAt: string };
}

export interface ChainStatus {
  directory: string;
  /** Keys of the project route table (the single authority, upstream #4176). */
  routeKeys: string[];
  /** Link ledgers still on disk (pre-written first rings and enqueued links alike). */
  activeLedgers: number;
  /** Most-recently-active first. */
  intents: ChainIntentSummary[];
  stalled: StalledLink[];
}

function intentSummary(map: Map<string, ChainIntentSummary>, intentId: string): ChainIntentSummary {
  const existing = map.get(intentId);
  if (existing) return existing;
  const created: ChainIntentSummary = { intentId, decisionCount: 0, counts: {} };
  map.set(intentId, created);
  return created;
}

function readDecisions(factoryDir: string, intents: Map<string, ChainIntentSummary>): void {
  try {
    for (const line of fs.readFileSync(join(factoryDir, 'chain-decisions.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record: { intentId?: unknown; decision?: unknown; at?: unknown };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        continue;
      }
      if (typeof record.intentId !== 'string' || typeof record.decision !== 'string') continue;
      const summary = intentSummary(intents, record.intentId);
      summary.decisionCount += 1;
      summary.counts[record.decision] = (summary.counts[record.decision] ?? 0) + 1;
      if (typeof record.at === 'string' && (summary.lastDecisionAt === undefined || record.at > summary.lastDecisionAt)) {
        summary.lastDecision = record.decision;
        summary.lastDecisionAt = record.at;
      }
    }
  } catch {
    // no decisions trail yet
  }
}

function readStopMarkers(factoryDir: string, intents: Map<string, ChainIntentSummary>): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(factoryDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^chain-(.+)\.stopped\.json$/.exec(entry);
    if (!match) continue;
    let marker: { reason?: unknown; stoppedAt?: unknown };
    try {
      marker = JSON.parse(fs.readFileSync(join(factoryDir, entry), 'utf8')) as typeof marker;
    } catch {
      continue;
    }
    const summary = intentSummary(intents, match[1]);
    summary.stopped = {
      reason: typeof marker.reason === 'string' ? marker.reason : 'unknown',
      stoppedAt: typeof marker.stoppedAt === 'string' ? marker.stoppedAt : '',
    };
  }
}

export function readChainStatus(directory: string, now?: Date): ChainStatus {
  const factoryDir = factoryStateDir(directory);
  const intents = new Map<string, ChainIntentSummary>();
  readDecisions(factoryDir, intents);
  readStopMarkers(factoryDir, intents);
  let activeLedgers = 0;
  try {
    activeLedgers = fs.readdirSync(factoryDir).filter((entry) => /^chain-[0-9a-f-]+\.json$/i.test(entry)).length;
  } catch {
    // no factory dir yet
  }
  return {
    directory,
    routeKeys: Object.keys(readProjectRoutes(directory) ?? {}),
    activeLedgers,
    intents: [...intents.values()].sort((a, b) => (b.lastDecisionAt ?? '').localeCompare(a.lastDecisionAt ?? '')),
    stalled: detectStalledLinks(factoryDir, now ? { now } : {}),
  };
}
