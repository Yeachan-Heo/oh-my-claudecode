// src/team/capabilities.ts

/**
 * Capability tagging system for worker fitness scoring.
 *
 * Maps worker backends to default capabilities and provides
 * scoring functions for task-worker matching.
 */

import type { WorkerBackend, WorkerCapability } from './types.js';
import type { UnifiedTeamMember } from './unified-team.js';

export type WorkerProvider = 'claude' | 'codex' | 'gemini' | 'cursor' | 'copilot';

/** Default capabilities by worker backend */
const DEFAULT_CAPABILITIES: Record<WorkerBackend, WorkerCapability[]> = {
  'claude-native': ['code-edit', 'testing', 'general'],
  'mcp-codex': ['code-review', 'security-review', 'architecture', 'refactoring'],
  'mcp-gemini': ['ui-design', 'documentation', 'research', 'code-edit'],
  'tmux-claude': ['code-edit', 'testing', 'general'],
  'tmux-codex': ['code-review', 'security-review', 'architecture', 'refactoring'],
  'tmux-gemini': ['ui-design', 'documentation', 'research', 'code-edit'],
  'tmux-cursor': ['code-edit', 'refactoring', 'general'],
};

const PROVIDER_BY_BACKEND: Record<WorkerBackend, WorkerProvider> = {
  'claude-native': 'claude',
  'mcp-codex': 'codex',
  'mcp-gemini': 'gemini',
  'tmux-claude': 'claude',
  'tmux-codex': 'codex',
  'tmux-gemini': 'gemini',
  'tmux-cursor': 'cursor',
};

const BACKEND_BY_AGENT_TYPE: Record<string, WorkerBackend> = {
  claude: 'tmux-claude',
  'mcp-claude': 'tmux-claude',
  'tmux-claude': 'tmux-claude',
  codex: 'tmux-codex',
  'mcp-codex': 'mcp-codex',
  'tmux-codex': 'tmux-codex',
  gemini: 'tmux-gemini',
  'mcp-gemini': 'mcp-gemini',
  'tmux-gemini': 'tmux-gemini',
  cursor: 'tmux-cursor',
  'tmux-cursor': 'tmux-cursor',
  copilot: 'tmux-cursor',
  'mcp-copilot': 'tmux-cursor',
  'tmux-copilot': 'tmux-cursor',
};

/**
 * Resolve a runtime/backend identifier into one of the existing worker backends.
 *
 * Copilot workers intentionally piggyback on the cursor-style executor backend:
 * they are interactive executor lanes, not prompt-mode reviewer lanes.
 */
export function resolveWorkerBackend(agentTypeOrBackend: string | null | undefined): WorkerBackend {
  const normalized = String(agentTypeOrBackend ?? '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DEFAULT_CAPABILITIES, normalized)) {
    return normalized as WorkerBackend;
  }
  return BACKEND_BY_AGENT_TYPE[normalized] ?? 'mcp-codex';
}

/**
 * Resolve a runtime/backend identifier into a user-facing provider label.
 */
export function resolveWorkerProvider(agentTypeOrBackend: string | null | undefined): WorkerProvider {
  const normalized = String(agentTypeOrBackend ?? '').trim().toLowerCase();
  if (normalized === 'copilot' || normalized === 'mcp-copilot' || normalized === 'tmux-copilot') {
    return 'copilot';
  }
  return PROVIDER_BY_BACKEND[resolveWorkerBackend(normalized)];
}

/**
 * Get default capabilities for a worker backend.
 */
export function getDefaultCapabilities(backend: WorkerBackend): WorkerCapability[] {
  return [...(DEFAULT_CAPABILITIES[backend] || ['general'])];
}

/**
 * Get default capabilities from a runtime agent type or worker_cli string.
 */
export function getDefaultCapabilitiesForWorker(agentTypeOrBackend: string | null | undefined): WorkerCapability[] {
  return getDefaultCapabilities(resolveWorkerBackend(agentTypeOrBackend));
}

/**
 * Score a worker's fitness for a task based on capabilities.
 * Higher score = better fit.
 *
 * Scoring:
 * - Each matching capability = 1.0 point
 * - 'general' capability = 0.5 points for any requirement (wildcard)
 * - Score normalized to 0-1 range based on total required capabilities
 * - Workers with 0 matching capabilities score 0
 */
export function scoreWorkerFitness(
  worker: UnifiedTeamMember,
  requiredCapabilities: WorkerCapability[]
): number {
  if (requiredCapabilities.length === 0) return 1.0; // No requirements = everyone fits

  let score = 0;
  const workerCaps = new Set(worker.capabilities);

  for (const req of requiredCapabilities) {
    if (workerCaps.has(req)) {
      score += 1.0;
    } else if (workerCaps.has('general')) {
      score += 0.5;
    }
  }

  return score / requiredCapabilities.length;
}

/**
 * Find the best available workers for a set of required capabilities.
 * Returns workers sorted by fitness score (descending).
 * Only includes workers with score > 0.
 */
export function rankWorkersForTask(
  workers: UnifiedTeamMember[],
  requiredCapabilities: WorkerCapability[]
): UnifiedTeamMember[] {
  const scored = workers
    .map(w => ({ worker: w, score: scoreWorkerFitness(w, requiredCapabilities) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map(s => s.worker);
}
