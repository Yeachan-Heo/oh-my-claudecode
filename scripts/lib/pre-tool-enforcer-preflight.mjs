import { closeSync, openSync, readSync, statSync } from 'fs';

const AGENT_HEAVY_TOOLS = new Set(['Task', 'TaskCreate', 'TaskUpdate']);
const DEFAULT_PREFLIGHT_CONTEXT_THRESHOLD = 72;

export function getPreflightContextThreshold(env = process.env) {
  const parsed = Number.parseInt(env.OMC_AGENT_PREFLIGHT_CONTEXT_THRESHOLD || '72', 10);
  if (Number.isNaN(parsed)) return DEFAULT_PREFLIGHT_CONTEXT_THRESHOLD;
  return Math.max(1, Math.min(100, parsed));
}

export function estimateContextPercent(transcriptPath) {
  if (!transcriptPath) return 0;

  let fd = -1;
  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0) return 0;

    fd = openSync(transcriptPath, 'r');
    const readSize = Math.min(4096, stat.size);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, stat.size - readSize);
    closeSync(fd);
    fd = -1;

    const tail = buf.toString('utf-8');
    const windowMatch = tail.match(/"context_window"\s{0,5}:\s{0,5}(\d+)/g);
    const inputMatch = tail.match(/"input_tokens"\s{0,5}:\s{0,5}(\d+)/g);

    if (!windowMatch || !inputMatch) return 0;

    const lastWindow = parseInt(windowMatch[windowMatch.length - 1].match(/(\d+)/)[1], 10);
    const lastInput = parseInt(inputMatch[inputMatch.length - 1].match(/(\d+)/)[1], 10);

    if (lastWindow === 0) return 0;
    return Math.round((lastInput / lastWindow) * 100);
  } catch {
    return 0;
  } finally {
    if (fd !== -1) try { closeSync(fd); } catch { /* ignore */ }
  }
}

export function buildPreflightRecoveryAdvice(contextPercent, threshold = DEFAULT_PREFLIGHT_CONTEXT_THRESHOLD) {
  return `[OMC] Preflight context guard: ${contextPercent}% used ` +
    `(threshold: ${threshold}%). Avoid spawning additional agent-heavy tasks ` +
    `until context is reduced. Safe recovery: (1) pause new Task fan-out, (2) run /compact now, ` +
    `(3) if compact fails, open a fresh session and continue from .omc/state + .omc/notepad.md.`;
}

export function evaluateAgentHeavyPreflight({ toolName, transcriptPath, env = process.env }) {
  if (!AGENT_HEAVY_TOOLS.has(toolName)) return null;

  const threshold = getPreflightContextThreshold(env);
  const contextPercent = estimateContextPercent(transcriptPath);
  if (contextPercent < threshold) return null;

  return {
    decision: 'block',
    reason: buildPreflightRecoveryAdvice(contextPercent, threshold),
  };
}
