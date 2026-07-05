import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { z } from 'zod';
import { getLazyCodexStatePaths, validateLazyCodexExecutionState } from '../../interop/lazycodex-state.js';
import type { LazyCodexCompatDecision, LazyCodexCompatSideEffect } from './types.js';
import { LazyCodexSinkSafetyError, safeAppendLazyCodexJsonLine } from './safe-file.js';

export interface EvidenceCheck {
  readonly decision: LazyCodexCompatDecision;
  readonly message?: string;
  readonly sideEffects: readonly LazyCodexCompatSideEffect[];
}

export interface EvidenceCheckOptions {
  readonly sessionId: string;
}

const DoneClaimSchema = z.object({
  DoneClaim: z.object({
    manual_qa: z.array(z.string()).optional(),
    evidence: z.array(z.string()).optional(),
    artifact: z.union([z.string(), z.array(z.string())]).optional(),
    artifacts: z.array(z.string()).optional(),
  }).passthrough(),
}).passthrough();

function parseDoneClaimOutput(output: string | undefined): readonly string[] {
  if (!output) {
    return [];
  }

  try {
    const parsed = DoneClaimSchema.safeParse(JSON.parse(output));
    if (!parsed.success) {
      return [];
    }
    const claim = parsed.data.DoneClaim;
    return [
      ...(claim.manual_qa ?? []),
      ...(claim.evidence ?? []),
      ...artifactValues(claim.artifact),
      ...(claim.artifacts ?? []),
    ];
  } catch (error) {
    if (error instanceof SyntaxError) {
      return [];
    }
    throw error;
  }
}

function artifactValues(value: string | readonly string[] | undefined): readonly string[] {
  if (!value) {
    return [];
  }
  return typeof value === 'string' ? [value] : value;
}

function isInsideDirectory(directoryPath: string, candidate: string): boolean {
  const relativePath = relative(directoryPath, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function verifyEvidencePath(cwd: string, path: string): string | null {
  const resolved = resolve(cwd, path);
  const evidenceRoot = join(cwd, '.lazycodex', 'evidence');
  if (!isInsideDirectory(resolve(cwd), resolved)) {
    return `artifact is outside project root: ${path}`;
  }
  if (!isInsideDirectory(evidenceRoot, resolved)) {
    return `artifact is outside .lazycodex/evidence: ${path}`;
  }
  if (!existsSync(resolved)) {
    return `missing artifact: ${path}`;
  }
  if (lstatSync(resolved).isSymbolicLink()) {
    return `symbolic link artifact is not accepted: ${path}`;
  }

  const realProjectRoot = realpathSync(cwd);
  const realEvidenceRoot = realpathSync(evidenceRoot);
  const realCandidate = realpathSync(resolved);
  if (!isInsideDirectory(realProjectRoot, realCandidate)) {
    return `artifact is outside project root: ${path}`;
  }
  if (!isInsideDirectory(realEvidenceRoot, realCandidate)) {
    return `artifact is outside .lazycodex/evidence: ${path}`;
  }

  const stat = statSync(resolved);
  if (!stat.isFile()) {
    return `artifact is not a file: ${path}`;
  }
  if (stat.size === 0 || readFileSync(resolved, 'utf8').trim().length === 0) {
    return `empty artifact: ${path}`;
  }
  return null;
}

export function verifyExecutorEvidence(
  cwd: string,
  output: string | undefined,
  options: EvidenceCheckOptions,
): EvidenceCheck {
  const artifacts = parseDoneClaimOutput(output);
  if (artifacts.length === 0) {
    return {
      decision: {
        behavior: 'executor-evidence',
        decision: 'needs-evidence',
        artifactCount: 0,
        reason: 'DoneClaim did not include evidence artifacts',
      },
      message: 'LazyCodex executor evidence verification needs at least one non-empty artifact path.',
      sideEffects: [],
    };
  }

  const executionState = validateLazyCodexExecutionState(cwd, options.sessionId);
  if (!executionState.ok) {
    return {
      decision: {
        behavior: 'executor-evidence',
        decision: 'needs-evidence',
        artifactCount: artifacts.length,
        reason: executionState.reason,
      },
      message: `LazyCodex executor evidence verification failed: ${executionState.reason}`,
      sideEffects: [],
    };
  }

  const failures = artifacts.flatMap((artifact) => {
    const failure = verifyEvidencePath(cwd, artifact);
    return failure ? [failure] : [];
  });
  if (failures.length > 0) {
    return {
      decision: {
        behavior: 'executor-evidence',
        decision: 'needs-evidence',
        artifactCount: artifacts.length,
        reason: failures.join('; '),
      },
      message: `LazyCodex executor evidence verification failed: ${failures.join('; ')}`,
      sideEffects: [],
    };
  }

  const ledgerPath = getLazyCodexStatePaths(cwd).executorEvidenceLedger;
  try {
    safeAppendLazyCodexJsonLine(cwd, ledgerPath, {
      event: 'executor-evidence-verified',
      artifacts,
      verified_at: new Date().toISOString(),
    });
  } catch (error) {
    if (!(error instanceof LazyCodexSinkSafetyError)) {
      throw error;
    }
    return {
      decision: {
        behavior: 'executor-evidence',
        decision: 'needs-evidence',
        artifactCount: artifacts.length,
        reason: error.message,
      },
      message: `LazyCodex executor evidence verification failed: ${error.message}`,
      sideEffects: [],
    };
  }

  return {
    decision: {
      behavior: 'executor-evidence',
      decision: 'verified',
      artifactCount: artifacts.length,
    },
    sideEffects: [{ name: 'append-executor-evidence-ledger', path: ledgerPath }],
  };
}
