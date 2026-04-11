/**
 * Setup State Machine
 *
 * Port of scripts/setup-progress.sh to TypeScript.
 * Provides save/clear/resume/complete operations for setup wizard progress.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getClaudeConfigDir } from '../utils/config-dir.js';

const STATE_SUBPATH = '.omc/state/setup-state.json';
const SESSION_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const TTL_MS = 86400 * 1000; // 24 hours
const STALE_SESSION_MS = 30 * 60 * 1000; // 30 minutes

interface StateFile {
  lastCompletedStep: number;
  timestamp: string;
  configType: string;
}

interface OmcConfig {
  [key: string]: unknown;
  setupCompleted?: string;
  setupVersion?: string;
}

export type ResumeResult =
  | { status: 'fresh' }
  | { status: 'resume'; lastStep: number; timestamp: string; configType: string };

/**
 * Write JSON atomically using a tempfile + rename pattern.
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Save setup progress to .omc/state/setup-state.json.
 * Creates the directory recursively if missing.
 */
export function saveState(
  step: number,
  configType: string,
  opts?: { cwd?: string },
): void {
  const cwd = opts?.cwd ?? process.cwd();
  const stateFile = join(cwd, STATE_SUBPATH);

  const state: StateFile = {
    lastCompletedStep: step,
    timestamp: new Date().toISOString(),
    configType,
  };

  atomicWriteJson(stateFile, state);
  console.log(`Progress saved: step ${step} (${configType})`);
}

/**
 * Remove .omc/state/setup-state.json if it exists. Silent no-op if missing.
 */
export function clearState(opts?: { cwd?: string }): void {
  const cwd = opts?.cwd ?? process.cwd();
  const stateFile = join(cwd, STATE_SUBPATH);

  if (existsSync(stateFile)) {
    unlinkSync(stateFile);
  }
  console.log('Setup state cleared.');
}

/**
 * Check for existing setup progress.
 * Returns fresh if missing, corrupted, stale (>24h), or missing timestamp.
 * Returns resume data if valid and within TTL.
 */
export function resumeState(opts?: { cwd?: string }): ResumeResult {
  const cwd = opts?.cwd ?? process.cwd();
  const stateFile = join(cwd, STATE_SUBPATH);

  if (!existsSync(stateFile)) {
    return { status: 'fresh' };
  }

  let parsed: Partial<StateFile>;
  try {
    const raw = readFileSync(stateFile, 'utf8');
    parsed = JSON.parse(raw) as Partial<StateFile>;
  } catch {
    return { status: 'fresh' };
  }

  // Missing timestamp → force fresh
  if (!parsed.timestamp) {
    unlinkSync(stateFile);
    return { status: 'fresh' };
  }

  // 24-hour TTL check
  const savedTime = new Date(parsed.timestamp).getTime();
  if (Number.isNaN(savedTime) || savedTime === 0) {
    unlinkSync(stateFile);
    return { status: 'fresh' };
  }

  const ageMs = Date.now() - savedTime;
  if (ageMs > TTL_MS) {
    console.log('Previous setup state is more than 24 hours old. Starting fresh.');
    unlinkSync(stateFile);
    return { status: 'fresh' };
  }

  const lastStep = parsed.lastCompletedStep ?? 0;
  const configType = parsed.configType ?? 'unknown';
  console.log(
    `Found previous setup session (Step ${lastStep} completed at ${parsed.timestamp}, configType=${configType})`,
  );

  return {
    status: 'resume',
    lastStep,
    timestamp: parsed.timestamp,
    configType,
  };
}

/**
 * Recursively find all files matching a name under a directory.
 */
function findFiles(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];

  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry === name) {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Mark setup as complete:
 * - Deletes the in-progress state file
 * - Cleans up skill-active-state for the current session (or stale fallback)
 * - Shallow-merges setupCompleted + setupVersion into .omc-config.json
 */
export function completeSetup(
  version: string,
  opts?: { cwd?: string; configDir?: string },
): void {
  const cwd = opts?.cwd ?? process.cwd();
  const configDir = opts?.configDir ?? getClaudeConfigDir();
  const stateFile = join(cwd, STATE_SUBPATH);

  // Delete the in-progress state file
  if (existsSync(stateFile)) {
    unlinkSync(stateFile);
  }

  // Session-scoped skill-active-state cleanup
  const rawSid =
    process.env['CLAUDE_SESSION_ID'] ?? process.env['CLAUDECODE_SESSION_ID'] ?? '';

  if (rawSid && SESSION_ID_REGEX.test(rawSid)) {
    // Valid session ID: delete only that session's file
    const sessionFile = join(
      cwd,
      '.omc/state/sessions',
      rawSid,
      'skill-active-state.json',
    );
    if (existsSync(sessionFile)) {
      unlinkSync(sessionFile);
    }
  } else {
    // No (or invalid) session ID: delete only files with mtime > 30 min old
    const stateDir = join(cwd, '.omc/state');
    const staleFiles = findFiles(stateDir, 'skill-active-state.json');
    const now = Date.now();
    for (const f of staleFiles) {
      try {
        const { mtimeMs } = statSync(f);
        if (now - mtimeMs > STALE_SESSION_MS) {
          unlinkSync(f);
        }
      } catch {
        /* ignore */
      }
    }
  }

  // Shallow-merge setupCompleted + setupVersion into .omc-config.json
  const configFile = join(configDir, '.omc-config.json');
  let existing: OmcConfig = {};
  if (existsSync(configFile)) {
    try {
      existing = JSON.parse(readFileSync(configFile, 'utf8')) as OmcConfig;
    } catch {
      existing = {};
    }
  }

  const updated: OmcConfig = {
    ...existing,
    setupCompleted: new Date().toISOString(),
    setupVersion: version,
  };

  mkdirSync(dirname(configFile), { recursive: true });
  atomicWriteJson(configFile, updated);

  console.log('Setup completed successfully!');
  console.log('Note: Future updates will only refresh CLAUDE.md, not the full setup wizard.');
}
