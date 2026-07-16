#!/usr/bin/env node

/**
 * Skill Injector Hook (UserPromptSubmit)
 * Injects relevant learned skills into context based on prompt triggers.
 *
 * STANDALONE SCRIPT - uses compiled bridge bundle from dist/hooks/skill-bridge.cjs
 * Falls back to inline implementation if bundle not available (first run before build)
 *
 * Enhancement in v3.5: Now uses RECURSIVE discovery (skills in subdirectories included)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, openSync, closeSync, unlinkSync, writeSync, constants as fsConstants } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { readStdin } from './lib/stdin.mjs';
import { createRequire } from 'module';
import { atomicWriteFileSync, ensureDirSync } from './lib/atomic-write.mjs';

const skipHooks = (process.env.OMC_SKIP_HOOKS || '').split(',').map(token => token.trim());
const isDisabled = process.env.DISABLE_OMC === '1' ||
  process.env.DISABLE_OMC === 'true' ||
  skipHooks.includes('skill-injector');

let bridge = null;
let USER_SKILLS_DIR;
let GLOBAL_SKILLS_DIR;
let PROJECT_SKILLS_SUBDIR;
let SKILL_EXTENSION;
let MAX_SKILLS_PER_SESSION;
let MAX_LEARNED_SKILL_DESCRIPTOR_CHARS;
let MAX_LEARNED_SKILLS_CONTEXT_CHARS;


// ============================================================================
// Session ID resolution (mirrors src/lib/session-id.ts — inlined for .mjs)
// Precedence in hook context: payload wins over env var.
// ============================================================================

/**
 * Resolve the session id for hook context.
 * Payload session_id takes priority; falls back to OMC_SESSION_ID env var.
 *
 * @param {object|null} hookPayload - Parsed stdin payload (may be null)
 * @returns {string|undefined}
 */
function resolveHookSessionId(hookPayload) {
  const payloadId =
    hookPayload &&
    typeof hookPayload === 'object' &&
    typeof hookPayload.session_id === 'string' &&
    hookPayload.session_id.trim()
      ? hookPayload.session_id.trim()
      : undefined;

  const envId =
    process.env.OMC_SESSION_ID && process.env.OMC_SESSION_ID.trim()
      ? process.env.OMC_SESSION_ID.trim()
      : undefined;

  return payloadId ?? envId;
}

// ============================================================================
// Session ID validation (mirrors src/lib/worktree-paths.ts)
// ============================================================================

const SESSION_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

/**
 * Validate session id to prevent path traversal.
 * Returns the id if valid, undefined otherwise.
 *
 * @param {string|undefined} sessionId
 * @returns {string|undefined}
 */
function validateSessionId(sessionId) {
  if (!sessionId) return undefined;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) return undefined;
  if (!SESSION_ID_REGEX.test(sessionId)) return undefined;
  return sessionId;
}

// ============================================================================
// OMC root resolver — walk up from cwd looking for workspace markers.
// Mirrors getOmcRoot from src/lib/worktree-paths.ts — inlined for .mjs.
// ============================================================================

/**
 * Walk up from startDir looking for .omc-workspace, then .git, then fallback
 * to startDir itself. Returns the .omc subdirectory of the found root.
 * Mirrors getOmcRoot from src/lib/worktree-paths.ts — inlined synchronously for .mjs.
 *
 * NOTE: OMC_STATE_DIR with content-hash is handled asynchronously in state-root.mjs.
 * This inline sync resolver skips OMC_STATE_DIR and always uses the walk-up result,
 * which is correct for the fallback path (bridge handles OMC_STATE_DIR when available).
 *
 * @param {string} startDir - Directory to start from (data.cwd)
 * @returns {string} Absolute path to the .omc root directory
 */
function resolveOmcRootSync(startDir) {
  let dir = startDir;

  // Walk up looking for .omc-workspace or .git
  while (dir) {
    if (existsSync(join(dir, '.omc-workspace'))) {
      return join(dir, '.omc');
    }
    if (existsSync(join(dir, '.git'))) {
      return join(dir, '.omc');
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root reached
    dir = parent;
  }

  // Fallback: use startDir
  return join(startDir, '.omc');
}

// ============================================================================
// State path resolution for skill-sessions fallback
// ============================================================================

/**
 * Resolve the skill-sessions-fallback state file path.
 * Session-scoped: <omcRoot>/state/sessions/<sid>/skill-sessions-fallback-state.json
 * Legacy:         <omcRoot>/state/skill-sessions-fallback.json
 *
 * @param {string} omcRoot - Resolved .omc root directory
 * @param {string|undefined} sessionId - Validated session id (or undefined)
 * @returns {{ statePath: string, stateDir: string }}
 */
function resolveSkillFallbackStatePaths(omcRoot, sessionId) {
  if (sessionId) {
    const sessionDir = join(omcRoot, 'state', 'sessions', sessionId);
    return {
      stateDir: sessionDir,
      statePath: join(sessionDir, 'skill-sessions-fallback-state.json'),
    };
  }
  const stateDir = join(omcRoot, 'state');
  return {
    stateDir,
    statePath: join(stateDir, 'skill-sessions-fallback.json'),
  };
}

// ============================================================================
// Inline file lock (mirrors src/lib/file-lock.ts — O_CREAT|O_EXCL pattern)
// No TS import available in .mjs; implement the same algorithm inline.
// NOTE: This block is intentionally duplicated from post-tool-use-failure.mjs.
// No shared .mjs lock helper exists for hooks; do not factor out without first creating one.
// ============================================================================

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_TIMEOUT_MS = 2_000;

/**
 * Derive lock file path for a given data file.
 * @param {string} filePath
 * @returns {string}
 */
function lockPathFor(filePath) {
  return filePath + '.lock';
}

/**
 * Check whether an existing lock file is stale (old + dead PID).
 * @param {string} lockPath
 * @returns {boolean}
 */
function isLockStale(lockPath) {
  try {
    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < LOCK_STALE_MS) return false;
    try {
      const raw = readFileSync(lockPath, 'utf-8');
      const payload = JSON.parse(raw);
      if (payload.pid) {
        try { process.kill(payload.pid, 0); return false; } catch { /* dead */ }
      }
    } catch { /* malformed — stale if old enough */ }
    return true;
  } catch {
    return false; // disappeared
  }
}

/**
 * Try to acquire the lock once (single O_CREAT|O_EXCL attempt).
 * @param {string} lockPath
 * @returns {{fd: number, path: string}|null}
 */
function tryAcquireLockSync(lockPath) {
  ensureDirSync(dirname(lockPath));
  try {
    const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), null, 'utf-8');
    } catch (writeErr) {
      try { closeSync(fd); } catch { /* ignore */ }
      try { unlinkSync(lockPath); } catch { /* ignore */ }
      throw writeErr;
    }
    return { fd, path: lockPath };
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      if (isLockStale(lockPath)) {
        try { unlinkSync(lockPath); } catch { /* another process reaped it */ }
        try {
          const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
          try {
            writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), null, 'utf-8');
          } catch (writeErr) {
            try { closeSync(fd); } catch { /* ignore */ }
            try { unlinkSync(lockPath); } catch { /* ignore */ }
            throw writeErr;
          }
          return { fd, path: lockPath };
        } catch {
          return null;
        }
      }
      return null;
    }
    throw err;
  }
}

/**
 * Release a previously acquired lock handle.
 * @param {{fd: number, path: string}} handle
 */
function releaseLockSync(handle) {
  try { closeSync(handle.fd); } catch { /* ignore */ }
  try { unlinkSync(handle.path); } catch { /* ignore */ }
}

/**
 * Execute fn while holding an exclusive file lock.
 * Falls back to executing fn without a lock if lock cannot be acquired
 * (hook must never fail silently).
 *
 * @param {string} lockPath
 * @param {() => void} fn
 */
function withFileLockSync(lockPath, fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle = tryAcquireLockSync(lockPath);

  if (!handle) {
    while (!handle && Date.now() < deadline) {
      const waitUntil = Math.min(Date.now() + LOCK_RETRY_DELAY_MS, deadline);
      while (Date.now() < waitUntil) { /* spin */ }
      handle = tryAcquireLockSync(lockPath);
    }
  }

  if (!handle) {
    fn();
    return;
  }

  try {
    fn();
  } finally {
    releaseLockSync(handle);
  }
}

// Constants (used by fallback)
// Initialized only after the early disable decision.

// =============================================================================
// Fallback Implementation (used when bridge bundle not available)
// =============================================================================

// File-based session dedup for fallback path (issue #2577 bug 1).
// UserPromptSubmit spawns a NEW Node.js process on every prompt turn, so an
// in-memory Map always starts empty — skills were re-injected on every turn.
// Persisting to a session-scoped JSON state file preserves the injected-set
// across process spawns, matching bridge behaviour.
// Storage: {omcRoot}/state/sessions/{sid}/skill-sessions-fallback-state.json
// Legacy (no sessionId): {omcRoot}/state/skill-sessions-fallback.json
const FALLBACK_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour (same as bridge)

function readFallbackState(statePath) {
  try {
    if (existsSync(statePath)) {
      return JSON.parse(readFileSync(statePath, 'utf-8'));
    }
  } catch { /* ignore read/parse errors */ }
  return { sessions: {} };
}

function writeFallbackState(stateDir, statePath, state) {
  try {
    mkdirSync(stateDir, { recursive: true });
    atomicWriteFileSync(statePath, JSON.stringify(state, null, 2));
  } catch { /* non-critical — dedup fails open */ }
}

// Parse YAML frontmatter from skill file (fallback)
function parseSkillFrontmatterFallback(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const yamlContent = match[1];
  const body = match[2].trim();

  // Simple YAML parsing for triggers
  const triggers = [];
  const triggerMatch = yamlContent.match(/triggers:\s*\n((?:\s+-\s*.+\n?)*)/);
  if (triggerMatch) {
    const lines = triggerMatch[1].split('\n');
    for (const line of lines) {
      const itemMatch = line.match(/^\s+-\s*["']?([^"'\n]+)["']?\s*$/);
      if (itemMatch) triggers.push(itemMatch[1].trim().toLowerCase());
    }
  }

  // Extract name and description
  const nameMatch = yamlContent.match(/name:\s*["']?([^"'\n]+)["']?/);
  const name = nameMatch ? nameMatch[1].trim() : 'Unnamed Skill';
  const descriptionMatch = yamlContent.match(/description:\s*["']?([^"'\n]+)["']?/);
  const description = descriptionMatch ? descriptionMatch[1].trim() : summarizeSkillContent(body);

  return { name, description, triggers, content: body };
}

// Find all skill files (fallback - NON-RECURSIVE for backward compat)
function findSkillFilesFallback(directory) {
  const candidates = [];
  const seenPaths = new Set();

  // Project-level skills (higher priority)
  const projectDir = join(directory, PROJECT_SKILLS_SUBDIR);
  if (existsSync(projectDir)) {
    try {
      const files = readdirSync(projectDir, { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && file.name.endsWith(SKILL_EXTENSION)) {
          const fullPath = join(projectDir, file.name);
          try {
            const realPath = realpathSync(fullPath);
            if (!seenPaths.has(realPath)) {
              seenPaths.add(realPath);
              candidates.push({ path: fullPath, scope: 'project' });
            }
          } catch {
            // Ignore symlink resolution errors
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  // User-level skills (search both global and legacy directories)
  const userDirs = [GLOBAL_SKILLS_DIR, USER_SKILLS_DIR];
  for (const userDir of userDirs) {
    if (existsSync(userDir)) {
      try {
        const files = readdirSync(userDir, { withFileTypes: true });
        for (const file of files) {
          if (file.isFile() && file.name.endsWith(SKILL_EXTENSION)) {
            const fullPath = join(userDir, file.name);
            try {
              const realPath = realpathSync(fullPath);
              if (!seenPaths.has(realPath)) {
                seenPaths.add(realPath);
                candidates.push({ path: fullPath, scope: 'user' });
              }
            } catch {
              // Ignore symlink resolution errors
            }
          }
        }
      } catch {
        // Ignore directory read errors
      }
    }
  }

  return candidates;
}

// Find matching skills (fallback)
function findMatchingSkillsFallback(prompt, directory, sessionId, omcRoot) {
  const promptLower = prompt.toLowerCase();
  const candidates = findSkillFilesFallback(directory);
  const matches = [];

  // Resolve session-scoped (or legacy) state file paths
  const { stateDir, statePath } = resolveSkillFallbackStatePaths(omcRoot, sessionId);
  const lockPath = lockPathFor(statePath);

  // Score candidates outside the lock (read-only file access, no shared state)
  for (const candidate of candidates) {
    try {
      const content = readFileSync(candidate.path, 'utf-8');
      const skill = parseSkillFrontmatterFallback(content);
      if (!skill) continue;

      let score = 0;
      for (const trigger of skill.triggers) {
        if (promptLower.includes(trigger)) {
          score += 10;
        }
      }

      if (score > 0) {
        matches.push({
          path: candidate.path,
          name: skill.name,
          content: skill.content,
          description: skill.description,
          summary: summarizeSkillContent(skill.content),
          score,
          scope: candidate.scope,
          triggers: skill.triggers
        });
      }
    } catch {
      // Ignore file read errors
    }
  }

  matches.sort((a, b) => b.score - a.score);

  // Read-compute-write under lock to prevent concurrent dedup corruption
  const selected = [];
  withFileLockSync(lockPath, () => {
    const state = readFallbackState(statePath);
    const now = Date.now();

    // Prune expired sessions to keep the state file small
    for (const [id, sess] of Object.entries(state.sessions)) {
      if (now - sess.timestamp > FALLBACK_SESSION_TTL_MS) {
        delete state.sessions[id];
      }
    }

    const sessionData = state.sessions[sessionId];
    const alreadyInjected = new Set(
      sessionData && now - sessionData.timestamp <= FALLBACK_SESSION_TTL_MS
        ? (sessionData.injectedPaths ?? [])
        : []
    );

    // Filter out already-injected, then limit
    const newMatches = matches
      .filter(m => !alreadyInjected.has(m.path))
      .slice(0, MAX_SKILLS_PER_SESSION);

    // Persist injected paths back to file so future process spawns skip them
    if (newMatches.length > 0) {
      const existing = state.sessions[sessionId]?.injectedPaths ?? [];
      state.sessions[sessionId] = {
        injectedPaths: [...new Set([...existing, ...newMatches.map(s => s.path)])],
        timestamp: now,
      };
      writeFallbackState(stateDir, statePath, state);
    }

    selected.push(...newMatches);
  });

  return selected;
}

// =============================================================================
// Main Logic (uses bridge if available, fallback otherwise)
// =============================================================================

// Find matching skills - delegates to bridge or fallback
function findMatchingSkills(prompt, directory, sessionId, omcRoot) {
  if (bridge) {
    // Use bridge (RECURSIVE discovery, persistent session cache)
    const matches = bridge.matchSkillsForInjection(prompt, directory, sessionId, {
      maxResults: MAX_SKILLS_PER_SESSION
    });

    // Mark as injected via bridge
    if (matches.length > 0) {
      bridge.markSkillsInjected(sessionId, matches.map(s => s.path), directory);
    }

    return matches;
  }

  // Fallback (NON-RECURSIVE, file-based dedup via session-scoped state file)
  return findMatchingSkillsFallback(prompt, directory, sessionId, omcRoot);
}

function compactText(text, maxChars) {
  if (!text || maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return '…';
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function summarizeSkillContent(content) {
  if (!content) return '';
  const firstUsefulLine = content
    .split(/\r?\n/)
    .map(line => line.replace(/^#+\s*/, '').trim())
    .find(line => line && !line.startsWith('---'));
  return compactText(firstUsefulLine || content.replace(/\s+/g, ' ').trim(), 240);
}

function formatSkillDescriptor(skill) {
  const metadata = {
    path: skill.path,
    triggers: skill.triggers,
    score: skill.score,
    scope: skill.scope
  };
  const summary = skill.description || skill.summary || summarizeSkillContent(skill.content);
  return compactText([
    `### ${skill.name} (${skill.scope})`,
    `<skill-metadata>${JSON.stringify(metadata)}</skill-metadata>`,
    summary ? `Summary: ${summary}` : '',
    `Load instructions: if this skill is needed, read ${skill.path} and follow the full instructions there.`,
  ].filter(Boolean).join('\n'), MAX_LEARNED_SKILL_DESCRIPTOR_CHARS);
}

// Format skills for injection
function formatSkillsMessage(skills) {
  const header = [
    '<mnemosyne>',
    '',
    '## Relevant Learned Skills',
    '',
    'Compact descriptors only; full learned skill bodies stay on disk to avoid prompt bloat.',
    ''
  ].join('\n');
  const footer = '\n</mnemosyne>';
  const budget = MAX_LEARNED_SKILLS_CONTEXT_CHARS - header.length - footer.length;
  const descriptors = [];
  let used = 0;

  for (const skill of skills) {
    const descriptor = formatSkillDescriptor(skill);
    const separator = descriptors.length > 0 ? '\n\n---\n\n' : '';
    if (used + separator.length + descriptor.length > budget) {
      const omission = `${separator}[Additional learned skills omitted due to ${MAX_LEARNED_SKILLS_CONTEXT_CHARS}-character context budget; use skill metadata paths if needed.]`;
      const remainingBudget = budget - used;
      if (remainingBudget > 0) {
        descriptors.push(compactText(omission, remainingBudget));
      }
      break;
    }
    descriptors.push(`${separator}${descriptor}`);
    used += separator.length + descriptor.length;
  }

  return `${header}${descriptors.join('')}${footer}`;
}

// Main
async function main() {
  try {
    const input = await readStdin();
    if (!input.trim()) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    let data = {};
    try { data = JSON.parse(input); } catch { /* ignore parse errors */ }

    const prompt = data.prompt || '';
    const directory = data.cwd || process.cwd();

    // Resolve session id: payload wins over env var (hook context)
    const rawSessionId = resolveHookSessionId(data);
    const sessionId = validateSessionId(rawSessionId) ?? (data.session_id || data.sessionId || 'unknown');

    // Resolve OMC root (walk up from data.cwd looking for workspace markers)
    const omcRoot = resolveOmcRootSync(directory);

    // Skip if no prompt
    if (!prompt) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const matchingSkills = findMatchingSkills(prompt, directory, sessionId, omcRoot);

    // Record skill activations to flow trace (best-effort)
    if (matchingSkills.length > 0) {
      try {
        const { recordSkillActivated } = await import('../dist/hooks/subagent-tracker/flow-tracer.js');
        for (const skill of matchingSkills) {
          recordSkillActivated(directory, sessionId, skill.name, skill.scope || 'learned');
        }
      } catch { /* silent - trace is best-effort */ }
    }

    if (matchingSkills.length > 0) {
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: formatSkillsMessage(matchingSkills)
        }
      }));
    } else {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    }
  } catch (error) {
    // On any error, allow continuation
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

if (isDisabled) {
  console.log(JSON.stringify({ continue: true }));
} else {
  const require = createRequire(import.meta.url);
  try {
    bridge = require('../dist/hooks/skill-bridge.cjs');
  } catch {
    // Bridge not available - use fallback (first run before build, or dist/ missing)
  }

  const cfgDir = getClaudeConfigDir();
  USER_SKILLS_DIR = join(cfgDir, 'skills', 'omc-learned');
  GLOBAL_SKILLS_DIR = join(homedir(), '.omc', 'skills');
  PROJECT_SKILLS_SUBDIR = join('.omc', 'skills');
  SKILL_EXTENSION = '.md';
  MAX_SKILLS_PER_SESSION = 5;
  MAX_LEARNED_SKILL_DESCRIPTOR_CHARS = 1000;
  MAX_LEARNED_SKILLS_CONTEXT_CHARS = 3000;
  main();
}
