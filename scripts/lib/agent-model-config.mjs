/**
 * Per-agent model resolution for the registered PreToolUse hook.
 *
 * Reads `agents.<name>.model` from the OMC user/project config (the same
 * JSONC files src/config/loader.ts loads) so native Task/Agent subagent
 * calls honor the user's per-agent model override instead of falling back
 * to the static `agents/*.md` frontmatter (issue #3242).
 *
 * Inlined (no dist/ import) so the hook stays build-independent, mirroring
 * the rest of scripts/pre-tool-enforcer.mjs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Mirrors src/utils/paths.ts:getConfigDir
function getConfigDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

// Mirrors src/config/loader.ts:getConfigPaths
function getConfigPaths(cwd) {
  return {
    user: join(getConfigDir(), 'claude-omc', 'config.jsonc'),
    project: join(cwd || process.cwd(), '.claude', 'omc.jsonc'),
  };
}

// Mirrors src/utils/jsonc.ts:stripJsoncComments
export function stripJsoncComments(content) {
  let result = '';
  let i = 0;
  while (i < content.length) {
    if (content[i] === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (content[i] === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (content[i] === '"') {
      result += content[i];
      i++;
      while (i < content.length && content[i] !== '"') {
        if (content[i] === '\\') {
          result += content[i];
          i++;
          if (i < content.length) {
            result += content[i];
            i++;
          }
          continue;
        }
        result += content[i];
        i++;
      }
      if (i < content.length) {
        result += content[i];
        i++;
      }
      continue;
    }
    result += content[i];
    i++;
  }
  return result;
}

function loadJsoncFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(stripJsoncComments(readFileSync(path, 'utf-8')));
  } catch {
    return null;
  }
}

// Mirrors src/agents/definitions.ts:AGENT_CONFIG_KEY_MAP
const AGENT_CONFIG_KEY_MAP = {
  explore: 'explore',
  analyst: 'analyst',
  planner: 'planner',
  architect: 'architect',
  debugger: 'debugger',
  executor: 'executor',
  verifier: 'verifier',
  'security-reviewer': 'securityReviewer',
  'code-reviewer': 'codeReviewer',
  'test-engineer': 'testEngineer',
  designer: 'designer',
  writer: 'writer',
  'qa-tester': 'qaTester',
  scientist: 'scientist',
  tracer: 'tracer',
  'git-master': 'gitMaster',
  'code-simplifier': 'codeSimplifier',
  critic: 'critic',
  'document-specialist': 'documentSpecialist',
};

// Mirrors src/features/delegation-routing/types.ts:DEPRECATED_ROLE_ALIASES
const DEPRECATED_ROLE_ALIASES = {
  researcher: 'document-specialist',
  'tdd-guide': 'test-engineer',
  'api-reviewer': 'code-reviewer',
  'performance-reviewer': 'code-reviewer',
  'dependency-expert': 'document-specialist',
  'quality-strategist': 'code-reviewer',
  vision: 'document-specialist',
  'quality-reviewer': 'code-reviewer',
  'deep-executor': 'executor',
  'build-fixer': 'debugger',
  'harsh-critic': 'critic',
  reviewer: 'code-reviewer',
};

/**
 * Resolve the configured per-agent model for a subagent_type from config.jsonc.
 * Returns the raw configured model string (e.g. "sonnet", "claude-opus-4-6"),
 * or null when no per-agent override is configured. Project config takes
 * precedence over user config, matching loadConfig()'s merge order.
 */
export function resolveConfiguredAgentModel(subagentType, cwd) {
  const raw = (typeof subagentType === 'string' ? subagentType : '').replace(/^oh-my-claudecode:/, '');
  if (!raw || !/^[a-zA-Z0-9_-]+$/.test(raw)) return null;
  const canonical = DEPRECATED_ROLE_ALIASES[raw] ?? raw;
  const key = AGENT_CONFIG_KEY_MAP[canonical];
  if (!key) return null;

  const paths = getConfigPaths(cwd);
  // Project config takes precedence over user config (loadConfig merge order).
  for (const path of [paths.project, paths.user]) {
    const config = loadJsoncFile(path);
    const model = config?.agents?.[key]?.model;
    if (typeof model === 'string' && model.trim()) return model.trim();
  }
  return null;
}
