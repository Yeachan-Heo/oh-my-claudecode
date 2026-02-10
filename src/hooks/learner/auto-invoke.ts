import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWriteJson } from '../../lib/atomic-write.js';

export interface InvocationConfig {
  enabled: boolean;
  confidenceThreshold: number;  // Default: 80
  maxAutoInvokes: number;       // Per session, default: 3
  cooldownMs: number;           // Between invokes, default: 30000
}

export interface InvocationRecord {
  skillId: string;
  skillName: string;
  timestamp: number;
  confidence: number;
  prompt: string;
  wasSuccessful: boolean | null;  // null = unknown
  feedbackScore: number | null;   // User rating if provided
}

export interface AutoInvokeState {
  sessionId: string;
  config: InvocationConfig;
  invocations: InvocationRecord[];
  lastInvokeTime: number;
}

const DEFAULT_CONFIG: InvocationConfig = {
  enabled: true,
  confidenceThreshold: 80,
  maxAutoInvokes: 3,
  cooldownMs: 30000,
};

/**
 * Load auto-invocation config from ~/.claude/.omc-config.json
 */
export function loadInvocationConfig(): InvocationConfig {
  const configPath = path.join(os.homedir(), '.claude', '.omc-config.json');

  try {
    if (!fs.existsSync(configPath)) {
      return { ...DEFAULT_CONFIG };
    }

    const configFile = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configFile);

    // Merge with defaults
    return {
      enabled: config.autoInvoke?.enabled ?? DEFAULT_CONFIG.enabled,
      confidenceThreshold: config.autoInvoke?.confidenceThreshold ?? DEFAULT_CONFIG.confidenceThreshold,
      maxAutoInvokes: config.autoInvoke?.maxAutoInvokes ?? DEFAULT_CONFIG.maxAutoInvokes,
      cooldownMs: config.autoInvoke?.cooldownMs ?? DEFAULT_CONFIG.cooldownMs,
    };
  } catch (error) {
    console.error('[auto-invoke] Failed to load config:', error);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Initialize auto-invoke state for a session
 */
export function initAutoInvoke(sessionId: string): AutoInvokeState {
  return {
    sessionId,
    config: loadInvocationConfig(),
    invocations: [],
    lastInvokeTime: 0,
  };
}

/**
 * Decide whether to auto-invoke a skill based on confidence and constraints
 */
export function shouldAutoInvoke(
  state: AutoInvokeState,
  skillId: string,
  confidence: number
): boolean {
  const { config, invocations, lastInvokeTime } = state;

  // Check if auto-invoke is enabled
  if (!config.enabled) {
    return false;
  }

  // Check confidence threshold
  if (confidence < config.confidenceThreshold) {
    return false;
  }

  // Check max invocations per session
  if (invocations.length >= config.maxAutoInvokes) {
    return false;
  }

  // Check cooldown
  const now = Date.now();
  if (now - lastInvokeTime < config.cooldownMs) {
    return false;
  }

  // Check if this skill was already invoked in this session
  const alreadyInvoked = invocations.some(inv => inv.skillId === skillId);
  if (alreadyInvoked) {
    return false;
  }

  return true;
}

/**
 * Record a skill invocation
 */
export function recordInvocation(
  state: AutoInvokeState,
  record: Omit<InvocationRecord, 'timestamp'>
): void {
  state.invocations.push({
    ...record,
    timestamp: Date.now(),
  });
  state.lastInvokeTime = Date.now();
}

/**
 * Update the success status of a skill invocation
 */
export function updateInvocationSuccess(
  state: AutoInvokeState,
  skillId: string,
  wasSuccessful: boolean
): void {
  // Update the most recent invocation of this skill
  const invocation = [...state.invocations]
    .reverse()
    .find(inv => inv.skillId === skillId);

  if (invocation) {
    invocation.wasSuccessful = wasSuccessful;
  }
}

/**
 * Format skill for auto-invocation (more prominent than passive injection)
 */
export function formatAutoInvoke(skill: {
  name: string;
  content: string;
  confidence: number;
}): string {
  return `
<auto_invoke_skill>
HIGH CONFIDENCE MATCH (${skill.confidence.toFixed(1)}%) - AUTO-INVOKING SKILL

SKILL: ${skill.name}
CONFIDENCE: ${skill.confidence.toFixed(1)}%
STATUS: AUTOMATICALLY INVOKED

${skill.content}

INSTRUCTION: This skill has been automatically invoked due to high confidence match.
Please follow the skill's instructions immediately.
</auto_invoke_skill>
`;
}

/**
 * Get invocation statistics for the session
 */
export function getInvocationStats(state: AutoInvokeState): {
  total: number;
  successful: number;
  failed: number;
  unknown: number;
  averageConfidence: number;
} {
  const { invocations } = state;

  const successful = invocations.filter(inv => inv.wasSuccessful === true).length;
  const failed = invocations.filter(inv => inv.wasSuccessful === false).length;
  const unknown = invocations.filter(inv => inv.wasSuccessful === null).length;

  const averageConfidence = invocations.length > 0
    ? invocations.reduce((sum, inv) => sum + inv.confidence, 0) / invocations.length
    : 0;

  return {
    total: invocations.length,
    successful,
    failed,
    unknown,
    averageConfidence,
  };
}

/**
 * Save invocation history to disk for analytics
 */
export function saveInvocationHistory(state: AutoInvokeState): void {
  const historyDir = path.join(os.homedir(), '.omc', 'analytics', 'invocations');
  const historyFile = path.join(historyDir, `${state.sessionId}.json`);

  // Use atomic write to prevent corruption from concurrent sessions (Bug #11 fix)
  atomicWriteJson(historyFile, {
    sessionId: state.sessionId,
    config: state.config,
    invocations: state.invocations,
    stats: getInvocationStats(state),
  }).catch(error => {
    console.error('[auto-invoke] Failed to save invocation history:', error);
  });
}

/**
 * Load invocation history from disk
 */
export function loadInvocationHistory(sessionId: string): AutoInvokeState | null {
  const historyFile = path.join(
    os.homedir(),
    '.omc',
    'analytics',
    'invocations',
    `${sessionId}.json`
  );

  try {
    if (!fs.existsSync(historyFile)) {
      return null;
    }

    const data = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
    return {
      sessionId: data.sessionId,
      config: data.config,
      invocations: data.invocations,
      lastInvokeTime: data.invocations.length > 0
        ? Math.max(...data.invocations.map((inv: InvocationRecord) => inv.timestamp))
        : 0,
    };
  } catch (error) {
    console.error('[auto-invoke] Failed to load invocation history:', error);
    return null;
  }
}

/**
 * Get aggregated invocation analytics across all sessions
 */
export function getAggregatedStats(): {
  totalSessions: number;
  totalInvocations: number;
  successRate: number;
  topSkills: Array<{ skillId: string; skillName: string; count: number; successRate: number }>;
} {
  const historyDir = path.join(os.homedir(), '.omc', 'analytics', 'invocations');

  try {
    if (!fs.existsSync(historyDir)) {
      return {
        totalSessions: 0,
        totalInvocations: 0,
        successRate: 0,
        topSkills: [],
      };
    }

    const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
    const allInvocations: InvocationRecord[] = [];
    const skillStats = new Map<string, { name: string; total: number; successful: number }>();

    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(historyDir, file), 'utf-8'));
      allInvocations.push(...data.invocations);

      for (const inv of data.invocations as InvocationRecord[]) {
        const existing = skillStats.get(inv.skillId) || { name: inv.skillName, total: 0, successful: 0 };
        existing.total++;
        if (inv.wasSuccessful === true) {
          existing.successful++;
        }
        skillStats.set(inv.skillId, existing);
      }
    }

    const successful = allInvocations.filter(inv => inv.wasSuccessful === true).length;
    const withKnownStatus = allInvocations.filter(inv => inv.wasSuccessful !== null).length;

    const topSkills = Array.from(skillStats.entries())
      .map(([skillId, stats]) => ({
        skillId,
        skillName: stats.name,
        count: stats.total,
        successRate: stats.total > 0 ? (stats.successful / stats.total) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalSessions: files.length,
      totalInvocations: allInvocations.length,
      successRate: withKnownStatus > 0 ? (successful / withKnownStatus) * 100 : 0,
      topSkills,
    };
  } catch (error) {
    console.error('[auto-invoke] Failed to get aggregated stats:', error);
    return {
      totalSessions: 0,
      totalInvocations: 0,
      successRate: 0,
      topSkills: [],
    };
  }
}
