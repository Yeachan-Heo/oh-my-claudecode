import { runFactcheck } from '../hooks/factcheck/index.js';
import { checkSentinelHealth } from '../hooks/factcheck/sentinel.js';
import type { FactcheckResult } from '../hooks/factcheck/types.js';

export interface SentinelReadinessOptions {
  logPath?: string;
  workspace?: string;
  claims?: Record<string, unknown>;
  enabled?: boolean;
}

export interface SentinelGateResult {
  ready: boolean;
  blockers: string[];
  skipped: boolean;
}

function mapFactcheckToBlockers(result: FactcheckResult): string[] {
  if (result.verdict === 'PASS') {
    return [];
  }

  if (result.mismatches.length === 0) {
    return [`[factcheck] verdict ${result.verdict}`];
  }

  return result.mismatches.map(
    mismatch => `[factcheck] ${mismatch.severity} ${mismatch.check}: ${mismatch.detail}`,
  );
}

export function checkSentinelReadiness(
  options: SentinelReadinessOptions = {},
): SentinelGateResult {
  const {
    logPath,
    workspace,
    claims,
    enabled = true,
  } = options;

  if (!enabled) {
    return {
      ready: true,
      blockers: [],
      skipped: true,
    };
  }

  const blockers: string[] = [];
  let ranCheck = false;

  if (logPath) {
    ranCheck = true;
    const health = checkSentinelHealth(logPath, workspace);
    blockers.push(...health.blockers);
  }

  if (claims) {
    ranCheck = true;
    const factcheck = runFactcheck(claims, { workspace });
    blockers.push(...mapFactcheckToBlockers(factcheck));
  }

  const dedupedBlockers = [...new Set(blockers)];
  return {
    ready: dedupedBlockers.length === 0,
    blockers: dedupedBlockers,
    skipped: !ranCheck,
  };
}
