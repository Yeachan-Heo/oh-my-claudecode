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

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { readStdin } from './lib/stdin.mjs';
import { createRequire } from 'module';

// Try to load the compiled bridge bundle
const require = createRequire(import.meta.url);
let bridge = null;
try {
  bridge = require('../dist/hooks/skill-bridge.cjs');
} catch {
  // Bridge not available - use fallback (first run before build, or dist/ missing)
}

// Constants (used by fallback)
const cfgDir = getClaudeConfigDir();
const USER_SKILLS_DIR = join(cfgDir, 'skills', 'omc-learned');
const GLOBAL_SKILLS_DIR = join(homedir(), '.omc', 'skills');
const PROJECT_SKILLS_SUBDIR = join('.omc', 'skills');
const SKILL_EXTENSION = '.md';
const MAX_SKILLS_PER_SESSION = 5;
const MAX_LEARNED_SKILL_DESCRIPTOR_CHARS = 1000;
const MAX_LEARNED_SKILLS_CONTEXT_CHARS = 3000;

// =============================================================================
// Fallback Implementation (used when bridge bundle not available)
// =============================================================================

// File-based session dedup for fallback path (issue #2577 bug 1).
// UserPromptSubmit spawns a NEW Node.js process on every prompt turn, so an
// in-memory Map always starts empty — skills were re-injected on every turn.
// Persisting to a JSON state file at {cwd}/.omc/state/skill-sessions-fallback.json
// preserves the injected-set across process spawns, matching bridge behaviour.
const FALLBACK_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour (same as bridge)

function readFallbackState(directory) {
  const stateFile = join(directory, '.omc', 'state', 'skill-sessions-fallback.json');
  try {
    if (existsSync(stateFile)) {
      return JSON.parse(readFileSync(stateFile, 'utf-8'));
    }
  } catch { /* ignore read/parse errors */ }
  return { sessions: {} };
}

function writeFallbackState(directory, state) {
  const stateDir = join(directory, '.omc', 'state');
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'skill-sessions-fallback.json'), JSON.stringify(state, null, 2));
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
function findMatchingSkillsFallback(prompt, directory, sessionId) {
  const promptLower = prompt.toLowerCase();
  const candidates = findSkillFilesFallback(directory);
  const matches = [];

  // File-based session dedup (persists across process spawns)
  const state = readFallbackState(directory);
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

  for (const candidate of candidates) {
    // Skip if already injected this session
    if (alreadyInjected.has(candidate.path)) continue;

    try {
      const content = readFileSync(candidate.path, 'utf-8');
      const skill = parseSkillFrontmatterFallback(content);
      if (!skill) continue;

      // Check if any trigger matches
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

  // Sort by score (descending) and limit
  matches.sort((a, b) => b.score - a.score);
  const selected = matches.slice(0, MAX_SKILLS_PER_SESSION);

  // Persist injected paths back to file so future process spawns skip them
  if (selected.length > 0) {
    const existing = state.sessions[sessionId]?.injectedPaths ?? [];
    state.sessions[sessionId] = {
      injectedPaths: [...new Set([...existing, ...selected.map(s => s.path)])],
      timestamp: now,
    };
    writeFallbackState(directory, state);
  }

  return selected;
}

// =============================================================================
// Main Logic (uses bridge if available, fallback otherwise)
// =============================================================================

// Find matching skills - delegates to bridge or fallback
function findMatchingSkills(prompt, directory, sessionId) {
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

  // Fallback (NON-RECURSIVE, file-based dedup via skill-sessions-fallback.json)
  return findMatchingSkillsFallback(prompt, directory, sessionId);
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
    const sessionId = data.session_id || data.sessionId || 'unknown';
    const directory = data.cwd || process.cwd();

    // Skip if no prompt
    if (!prompt) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const matchingSkills = findMatchingSkills(prompt, directory, sessionId);

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

main();
