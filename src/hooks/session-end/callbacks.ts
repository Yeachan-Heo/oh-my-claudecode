/**
 * Stop Hook Callbacks
 *
 * Provides configurable callback handlers for session end events.
 * Supports file logging only. External notification integrations
 * (Telegram, Discord, Slack) have been removed for security hardening.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, normalize } from 'path';
import { homedir } from 'os';
import type { SessionMetrics } from './index.js';
import {
  getOMCConfig,
  type StopCallbackFileConfig,
} from '../../features/auto-update.js';

/**
 * Format session summary for notifications
 */
export function formatSessionSummary(metrics: SessionMetrics, format: 'markdown' | 'json' = 'markdown'): string {
  if (format === 'json') {
    return JSON.stringify(metrics, null, 2);
  }

  const duration = metrics.duration_ms
    ? `${Math.floor(metrics.duration_ms / 1000 / 60)}m ${Math.floor((metrics.duration_ms / 1000) % 60)}s`
    : 'unknown';

  return `# Session Ended

**Session ID:** \`${metrics.session_id}\`
**Duration:** ${duration}
**Reason:** ${metrics.reason}
**Agents Spawned:** ${metrics.agents_spawned}
**Agents Completed:** ${metrics.agents_completed}
**Modes Used:** ${metrics.modes_used.length > 0 ? metrics.modes_used.join(', ') : 'none'}
**Started At:** ${metrics.started_at || 'unknown'}
**Ended At:** ${metrics.ended_at}
`.trim();
}

export interface TriggerStopCallbacksOptions {
  skipPlatforms?: Array<'file'>;
}

/**
 * Interpolate path placeholders
 */
export function interpolatePath(pathTemplate: string, sessionId: string): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const time = now.toISOString().split('T')[1].split('.')[0].replace(/:/g, '-'); // HH-MM-SS

  // Sanitize session_id: remove path separators and traversal sequences
  const safeSessionId = sessionId.replace(/[/\\..]/g, '_');

  return normalize(pathTemplate
    .replace(/~/g, homedir())
    .replace(/\{session_id\}/g, safeSessionId)
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time));
}

/**
 * File system callback - write session summary to file
 */
async function writeToFile(
  config: StopCallbackFileConfig,
  content: string,
  sessionId: string
): Promise<void> {
  try {
    const resolvedPath = interpolatePath(config.path, sessionId);
    const dir = dirname(resolvedPath);

    // Ensure directory exists
    mkdirSync(dir, { recursive: true });

    // Write file with restricted permissions (owner read/write only)
    writeFileSync(resolvedPath, content, { encoding: 'utf-8', mode: 0o600 });
    console.log(`[stop-callback] Session summary written to ${resolvedPath}`);
  } catch (error) {
    console.error('[stop-callback] File write failed:', error);
    // Don't throw - callback failures shouldn't block session end
  }
}

/**
 * Main callback trigger - called from session-end hook
 *
 * Executes all enabled callbacks in parallel with a timeout.
 * Failures in individual callbacks don't block session end.
 */
export async function triggerStopCallbacks(
  metrics: SessionMetrics,
  _input: { session_id: string; cwd: string },
  options: TriggerStopCallbacksOptions = {}
): Promise<void> {
  const config = getOMCConfig();
  const callbacks = config.stopHookCallbacks;
  const skipPlatforms = new Set(options.skipPlatforms ?? []);

  if (!callbacks) {
    return; // No callbacks configured
  }

  // Execute all enabled callbacks (non-blocking)
  const promises: Promise<void>[] = [];

  if (!skipPlatforms.has('file') && callbacks.file?.enabled && callbacks.file.path) {
    const format = callbacks.file.format || 'markdown';
    const summary = formatSessionSummary(metrics, format);
    promises.push(writeToFile(callbacks.file, summary, metrics.session_id));
  }

  if (promises.length === 0) {
    return; // No enabled callbacks
  }

  // Wait for all callbacks with a 5-second timeout
  // This ensures callbacks don't block session end indefinitely
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch (error) {
    // Swallow any errors - callbacks should never block session end
    console.error('[stop-callback] Callback execution error:', error);
  }
}
