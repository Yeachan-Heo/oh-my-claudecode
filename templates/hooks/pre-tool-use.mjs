#!/usr/bin/env node
/**
 * OMC Pre-Tool-Use Hook (Node.js)
 * Enforces delegation by warning when orchestrator attempts direct source file edits.
 * Also activates skill-active state for Stop hook protection (issue #1033).
 */

import * as path from 'path';
import { dirname } from 'path';
import { existsSync, readdirSync, mkdirSync, writeFileSync, renameSync, readFileSync, realpathSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { homedir, tmpdir } from 'os';
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { isSkillVisibleToUser } from './lib/skill-entitlements.mjs';
import { stripLeadingUtf8Bom } from './lib/utf8-bom.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Dynamic import for the shared stdin module
const { readStdin } = await import(pathToFileURL(path.join(__dirname, 'lib', 'stdin.mjs')).href);
const { resolveOmcStateRoot } = await import(pathToFileURL(path.join(__dirname, 'lib', 'state-root.mjs')).href);

// ---------------------------------------------------------------------------
// Skill Active State (issue #1033)
// Writes skill-active-state.json so the persistent-mode Stop hook can prevent
// premature session termination while a skill is executing.
// ---------------------------------------------------------------------------

/**
 * Skill protection levels: none/light/medium/heavy.
 * - 'none': Already has dedicated mode state (ralph, autopilot) or instant/read-only
 * - 'light': Quick agent shortcuts (3 reinforcements, 5 min TTL)
 * - 'medium': Review/planning skills that run multiple agents (5 reinforcements, 15 min TTL)
 * - 'heavy': Long-running skills (10 reinforcements, 30 min TTL)
 */
const PROTECTION_CONFIGS = {
  none:   { maxReinforcements: 0,  staleTtlMs: 0 },
  light:  { maxReinforcements: 3,  staleTtlMs: 5 * 60 * 1000 },
  medium: { maxReinforcements: 5,  staleTtlMs: 15 * 60 * 1000 },
  heavy:  { maxReinforcements: 10, staleTtlMs: 30 * 60 * 1000 },
};

const SKILL_PROTECTION = {
  // Already have mode state → no protection needed
  'omc-teams': 'none', cancel: 'none',
  // Instant / read-only → no protection needed
  trace: 'none', hud: 'none', 'omc-doctor': 'none', 'omc-help': 'none',
  'learn-about-omc': 'none', note: 'none',
  // Light protection (3 reinforcements)
  tdd: 'light', 'build-fix': 'light', analyze: 'light', skill: 'light',
  'configure-notifications': 'light',
  // Medium protection (5 reinforcements)
  'code-review': 'medium', 'security-review': 'medium', plan: 'medium',
  ralplan: 'medium', review: 'medium', 'external-context': 'medium',
  sciomc: 'medium', skillify: 'medium', learner: 'medium', 'omc-setup': 'medium',
  'mcp-setup': 'medium', 'project-session-manager': 'medium',
  'writer-memory': 'medium', 'ralph-init': 'medium',
  // Heavy protection (10 reinforcements)
  deepinit: 'heavy',
};

const RETIRED_SKILL_NAMES = new Set(['ultrawork', 'ccg']);

function getSkillProtection(skillName) {
  const normalized = (skillName || '').toLowerCase().replace(/^oh-my-claudecode:/, '');
  if (RETIRED_SKILL_NAMES.has(normalized)) return 'none';
  return SKILL_PROTECTION[normalized] || 'light';
}

function getInvokedSkillName(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const rawSkill = toolInput.skill || toolInput.skill_name || toolInput.skillName || toolInput.command || null;
  if (typeof rawSkill !== 'string' || !rawSkill.trim()) return null;
  const normalized = rawSkill.trim();
  return normalized.includes(':') ? normalized.split(':').at(-1).toLowerCase() : normalized.toLowerCase();
}

const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

async function writeSkillActiveState(directory, skillName, sessionId) {
  const protection = getSkillProtection(skillName);
  if (protection === 'none') return;

  const config = PROTECTION_CONFIGS[protection];
  const now = new Date().toISOString();
  const normalized = (skillName || '').toLowerCase().replace(/^oh-my-claudecode:/, '');

  const state = {
    active: true,
    skill_name: normalized,
    session_id: sessionId || undefined,
    started_at: now,
    last_checked_at: now,
    reinforcement_count: 0,
    max_reinforcements: config.maxReinforcements,
    stale_ttl_ms: config.staleTtlMs,
  };

  const stateDir = path.join(await resolveOmcStateRoot(directory), 'state');

  // Write to session-scoped path when sessionId is available (must match persistent-mode.mjs reads)
  const safeSessionId = sessionId && SESSION_ID_ALLOWLIST.test(sessionId) ? sessionId : '';
  const targetDir = safeSessionId
    ? path.join(stateDir, 'sessions', safeSessionId)
    : stateDir;
  const targetPath = path.join(targetDir, 'skill-active-state.json');

  try {
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    const tmpPath = targetPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmpPath, targetPath);
  } catch {
    // Best-effort; don't fail the hook
  }
}


async function clearAwaitingConfirmationFlag(directory, stateName, sessionId) {
  const stateDir = path.join(await resolveOmcStateRoot(directory), 'state');
  const safeSessionId = sessionId && SESSION_ID_ALLOWLIST.test(sessionId) ? sessionId : '';
  const paths = [
    safeSessionId ? path.join(stateDir, 'sessions', safeSessionId, `${stateName}-state.json`) : null,
    path.join(stateDir, `${stateName}-state.json`),
    path.join(homedir(), '.omc', 'state', `${stateName}-state.json`),
  ].filter(Boolean);

  for (const statePath of paths) {
    try {
      if (!existsSync(statePath)) continue;
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (!state || typeof state !== 'object' || !state.awaiting_confirmation) continue;
      delete state.awaiting_confirmation;
      const tmpPath = statePath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(tmpPath, statePath);
    } catch {
      // Best-effort; don't fail the hook
    }
  }
}

async function confirmSkillModeStates(directory, skillName, sessionId) {
  switch (skillName) {
    case 'ralph':
      await clearAwaitingConfirmationFlag(directory, 'ralph', sessionId);
      break;
    case 'autopilot':
      await clearAwaitingConfirmationFlag(directory, 'autopilot', sessionId);
      break;
    case 'ralplan':
      await clearAwaitingConfirmationFlag(directory, 'ralplan', sessionId);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Skill vs agent namespace guard (issue #3667)
//
// Task/Agent subagent_type identifiers and bundled skills share the same
// `oh-my-claudecode:` namespace. Deny skill names before Claude Code's native
// agent boundary so callers receive actionable Skill-tool guidance instead of
// a generic "Agent type not found" error.
// ---------------------------------------------------------------------------

const SKILL_AGENT_NAMESPACE_PREFIXES = ['oh-my-claudecode:', 'omc:'];
const SKILL_IDENTIFIER_PATTERN = /^[a-zA-Z0-9_-]+$/;

function splitAgentNamespace(subagentType) {
  const folded = subagentType.toLowerCase();
  for (const prefix of SKILL_AGENT_NAMESPACE_PREFIXES) {
    if (folded.startsWith(prefix.toLowerCase())) {
      return { name: subagentType.slice(prefix.length), namespaced: true };
    }
  }
  return { name: subagentType, namespaced: false };
}

function getTemplatePackageRoot() {
  return path.resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function getPluginAgentDirs() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const packageAgentsDir = path.join(getTemplatePackageRoot(), 'agents');
  return pluginRoot
    ? [path.join(pluginRoot, 'agents'), packageAgentsDir]
    : [path.join(getClaudeConfigDir(), 'agents')];
}

function getPluginSkillsDirs() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const packageSkillsDir = path.join(getTemplatePackageRoot(), 'skills');
  return pluginRoot
    ? [path.join(pluginRoot, 'skills'), packageSkillsDir]
    : [path.join(getClaudeConfigDir(), 'skills')];
}

/** Whether an agent definition resolves for the given identifier. */
function agentDefinitionExists(agentType, directory, namespaced) {
  const agentDirs = getPluginAgentDirs();
  if (!namespaced) {
    agentDirs.push(path.join(directory, '.claude', 'agents'));
    agentDirs.push(path.join(getClaudeConfigDir(), 'agents'));
  }
  return agentDirs.some((agentsDir) => existsSync(path.join(agentsDir, `${agentType}.md`)));
}

/** Extract a bundled skill's primary name and raw aliases from frontmatter. */
function parseSkillFrontmatterIdentifiers(content) {
  const fmMatch = stripLeadingUtf8Bom(content).match(/^---[\r\n]+([\s\S]*?)[\r\n]+---/);
  if (!fmMatch) return { aliases: [], primary: null };
  const fm = fmMatch[1];
  const nameMatch = fm.match(/^name:\s*(\S+)/m);
  const primary = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : null;
  const aliasMatch = fm.match(/^aliases:\s*(.+)$/m);
  const aliases = [];
  if (aliasMatch) {
    const raw = aliasMatch[1].trim();
    const tokens = raw.startsWith('[')
      ? raw.slice(1, raw.indexOf(']') === -1 ? raw.length : raw.indexOf(']')).split(',')
      : [raw.split(/\s+/)[0]];
    for (const token of tokens) {
      const clean = token.trim().replace(/^["']|["']$/g, '');
      if (clean) aliases.push(clean);
    }
  }
  return { aliases, primary };
}

// Claude Code native command names are renamed when bundled as skills.
const CC_NATIVE_SKILL_COMMANDS = new Set([
  'review',
  'plan',
  'security-review',
  'init',
  'doctor',
  'help',
  'config',
  'clear',
  'compact',
  'memory',
]);

function toSafeSkillName(name) {
  const normalized = name.trim();
  return CC_NATIVE_SKILL_COMMANDS.has(normalized.toLowerCase()) ? `omc-${normalized}` : normalized;
}

let cachedCanonicalSkillRegistry = null;

/** Build the canonical bundled-skill registry with runtime loader ordering. */
function buildCanonicalSkillRegistry() {
  if (cachedCanonicalSkillRegistry) return cachedCanonicalSkillRegistry;
  const registry = new Map();
  for (const skillsDir of getPluginSkillsDirs()) {
    let entries = [];
    try {
      entries = readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => {
      if (a.name === 'skillify') return -1;
      if (b.name === 'skillify') return 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isSkillVisibleToUser(entry.name)) continue;
      const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      let parsed;
      try {
        parsed = parseSkillFrontmatterIdentifiers(readFileSync(skillPath, 'utf-8'));
      } catch {
        continue;
      }
      const primary = toSafeSkillName(parsed.primary || entry.name);
      const allNames = [primary, ...parsed.aliases.map(toSafeSkillName)];
      for (const candidate of allNames) {
        const key = candidate.toLowerCase();
        if (registry.has(key)) continue;
        registry.set(key, primary);
      }
    }
  }
  cachedCanonicalSkillRegistry = registry;
  return registry;
}

/** Resolve a Task/Agent identifier to a bundled skill's canonical primary. */
function resolveBundledSkill(subagentType, directory) {
  const { name, namespaced } = splitAgentNamespace(subagentType);
  if (!SKILL_IDENTIFIER_PATTERN.test(name)) return null;
  const foldedName = name.toLowerCase();
  if (agentDefinitionExists(foldedName, directory, namespaced)) return null;

  const canonicalPrimary = buildCanonicalSkillRegistry().get(foldedName);
  if (canonicalPrimary) return { primary: canonicalPrimary };
  if (!namespaced) return null;
  if (!isSkillVisibleToUser(foldedName)) return null;

  for (const skillsDir of getPluginSkillsDirs()) {
    const directPath = path.join(skillsDir, foldedName, 'SKILL.md');
    if (existsSync(directPath)) {
      let primary = foldedName;
      try {
        const parsed = parseSkillFrontmatterIdentifiers(readFileSync(directPath, 'utf-8'));
        if (parsed.primary) primary = parsed.primary;
      } catch {
        // Keep the directory name when the file cannot be parsed.
      }
      return { primary: toSafeSkillName(primary) };
    }
  }
  return null;
}

/** Deny Skill names passed as Task/Agent subagent_type identifiers. */
function evaluateSkillAsAgentCall(toolName, toolInput, directory) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const rawSubagentType = toolInput.subagent_type;
  if (typeof rawSubagentType !== 'string') return null;
  const subagentType = rawSubagentType.trim();
  if (subagentType.length === 0) return null;

  const skill = resolveBundledSkill(subagentType, directory);
  if (!skill) return null;

  const { name } = splitAgentNamespace(subagentType);
  const skillIdentifier = `oh-my-claudecode:${skill.primary}`;
  const isPrimaryMatch = name.toLowerCase() === skill.primary.toLowerCase();
  const queriedName = isPrimaryMatch
    ? `"${subagentType}"`
    : `"${subagentType}" (alias of "${skill.primary}")`;
  const reason =
    `[SKILL vs AGENT] ${queriedName} is a Skill, not an agent. ` +
    `Do NOT call it via ${toolName}(subagent_type=...) — that subagent type does not exist, ` +
    `and Claude Code will fail the call with a generic "Agent type not found". ` +
    `Use the Skill tool instead: Skill(skill="${skillIdentifier}"). ` +
    `Do NOT substitute a similarly-named agent as a "closest match".`;
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Delegation enforcement
// ---------------------------------------------------------------------------

// Allowed path patterns (no warning)
// Paths are normalized to forward slashes before matching
const ALLOWED_PATH_PATTERNS = [
  /^\.omc\//,          // .omc/** (anchored)
  /^\.claude\//,       // .claude/** (anchored)
  /\/\.claude\//,      // any /.claude/ path (intentionally unanchored for absolute paths)
  /CLAUDE\.md$/,
  /AGENTS\.md$/,
];

// Source file extensions (should warn)
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.rb', '.php',
  '.svelte', '.vue',
  '.graphql', '.gql',
  '.sh', '.bash', '.zsh',
]);

const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'];
const TEMP_VARS = ['TMPDIR', 'TMP', 'TEMP'];
const WINDOWS_TEMP = [/^[a-z]:\/windows\/temp(?:\/|$)/i, /^[a-z]:\/users\/[^/]+\/appdata\/local\/temp(?:\/|$)/i];

function portablePath(value) {
  const input = String(value || '').trim().replace(/\\/g, '/');
  if (/^[a-z]:(?:\/|$)/i.test(input)) return `${input[0].toUpperCase()}:${path.posix.normalize(`/${input.slice(3)}`)}`;
  const unc = input.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (unc) {
    const rest = unc[3] ? path.posix.normalize(`/${unc[3]}`).slice(1) : '';
    return `//${unc[1]}/${unc[2]}${rest ? `/${rest}` : ''}`;
  }
  return path.posix.normalize(input);
}
function absolutePortable(value) {
  const clean = portablePath(value);
  return clean.startsWith('/') || /^[a-z]:\//i.test(clean) ? clean : portablePath(path.resolve(value));
}
function isWindowsPath(value) { return /^([a-z]:\/|\/\/)/i.test(portablePath(value)); }
function isAbsolutePath(value) { return portablePath(value).startsWith('/') || /^[a-z]:\//i.test(portablePath(value)); }
function withinPath(target, root) {
  const t = portablePath(target), r = portablePath(root);
  if (!isAbsolutePath(t) || !isAbsolutePath(r)) return false;
  const fold = isWindowsPath(t) || isWindowsPath(r);
  const a = fold ? t.toLowerCase() : t, b = fold ? r.toLowerCase() : r;
  return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`);
}
function canonicalPath(value) {
  const clean = portablePath(value);
  if (!isAbsolutePath(clean) || isWindowsPath(clean) !== (process.platform === 'win32')) return clean;
  const raw = String(value); const parsed = path.parse(raw); const parts = raw.slice(parsed.root.length).split(path.sep);
  let resolved = parsed.root;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part || part === '.') continue;
    if (part === '..') { resolved = path.dirname(resolved); continue; }
    const candidate = path.join(resolved, part);
    try { resolved = realpathSync(candidate); }
    catch { return portablePath(path.resolve(resolved, ...parts.slice(i))); }
  }
  return portablePath(resolved);
}
function nearestGitRoot(directory) {
  let probe = canonicalPath(absolutePortable(directory));
  if (!isAbsolutePath(probe) || isWindowsPath(probe) !== (process.platform === 'win32')) return null;
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: probe,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    }).trim();
    if (root) return canonicalPath(root);
  } catch { /* fall back to bounded ancestor probing */ }
  while (true) {
    if (existsSync(path.join(probe, '.git'))) return probe;
    const parent = path.dirname(probe); if (parent === probe) return null; probe = parent;
  }
}
function projectRoots(directory) {
  const start = absolutePortable(directory || process.cwd()), git = nearestGitRoot(start);
  return [...new Set([start, git].filter(Boolean))];
}
function hasGitAncestor(value) {
  if (!isAbsolutePath(value) || isWindowsPath(value) !== (process.platform === 'win32')) return false;
  let probe = path.dirname(canonicalPath(value));
  while (true) {
    try { if (existsSync(path.join(probe, '.git'))) return true; } catch { return true; }
    const parent = path.dirname(probe); if (parent === probe) return false; probe = parent;
  }
}
function approvedTempRoots() {
  const roots = [...TEMP_ROOTS, ...TEMP_VARS.map(name => process.env[name]).filter(Boolean)];
  try { roots.push(tmpdir()); } catch { /* use fixed roots */ }
  return [...new Set(roots.map(portablePath).filter(value => isAbsolutePath(value) && value !== '/' && !/^[a-z]:\/$/i.test(value)))];
}
function isTempOrScratchpadPath(filePath, directory) {
  const target = portablePath(filePath);
  if (!filePath || !isAbsolutePath(target)) return false;
  const hostIsWindows = process.platform === 'win32';
  if (isWindowsPath(target) !== hostIsWindows) return false;
  const canonical = canonicalPath(filePath), roots = projectRoots(directory);
  if (roots.some(root => withinPath(target, root) || withinPath(canonical, canonicalPath(root))) || hasGitAncestor(canonical)) return false;
  const temps = approvedTempRoots(), canonicalTemps = temps.map(canonicalPath);
  const lexical = temps.some(root => withinPath(target, root)) || (hostIsWindows && WINDOWS_TEMP.some(pattern => pattern.test(target)));
  const resolved = canonicalTemps.some(root => withinPath(canonical, root)) || (hostIsWindows && WINDOWS_TEMP.some(pattern => pattern.test(canonical)));
  return lexical && resolved;
}

function isAllowedPath(filePath, directory) {
  if (!filePath) return true;
  const clean = portablePath(filePath);
  if (clean.startsWith('../') || clean === '..') return false;
  if (ALLOWED_PATH_PATTERNS.some(pattern => pattern.test(clean))) return true;
  if (isTempOrScratchpadPath(filePath, directory)) return true;
  if (isAbsolutePath(clean)) {
    if (withinPath(clean, absolutePortable(getClaudeConfigDir()))) return true;
    for (const root of projectRoots(directory)) {
      if (!withinPath(clean, root)) continue;
      const rel = clean.slice(portablePath(root).length).replace(/^\/+/, '');
      return ALLOWED_PATH_PATTERNS.some(pattern => pattern.test(rel));
    }
  }
  return false;
}

function isSourceFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

const WORKER_BLOCKED_TMUX_PATTERN = /\btmux\s+(split-window|new-session|new-window|join-pane)\b/i;
const WORKER_BLOCKED_TEAM_CLI_PATTERN = /\bom[cx]\s+team\b(?!\s+api\b)/i;
const WORKER_BLOCKED_SKILL_PATTERN = /\$(team|autopilot|ralph)\b/i;

function teamWorkerIdentity() {
  return (process.env.OMC_TEAM_WORKER || process.env.OMX_TEAM_WORKER || '').trim();
}

function workerCommandViolation(command) {
  if (!command) return null;
  if (WORKER_BLOCKED_TMUX_PATTERN.test(command)) {
    return 'Team worker cannot run tmux pane/session orchestration commands.';
  }
  if (WORKER_BLOCKED_TEAM_CLI_PATTERN.test(command)) {
    return 'Team worker cannot run team orchestration commands (except `omc team api ...`).';
  }
  if (WORKER_BLOCKED_SKILL_PATTERN.test(command)) {
    return 'Team worker cannot invoke orchestration skills (`$team`, `$autopilot`, `$ralph`).';
  }
  return null;
}

// The notice stays in the transcript and is re-sent on every later turn, so a
// heredoc or generated command would keep paying for its whole body.
const NOTICE_COMMAND_MAX = 200;

function summarizeCommand(command) {
  const text = String(command || '');
  return text.length > NOTICE_COMMAND_MAX
    ? `${text.slice(0, NOTICE_COMMAND_MAX)}… (${text.length} chars)`
    : text;
}
function advanceQuote(quote, ch, next) {
  if (quote === "$'") {
    if (ch === '\\' && next !== undefined) return { quote, consume: 2 };
    if (ch === "'") return { quote: null, consume: 1 };
    return { quote, consume: 1 };
  }
  if (quote === "'") {
    if (ch === "'") return { quote: null, consume: 1 };
    return { quote, consume: 1 };
  }
  if (quote === '"') {
    if (ch === '\\' && next !== undefined) return { quote, consume: 2 };
    if (ch === '"') return { quote: null, consume: 1 };
    return { quote, consume: 1 };
  }
  if (ch === '$' && next === "'") return { quote: "$'", consume: 2 };
  if (ch === "'" || ch === '"') return { quote: ch, consume: 1 };
  return null;
}

function shellGroup(text, openIndex) {
  let depth = 0; let quote = null; let brace = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    const q = advanceQuote(quote, ch, text[i + 1]);
    if (q) { quote = q.quote; i += q.consume - 1; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (ch === '$' && text[i + 1] === '{') { brace += 1; i += 1; continue; }
    if (brace > 0) {
      if (ch === '}') brace -= 1;
      else if (ch === '(') depth += 1;
      else if (ch === ')' && depth > 1) depth -= 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return { end: i, inner: text.slice(openIndex + 1, i) };
  }
  return { end: text.length - 1, inner: text.slice(openIndex + 1) };
}
function findClosingBacktick(text, open) {
  let quote = null;
  for (let i = open + 1; i < text.length; i += 1) {
    const ch = text[i];
    const q = advanceQuote(quote, ch, text[i + 1]);
    if (q) { quote = q.quote; i += q.consume - 1; continue; }
    if (quote) continue;
    if (ch === '\\' && i + 1 < text.length) { i += 1; continue; }
    if (ch === '`') return i;
  }
  return -1;
}

function hasUnquotedTrailingBackslash(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const q = advanceQuote(quote, line[i], line[i + 1]);
    if (q) { quote = q.quote; i += q.consume - 1; continue; }
    if (line[i] === '\\') {
      if (i + 1 >= line.length) return quote === null;
      i += 1;
    }
  }
  return false;
}
function quotedHeredocBodyLines(lines) {
  const skip = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const markers = heredocMarkers(lines[i]);
    if (!markers.length) continue;
    let lineIndex = i;
    for (const marker of markers) {
      while (++lineIndex < lines.length) {
        const candidate = marker.stripTabs ? lines[lineIndex].replace(/^\t+/, '') : lines[lineIndex];
        if (candidate === marker.delimiter) break;
        if (marker.quoted) skip.add(lineIndex);
      }
    }
    i = lineIndex;
  }
  return skip;
}
function joinContinuedLines(text) {
  const lines = String(text || '').split('\n');
  const quotedBody = quotedHeredocBodyLines(lines);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    if (!quotedBody.has(i)) {
      while (hasUnquotedTrailingBackslash(line) && i + 1 < lines.length && !quotedBody.has(i + 1)) {
        line = `${line.slice(0, -1)}${lines[i + 1]}`;
        i += 1;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}
function heredocFd(prefix) {
  const fdMatch = prefix.match(/(\d+)$/);
  if (!fdMatch) return 0;
  const boundary = prefix.length - fdMatch[1].length - 1;
  if (boundary < 0) return Number(fdMatch[1]);
  if (!/[\s;|&()]/.test(prefix[boundary])) return 0;
  let escapes = 0;
  for (let j = boundary - 1; j >= 0 && prefix[j] === '\\'; j -= 1) escapes += 1;
  return escapes % 2 === 0 ? Number(fdMatch[1]) : 0;
}
function heredocMarkers(line) {
  const markers = [];
  let quote = null;
  let arith = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const ch = line[i];
    const q = advanceQuote(quote, ch, line[i + 1]);
    if (q) { quote = q.quote; i += q.consume - 1; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (ch === '#' && (i === 0 || /[\s;|&()]/.test(line[i - 1]))) break;
    if (ch === '(' && line[i + 1] === '(') { arith += 1; i += 1; continue; }
    if (arith > 0 && ch === ')' && line[i + 1] === ')') { arith -= 1; i += 1; continue; }
    if (arith > 0) continue;
    if (ch !== '<' || line[i + 1] !== '<') continue;
    if (line[i + 2] === '<') { i += 2; continue; }
    let j = i + 2;
    const stripTabs = line[j] === '-';
    if (stripTabs) j += 1;
    while (j < line.length && /[ \t]/.test(line[j])) j += 1;
    if (j >= line.length) continue;
    let delimiter = ''; let quoted = false;
    const start = j;
    while (j < line.length && !/[\s;&|<>()]/.test(line[j])) {
      const q = line[j];
      if (q === "'") {
        quoted = true;
        const end = line.indexOf("'", j + 1);
        if (end < 0) { delimiter = ''; break; }
        delimiter += line.slice(j + 1, end);
        j = end + 1;
        continue;
      }
      if (q === '"') {
        quoted = true;
        let inner = '';
        let k = j + 1;
        let closed = false;
        while (k < line.length) {
          if (line[k] === '\\' && k + 1 < line.length) {
            const n = line[k + 1];
            inner += '$`"\\\n'.includes(n) ? n : `\\${n}`;
            k += 2; continue;
          }
          if (line[k] === '"') { closed = true; k += 1; break; }
          inner += line[k]; k += 1;
        }
        if (!closed) { delimiter = ''; break; }
        delimiter += inner;
        j = k;
        continue;
      }
      if (line[j] === '\\' && j + 1 < line.length) { delimiter += line[j + 1]; j += 2; continue; }
      if (q === '$' && line[j + 1] === '"') {
        quoted = true;
        let inner = '';
        let k = j + 2;
        let closed = false;
        while (k < line.length) {
          if (line[k] === '\\' && k + 1 < line.length) {
            const n = line[k + 1];
            inner += '$`"\\\n'.includes(n) ? n : `\\${n}`;
            k += 2; continue;
          }
          if (line[k] === '"') { closed = true; k += 1; break; }
          inner += line[k]; k += 1;
        }
        if (!closed) { delimiter = ''; break; }
        delimiter += inner;
        j = k;
        continue;
      }
      if (q === '$' && line[j + 1] === "'") {
        quoted = true;
        let inner = '';
        let k = j + 2;
        let closed = false;
        while (k < line.length) {
          if (line[k] === '\\' && k + 1 < line.length) {
            const got = decodeAnsiCEscape(line, k);
            inner += got.value;
            k = got.end;
            continue;
          }
          if (line[k] === "'") { closed = true; k += 1; break; }
          inner += line[k]; k += 1;
        }
        if (!closed) { delimiter = ''; break; }
        delimiter += truncateAtNul(inner);
        j = k;
        continue;
      }
      if (q === '$' && line[j + 1] === '(') {
        const g = shellGroup(line, j + 1);
        delimiter += line.slice(j, g.end + 1);
        j = g.end + 1;
        continue;
      }
      if (q === '`') {
        const end = findClosingBacktick(line, j);
        if (end < 0) { delimiter = ''; break; }
        delimiter += line.slice(j, end + 1);
        j = end + 1;
        continue;
      }
      delimiter += line[j];
      j += 1;
    }
    if (!delimiter && j === start) continue;
    markers.push({ delimiter, stripTabs, fd: heredocFd(line.slice(0, i)), pos: i, quoted });
    i = Math.max(j, i + 1) - 1;
  }
  return markers;
}
function consumeHeredocBodies(lines, start, markers) {
  let i = start;
  const bodies = [];
  for (const marker of markers) {
    const body = [];
    while (++i < lines.length) {
      const candidate = marker.stripTabs ? lines[i].replace(/^\t+/, '') : lines[i];
      if (candidate === marker.delimiter) break;
      body.push(lines[i]);
    }
    bodies.push({ ...marker, body: body.join('\n'), delimiterLine: i < lines.length ? i : i - 1 });
  }
  return { bodies, end: i };
}
function stripHeredocBodies(command) {
  const lines = joinContinuedLines(command).split('\n'); const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const markers = heredocMarkers(lines[i]); kept.push(lines[i]);
    if (!markers.length) continue;
    const consumed = consumeHeredocBodies(lines, i, markers);
    i = consumed.end;
  }
  return kept.join('\n');
}
function splitSimpleCommands(line) {
  const parts = []; let start = 0; let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const q = advanceQuote(quote, ch, line[i + 1]);
    if (q) { quote = q.quote; i += q.consume - 1; continue; }
    if (ch === '\\') { i += 1; continue; }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '|&') {
      parts.push({ start, end: i, text: line.slice(start, i) });
      i += 1; start = i + 1; continue;
    }
    if (ch === '&' && i > 0 && '<>'.includes(line[i - 1])) continue;
    if (';|&'.includes(ch)) { parts.push({ start, end: i, text: line.slice(start, i) }); start = i + 1; }
  }
  parts.push({ start, end: line.length, text: line.slice(start) });
  return parts;
}
function owningPart(line, pos) {
  return splitSimpleCommands(line).find(part => pos >= part.start && pos < part.end)
    ?? { start: 0, end: line.length, text: line };
}
function dupRedirects(line) {
  const dups = [];
  let quote = null;
  for (let i = 0; i < line.length - 1; i += 1) {
    const ch = line[i];
    const q = advanceQuote(quote, ch, line[i + 1]);
    if (q) { quote = q.quote; i += q.consume - 1; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (ch !== '<' || line[i + 1] !== '&') continue;
    const prefix = line.slice(0, i);
    const dest = heredocFd(prefix);
    const srcMatch = line.slice(i + 2).match(/^[ \t]*(\d+)/);
    if (!srcMatch) continue;
    dups.push({ pos: i, dest, src: Number(srcMatch[1]) });
  }
  return dups;
}
function stdinOverrideRedirects(line) {
  const events = [];
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const q = advanceQuote(quote, ch, line[i + 1]);
    if (q) { quote = q.quote; i += q.consume - 1; continue; }
    if (ch === '\\') { i += 1; continue; }
    const three = line.slice(i, i + 3);
    const two = line.slice(i, i + 2);
    if (three === '<<<') {
      events.push({ pos: i, type: 'override', dest: heredocFd(line.slice(0, i)) });
      i += 2; continue;
    }
    if (two === '<<' || two === '<&') { i += 1; continue; }
    if (ch === '<') events.push({ pos: i, type: 'override', dest: heredocFd(line.slice(0, i)) });
  }
  return events;
}
function applyStdin(commandLine, bodies) {
  const events = [
    ...bodies.map(item => ({ pos: item.pos, type: 'heredoc', item })),
    ...dupRedirects(commandLine).map(dup => ({ ...dup, type: 'dup' })),
    ...stdinOverrideRedirects(commandLine),
  ].sort((a, b) => a.pos - b.pos);
  const fds = new Map();
  for (const event of events) {
    if (event.type === 'heredoc') fds.set(event.item.fd, event.item);
    else if (event.type === 'dup' && fds.has(event.src)) fds.set(event.dest, fds.get(event.src));
    else if (event.type === 'override') fds.set(event.dest, null);
  }
  return fds.get(0) || null;
}
function heredocSections(command) {
  const lines = joinContinuedLines(command).split('\n'); const sections = [];
  for (let i = 0; i < lines.length; i += 1) {
    const commandLine = lines[i]; const markers = heredocMarkers(commandLine);
    if (!markers.length) continue;
    const consumed = consumeHeredocBodies(lines, i, markers);
    const byOwner = new Map();
    for (const item of consumed.bodies) {
      const owner = owningPart(commandLine, item.pos);
      if (!byOwner.has(owner.start)) byOwner.set(owner.start, { text: owner.text, start: owner.start, bodies: [] });
      byOwner.get(owner.start).bodies.push(item);
    }
    for (const { text, start, bodies } of byOwner.values()) {
      const stdin = applyStdin(text, bodies.map(item => ({ ...item, pos: item.pos - start })));
      if (stdin) sections.push({ commandLine: text, body: stdin.body, fd: 0 });
      for (const item of bodies) {
        if (item === stdin) continue;
        sections.push({ commandLine: text, body: item.body, fd: item.fd === 0 ? -1 : item.fd });
      }
    }
    i = consumed.end;
  }
  return sections;
}

function tokenizeShell(command) {
  const tokens = []; let value = ''; let dynamic = false; let ambiguous = false; let nested = []; let quote = null; let adjacent = false; let quoted = false; let escaped = false;
  const flush = () => {
    if (value || dynamic || quote || quoted) {
      tokens.push({ type: 'word', value, dynamic, ambiguous, nested, glued: adjacent, quoted, escaped });
      adjacent = true;
    }
    value = ''; dynamic = false; ambiguous = false; nested = []; quoted = false; escaped = false;
  };
  const op = (value, kind) => { flush(); tokens.push({ type: 'op', value, kind, glued: adjacent }); adjacent = true; };
  const text = stripHeredocBodies(command);
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (quote === "$'") {
      if (ch === '\\' && i + 1 < text.length) { const got = decodeAnsiCEscape(text, i); value += got.value; i = got.end; continue; }
      if (ch === "'") { quote = null; value = truncateAtNul(value); i += 1; continue; }
      value += ch; i += 1; continue;
    }
    if (quote === "'") { if (ch === "'") quote = null; else value += ch; i += 1; continue; }
    if (quote === '"') {
      if (ch === '"') { quote = null; i += 1; continue; }
      if (ch === '\\' && i + 1 < text.length) {
        const n = text[i + 1];
        if ('$`"\\\n'.includes(n)) { value += n; i += 2; continue; }
        value += ch; i += 1; continue;
      }
      if (ch === '$' && text[i + 1] === '(') { const g = shellGroup(text, i + 1); value += text.slice(i, g.end + 1); dynamic = true; nested.push(g.inner); i = g.end + 1; continue; }
      if (ch === '`') { const end = findClosingBacktick(text, i); value += text.slice(i, end < 0 ? text.length : end + 1); dynamic = true; if (end >= 0) nested.push(text.slice(i + 1, end)); i = end < 0 ? text.length : end + 1; continue; }
      if (ch === '$') { value += ch; dynamic = true; i += 1; continue; }
      value += ch; i += 1; continue;
    }
    if (ch === '$' && text[i + 1] === "'") { quote = "$'"; quoted = true; i += 2; continue; }
    if (ch === "'") { quote = "'"; quoted = true; i += 1; continue; }
    if (ch === '"') { quote = '"'; quoted = true; i += 1; continue; }
    if (ch === '\\') { if (i + 1 < text.length) { value += text[i + 1]; escaped = true; } i += 2; continue; }
    if (ch === '#' && value === '') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (ch === '\n') { op(';', 'sep'); adjacent = false; i += 1; continue; }
    if (/\s/.test(ch)) { flush(); adjacent = false; i += 1; continue; }
    if (ch === '$' && text[i + 1] === '(') { const g = shellGroup(text, i + 1); value += text.slice(i, g.end + 1); dynamic = true; nested.push(g.inner); i = g.end + 1; continue; }
    if ((ch === '<' || ch === '>') && text[i + 1] === '(') { const g = shellGroup(text, i + 1); value += text.slice(i, g.end + 1); dynamic = true; nested.push(g.inner); i = g.end + 1; continue; }
    if (ch === '`') { const end = findClosingBacktick(text, i); value += text.slice(i, end < 0 ? text.length : end + 1); dynamic = true; if (end >= 0) nested.push(text.slice(i + 1, end)); i = end < 0 ? text.length : end + 1; continue; }
    if (ch === '$') { value += ch; dynamic = true; i += 1; continue; }
    if ('*?[]{}'.includes(ch)) ambiguous = true;
    const two = text.slice(i, i + 2), three = text.slice(i, i + 3);
    if (three === '<<<') { op(three, 'in'); i += 3; }
    else if (two === '>>' || two === '>&' || two === '&>' || two === '>|' || two === '<>') { op(two, 'out'); i += 2; }
    else if (two === '<<' || two === '<&') { op(two, 'in'); i += 2; }
    else if (two === '&&' || two === '||' || two === '|&') { op(two, 'sep'); i += 2; }
    else if (ch === '>') { op(ch, 'out'); i += 1; }
    else if (ch === '<') { op(ch, 'in'); i += 1; }
    else if ('|;&()'.includes(ch)) { op(ch, 'sep'); i += 1; }
    else { value += ch; i += 1; }
  }
  flush(); return tokens;
}

const COMMAND_WRAPPERS = new Set(['command', 'env', 'exec', 'nohup', 'nice', 'time', 'timeout', 'sudo', 'builtin']);
const SHELL_COMMANDS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'ash']);
const SHELL_RESERVED_WORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'for', 'do', 'done', 'case', 'esac', 'in', 'select', 'function', 'coproc', '{', '}', '!']);
function shellBase(value) { const clean = String(value || '').replace(/\\/g, '/'); return clean.slice(clean.lastIndexOf('/') + 1).toLowerCase(); }
function splitPipelineGroups(tokens) {
  const groups = []; let stages = []; let stage = [];
  const flushStage = () => { if (stage.length) stages.push(stage); stage = []; };
  const flushGroup = () => { flushStage(); if (stages.length) groups.push(stages); stages = []; };
  for (const token of tokens) {
    if (token.type === 'op' && token.kind === 'sep') {
      if (token.value === '|' || token.value === '|&') flushStage();
      else flushGroup();
    } else stage.push(token);
  }
  flushGroup();
  return groups;
}
function sourceMutationNotice(command) {
  return `[DELEGATION NOTICE] Bash command may modify source files: ${summarizeCommand(command)}\n\nRecommended: Delegate to executor agent instead:\n  Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="...")\n\nThis is a soft warning. Operation will proceed.`;
}
function targetIndices(segment) { const out = new Set(); for (let i = 0; i < segment.length; i += 1) if (segment[i].type === 'op' && (segment[i].kind === 'in' || segment[i].kind === 'out') && segment[i + 1]?.type === 'word') out.add(i + 1); return out; }
function writeTarget(token, directory) { return !token || token.type !== 'word' || token.dynamic || token.ambiguous || Boolean(token.value) && isSourceFile(token.value) && !isAllowedPath(token.value, directory); }
function wordsFor(segment, targets) { return segment.map((token, index) => ({ token, index })).filter(entry => entry.token.type === 'word' && !targets.has(entry.index)); }
function redirectIoIndices(segment) {
  const out = new Set();
  for (let i = 1; i < segment.length; i += 1) {
    if (segment[i].type === 'op' && (segment[i].kind === 'in' || segment[i].kind === 'out') && segment[i].value !== '&>' && segment[i].glued && segment[i - 1].type === 'word' && !segment[i - 1].quoted && !segment[i - 1].escaped && /^\d+$/.test(segment[i - 1].value)) out.add(i - 1);
  }
  return out;
}
function commandWords(segment) {
  return wordsFor(segment, targetIndices(segment)).filter(entry => !redirectIoIndices(segment).has(entry.index));
}
function consumeWrapper(words, index, base) {
  let i = index + 1;
  const takeOptionValue = () => { if (!words[i + 1] || words[i + 1].token.dynamic) return false; i += 2; return true; };
  while (i < words.length) {
    const token = words[i].token; if (token.dynamic) return null;
    const value = token.value;
    if (base === 'builtin') {
      if (value === '--') i += 1;
      if (!words[i]) return { index: words.length, base: ':' };
      const name = words[i].token.value;
      if (name === 'printf' || name === 'echo' || name === 'command') return { index: i };
      return { index: words.length, base: ':' };
    }
    if (value === '--') { i += 1; break; }
    if (base === 'env' && value.includes('=') && !value.startsWith('-')) { i += 1; continue; }
    if (!value.startsWith('-') || value === '-') break;
    if (base === 'timeout' && /^(?:-k|--kill-after|-s|--signal)$/.test(value)) { if (!takeOptionValue()) return null; continue; }
    if (base === 'timeout' && /^(?:--kill-after|--signal)=/.test(value)) { i += 1; continue; }
    if (base === 'timeout' && /^(?:--foreground|--preserve-status|--verbose)$/.test(value)) { i += 1; continue; }
    if (base === 'sudo' && /^(?:-u|-g|-h|-p|-C|-T|-r|-t)$/.test(value)) { if (!takeOptionValue()) return null; continue; }
    if (base === 'sudo' && /^(?:--user|--group|--host|--prompt|--close-from|--command-timeout|--role|--type)$/.test(value)) { if (!takeOptionValue()) return null; continue; }
    if (base === 'sudo' && /^(?:--user|--group|--host|--prompt|--close-from|--command-timeout|--role|--type)=/.test(value)) { i += 1; continue; }
    if (base === 'sudo' && /^--preserve-env=/.test(value)) { i += 1; continue; }
    if (base === 'sudo' && /^(?:-A|-b|-E|-e|-H|-K|-k|-n|-P|-S|-V|-v|--askpass|--background|--preserve-env|--edit|--set-home|--remove-timestamp|--reset-timestamp|--non-interactive|--stdin|--validate)$/.test(value)) { i += 1; continue; }
    if (base === 'env' && /^(?:-u|--unset|-C|--chdir)$/.test(value)) { if (!takeOptionValue()) return null; continue; }
    if (base === 'env' && /^(?:--unset|--chdir)=/.test(value)) { i += 1; continue; }
    if (base === 'env' && /^(?:-i|--ignore-environment|-0|--null)$/.test(value)) { i += 1; continue; }
    if (base === 'exec' && value === '-a') { if (!takeOptionValue()) return null; continue; }
    if (base === 'exec' && /^(?:-c|-l)$/.test(value)) { i += 1; continue; }
    if (base === 'nice' && /^(?:-n|--adjustment)$/.test(value)) { if (!takeOptionValue()) return null; continue; }
    if (base === 'nice' && /^--adjustment=/.test(value)) { i += 1; continue; }
    if (base === 'command' && /^(?:-v|-V)$/.test(value)) return { index: words.length, base: ':' };
    if (base === 'command' && value === '-p') { i += 1; continue; }
    if (base === 'nohup' && /^(?:--help|--version)$/.test(value)) return { index: words.length, base: null };
    if (base === 'time' && /^(?:-p|--portability)$/.test(value)) { i += 1; continue; }
    return null;
  }
  if (base === 'timeout') { if (!words[i] || words[i].token.dynamic) return null; i += 1; }
  return { index: i };
}
function headTailOperands(tokens) {
  const operands = []; let optionsEnded = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]; if (token.dynamic) return null;
    if (!optionsEnded) {
      if (token.value === '--') { optionsEnded = true; continue; }
      if (/^(?:--lines|--bytes)=/.test(token.value)) continue;
      if (/^(?:-n|--lines|-c|--bytes)$/.test(token.value)) {
        if (!tokens[i + 1] || tokens[i + 1].dynamic) return null;
        i += 1; continue;
      }
      if (/^-[nc][0-9]+/.test(token.value)) continue;
      if (token.value.startsWith('-') && token.value !== '-') continue;
    }
    operands.push(token);
  }
  return operands;
}
function executable(words) {
  let i = 0;
  while (i < words.length) {
    const token = words[i].token; if (token.dynamic) return { index: i, base: null };
    if (token.value.includes('=') && !token.value.startsWith('-')) { i += 1; continue; }
    const base = shellBase(token.value);
    if (SHELL_RESERVED_WORDS.has(base)) { i += 1; continue; }
    if (!COMMAND_WRAPPERS.has(base)) return { index: i, base };
    const consumed = consumeWrapper(words, i, base); if (!consumed) return { index: i, base: null };
    i = consumed.index;
  }
  return null;
}
function argsAfter(words, start) {
  const args = []; let optionsEnded = false;
  for (const entry of words.slice(start + 1)) {
    const token = entry.token;
    if (!optionsEnded && token.value === '--') { optionsEnded = true; continue; }
    if (!optionsEnded && token.value.startsWith('-')) continue;
    args.push(token);
  }
  return args;
}
function teeOperands(tokens) {
  const operands = []; let optionsEnded = false;
  for (const token of tokens) {
    if (token.dynamic) return null;
    if (!optionsEnded) {
      if (token.value === '--') { optionsEnded = true; continue; }
      if (/^-[aip]+$/.test(token.value) || /^(?:--append|--ignore-interrupts|--output-error(?:=.*)?|--help|--version)$/.test(token.value)) continue;
      if (token.value.startsWith('-') && token.value !== '-') return null;
    }
    operands.push(token);
  }
  return operands;
}
function touchOperands(tokens) {
  const operands = []; let optionsEnded = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]; if (token.dynamic) return null;
    if (!optionsEnded) {
      if (token.value === '--') { optionsEnded = true; continue; }
      if (/^(?:-r|--reference|-d|--date|-t)$/.test(token.value)) {
        if (!tokens[i + 1] || tokens[i + 1].dynamic) return null;
        i += 1; continue;
      }
      if (/^(?:--reference|--date|--time)=/.test(token.value)) continue;
      if (token.value.startsWith('-') && token.value !== '-') continue;
    }
    operands.push(token);
  }
  return operands;
}
function truncateOperands(tokens) {
  const operands = []; let optionsEnded = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]; if (token.dynamic) return null;
    if (!optionsEnded) {
      if (token.value === '--') { optionsEnded = true; continue; }
      if (/^(?:-r|--reference|-s|--size)$/.test(token.value)) {
        if (!tokens[i + 1] || tokens[i + 1].dynamic) return null;
        i += 1; continue;
      }
      if (/^(?:--reference|--size)=/.test(token.value)) continue;
      if (token.value.startsWith('-') && token.value !== '-') continue;
    }
    operands.push(token);
  }
  return operands;
}
function mvOperands(tokens) {
  const operands = []; let optionsEnded = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]; if (token.dynamic) return null;
    if (!optionsEnded) {
      if (token.value === '--') { optionsEnded = true; continue; }
      if (/^(?:-S|--suffix|-t|--target-directory)$/.test(token.value)) {
        if (!tokens[i + 1] || tokens[i + 1].dynamic) return null;
        i += 1; continue;
      }
      if (/^(?:--suffix|--target-directory|--backup)=/.test(token.value)) continue;
      if (token.value.startsWith('-') && token.value !== '-') continue;
    }
    operands.push(token);
  }
  return operands;
}
function stdoutRedirected(stage) {
  for (let i = 0; i < stage.length; i += 1) {
    const token = stage[i];
    if (token.type !== 'op' || token.kind !== 'out') continue;
    if (token.value === '&>') return true;
    const prev = stage[i - 1];
    const io = token.glued && prev?.type === 'word' && !prev.quoted && !prev.escaped && /^\d+$/.test(prev.value) ? Number(prev.value) : 1;
    if (token.value === '>&' && io !== 1) continue;
    if (io === 1) return true;
  }
  return false;
}
function stdinRedirected(stage) {
  for (let i = 0; i < stage.length; i += 1) {
    const token = stage[i];
    if (token.type !== 'op' || token.kind !== 'in') continue;
    const prev = stage[i - 1];
    const io = token.glued && prev?.type === 'word' && !prev.quoted && !prev.escaped && /^\d+$/.test(prev.value) ? Number(prev.value) : 0;
    if (io !== 0) continue;
    const target = stage[i + 1];
    if (token.value === '<&' && target?.type === 'word' && target.value === '0') continue;
    return true;
  }
  return false;
}
function isPassthroughStage(stage) {
  const words = commandWords(stage);
  const cmd = executable(words);
  if (cmd?.base !== 'cat') return false;
  if (stdoutRedirected(stage) || effectiveFd0HereString(stage).kind !== 'pipeline') return false;
  let optionsEnded = false;
  for (const entry of words.slice(cmd.index + 1)) {
    if (entry.token.dynamic) return false;
    const value = entry.token.value;
    if (!optionsEnded) {
      if (value === '--') { optionsEnded = true; continue; }
      if (/^-[u]+$/.test(value) || value === '-' || value === '/dev/null') continue;
      if (value.startsWith('-') && value !== '-') return false;
      return false;
    }
    if (value === '-' || value === '/dev/null') continue;
    return false;
  }
  return true;
}
function parseShellInvocation(shellArgs) {
  let noexec = false;
  let forceStdin = false;
  const applySet = (value) => {
    const plus = value.startsWith('+');
    const letters = value.slice(1);
    if (letters.includes('n')) noexec = !plus;
    if (!plus && letters.includes('s')) forceStdin = true;
  };
  let i = 0;
  const skipValueOpt = (value, next, filenameOk) => {
    if (!next) return 'missing';
    if (!filenameOk && (next.startsWith('-') || next.startsWith('+'))) return 'invalid';
    if (value === '-o' && next === 'noexec') noexec = true;
    if (value === '+o' && next === 'noexec') noexec = false;
    return 'ok';
  };
  const skipPostC = () => {
    if (shellArgs[i]?.token.value === '--') { i += 1; return 'ok'; }
    while (i < shellArgs.length) {
      const value = shellArgs[i].token.value;
      const next = shellArgs[i + 1]?.token.value;
      if (value === '--') { i += 1; break; }
      if (value === '-' || value === '+') break;
      if (value === '--rcfile' || value === '--init-file') {
        const got = skipValueOpt(value, next, true); if (got !== 'ok') return got; i += 2; continue;
      }
      if (value === '-O' || value === '+O' || value === '-o' || value === '+o') {
        const got = skipValueOpt(value, next, false); if (got !== 'ok') return got; i += 2; continue;
      }
      if (/^[+-]D$/.test(value) || /^(?:--dump-strings|--dump-po-strings)$/.test(value)) return 'invalid';
      if (/^[+-][abefhkmnptuvxBCEHPTcils]+$/.test(value)) { applySet(value); i += 1; continue; }
      if (/^(?:--norc|--noprofile|--posix|--restricted|--verbose|--debugger|--debug|--stdin|--noediting|--login|--pretty-print)$/.test(value)) {
        if (value === '--stdin') forceStdin = true;
        i += 1; continue;
      }
      if (value.startsWith('-') || value.startsWith('+')) return 'invalid';
      break;
    }
    return 'ok';
  };
  while (i < shellArgs.length) {
    const value = shellArgs[i].token.value;
    const next = shellArgs[i + 1]?.token.value;
    if (value === '--' || value === '-') return { invalid: false, noexec, codeIndex: -1, readsStdin: forceStdin || i + 1 >= shellArgs.length };
    if (value === '--rcfile' || value === '--init-file') {
      const got = skipValueOpt(value, next, true); if (got !== 'ok') return { invalid: true, noexec, codeIndex: -1, readsStdin: false };
      i += 2; continue;
    }
    if (value === '-O' || value === '+O' || value === '-o' || value === '+o') {
      const got = skipValueOpt(value, next, false); if (got !== 'ok') return { invalid: true, noexec, codeIndex: -1, readsStdin: false };
      i += 2; continue;
    }
    if (value === '--command' || /^-[abefhkmnptuvxBCEHPTcils]*c[abefhkmnptuvxBCEHPTcils]*$/.test(value)) {
      if (value !== '--command') applySet(value);
      i += 1;
      const got = skipPostC();
      if (got !== 'ok') return { invalid: true, noexec, codeIndex: -1, readsStdin: false };
      return { invalid: false, noexec, codeIndex: i, readsStdin: false };
    }
    if (/^[+-][abefhkmnptuvxBCEHPTcils]+$/.test(value)) { applySet(value); i += 1; continue; }
    if (/^[+-]D$/.test(value) || /^(?:--dump-strings|--dump-po-strings|--help|--version)$/.test(value)) return { invalid: true, noexec, codeIndex: -1, readsStdin: false };
    if (/^(?:--norc|--noprofile|--posix|--restricted|--verbose|--debugger|--debug|--stdin|--noediting|--login|--pretty-print)$/.test(value)) {
      if (value === '--stdin') forceStdin = true;
      i += 1; continue;
    }
    if (value.startsWith('-') && value !== '-') return { invalid: true, noexec, codeIndex: -1, readsStdin: false };
    return { invalid: false, noexec, codeIndex: -1, readsStdin: forceStdin };
  }
  return { invalid: false, noexec, codeIndex: -1, readsStdin: true };
}
function shellArgsHaveNoexec(shellArgs) {
  const invocation = parseShellInvocation(shellArgs);
  return invocation.invalid || invocation.noexec;
}
function shellReadsStdinProgram(segment) {
  const words = commandWords(segment);
  const cmd = executable(words);
  if (!cmd?.base || !SHELL_COMMANDS.has(cmd.base)) return false;
  const shellArgs = words.slice(cmd.index + 1);
  if (shellArgs.some(entry => entry.token.dynamic)) return true;
  const invocation = parseShellInvocation(shellArgs);
  if (invocation.invalid || invocation.noexec || invocation.codeIndex >= 0) return false;
  return invocation.readsStdin;
}
function truncateAtNul(text) {
  const nul = text.indexOf('\0');
  return nul < 0 ? text : text.slice(0, nul);
}
function decodeAnsiCEscape(text, p) {
  if (text[p] !== '\\' || p + 1 >= text.length) return { value: text[p], end: p + 1 };
  const n = text[p + 1];
  if (n === 'n') return { value: '\n', end: p + 2 };
  if (n === 't') return { value: '\t', end: p + 2 };
  if (n === 'r') return { value: '\r', end: p + 2 };
  if (n === 'a') return { value: '\x07', end: p + 2 };
  if (n === 'b') return { value: '\b', end: p + 2 };
  if (n === 'f') return { value: '\f', end: p + 2 };
  if (n === 'v') return { value: '\v', end: p + 2 };
  if (n === 'e' || n === 'E') return { value: '\x1b', end: p + 2 };
  if (n === 'c') {
    if (p + 2 >= text.length) return { value: '\\c', end: p + 2 };
    const x = text[p + 2];
    return { value: x === '?' ? '\x7f' : String.fromCharCode(x.charCodeAt(0) & 0x1f), end: p + 3 };
  }
  if (n === 'x') {
    let hex = '';
    let q = p + 2;
    while (q < text.length && hex.length < 2 && /[0-9a-fA-F]/.test(text[q])) hex += text[q++];
    if (!hex) return { value: 'x', end: p + 2 };
    return { value: String.fromCharCode(parseInt(hex, 16)), end: q };
  }
  if (/[0-7]/.test(n)) {
    let oct = n;
    let q = p + 2;
    while (q < text.length && oct.length < 3 && /[0-7]/.test(text[q])) oct += text[q++];
    return { value: String.fromCharCode(parseInt(oct, 8)), end: q };
  }
  if (n === 'u' || n === 'U') {
    const max = n === 'u' ? 4 : 8;
    let hex = '';
    let q = p + 2;
    while (q < text.length && hex.length < max && /[0-9a-fA-F]/.test(text[q])) hex += text[q++];
    if (!hex) return { value: `\\${n}`, end: p + 2 };
    const cp = parseInt(hex, 16);
    if (!Number.isFinite(cp) || cp > 0x10FFFF) return { value: '', end: q };
    return { value: String.fromCodePoint(cp), end: q };
  }
  return { value: `\\${n}`, end: p + 2 };
}
function decodeAnsiC(text) {
  let out = '';
  for (let p = 0; p < text.length; ) {
    if (text[p] !== '\\') { out += text[p]; p += 1; continue; }
    const got = decodeAnsiCEscape(text, p);
    out += got.value;
    p = got.end;
  }
  return out;
}
function expandPrintfEscapes(text, { stop = false, echo = false } = {}) {
  let out = '';
  for (let p = 0; p < text.length; p += 1) {
    if (text[p] !== '\\' || p + 1 >= text.length) { out += text[p]; continue; }
    const n = text[p + 1];
    if (n === '\\') { out += '\\'; p += 1; continue; }
    if (n === 'c') {
      if (stop) return { text: out, stop: true };
      out += '\\c'; p += 1; continue;
    }
    if (n === 'n') { out += '\n'; p += 1; continue; }
    if (n === 't') { out += '\t'; p += 1; continue; }
    if (n === 'x') {
      let hex = '';
      let q = p + 2;
      while (q < text.length && hex.length < 2 && /[0-9a-fA-F]/.test(text[q])) hex += text[q++];
      if (!hex) { out += 'x'; p += 1; continue; }
      out += String.fromCharCode(parseInt(hex, 16));
      p = q - 1; continue;
    }
    if (n === '0') {
      let oct = '';
      let q = p + 2;
      while (q < text.length && oct.length < 3 && /[0-7]/.test(text[q])) oct += text[q++];
      out += String.fromCharCode(parseInt(oct || '0', 8));
      p = q - 1; continue;
    }
    if (echo && (n === 'u' || n === 'U')) {
      const max = n === 'u' ? 4 : 8;
      let hex = '';
      let q = p + 2;
      while (q < text.length && hex.length < max && /[0-9a-fA-F]/.test(text[q])) hex += text[q++];
      if (!hex) { out += `\\${n}`; p += 1; continue; }
      const cp = parseInt(hex, 16);
      if (Number.isFinite(cp) && cp <= 0x10FFFF) out += String.fromCodePoint(cp);
      else out += text.slice(p, q);
      p = q - 1; continue;
    }
    if (n === 'u' && /^[0-9a-fA-F]{4}/.test(text.slice(p + 2))) {
      out += String.fromCharCode(parseInt(text.slice(p + 2, p + 6), 16));
      p += 5; continue;
    }
    if (n === 'U' && /^[0-9a-fA-F]{8}/.test(text.slice(p + 2))) {
      const raw = text.slice(p, p + 10);
      const cp = parseInt(text.slice(p + 2, p + 10), 16);
      out += Number.isFinite(cp) && cp <= 0x10FFFF ? String.fromCodePoint(cp) : raw;
      p += 9; continue;
    }
    out += `\\${n}`; p += 1;
  }
  return { text: out, stop: false };
}
function parsePrintfConversion(format, p) {
  if (format[p + 1] === '%') return { end: p + 2, kind: '%', stars: 0, precision: null };
  let q = p + 1;
  while (q < format.length && /[-+ #0']/.test(format[q])) q += 1;
  let stars = 0;
  let precision = null;
  if (format[q] === '*') { stars += 1; q += 1; }
  else while (q < format.length && /\d/.test(format[q])) q += 1;
  if (format[q] === '.') {
    q += 1;
    if (format[q] === '*') { stars += 1; precision = '*'; q += 1; }
    else {
      const start = q;
      while (q < format.length && /\d/.test(format[q])) q += 1;
      precision = q === start ? 0 : Number(format.slice(start, q));
    }
  }
  const spec = format[q];
  if (spec === 's' || spec === 'b') return { end: q + 1, kind: spec, stars, precision };
  return { end: q, kind: null, stars: 0, precision: null };
}
function renderPrintf(args, { gnu = false } = {}) {
  if (args.length === 0) return null;
  let i = 0;
  if (args[i] === '--') i += 1;
  else if (args[i]?.startsWith('-') && args[i] !== '-') return null;
  if (i >= args.length) return '';
  const formatExp = expandPrintfEscapes(args[i++], { stop: gnu });
  if (formatExp.stop) return formatExp.text;
  const format = formatExp.text;
  const rest = args.slice(i);
  let out = '';
  let ai = 0;
  let passes = 0;
  while ((ai < rest.length || passes === 0) && passes < 256) {
    passes += 1;
    const start = ai;
    let consumed = false;
    for (let p = 0; p < format.length; p += 1) {
      if (format[p] !== '%') { out += format[p]; continue; }
      const conv = parsePrintfConversion(format, p);
      if (conv.kind === null) return null;
      if (conv.kind === '%') { out += '%'; p = conv.end - 1; continue; }
      const starArgs = [];
      for (let s = 0; s < conv.stars; s += 1) starArgs.push(ai < rest.length ? rest[ai++] : '0');
      let value = ai < rest.length ? rest[ai++] : '';
      consumed = true;
      if (conv.kind === 'b') {
        const expanded = expandPrintfEscapes(value, { stop: true });
        value = expanded.text;
        if (conv.precision !== null) {
          const prec = conv.precision === '*' ? Number(starArgs.shift()) : conv.precision;
          if (Number.isFinite(prec) && prec >= 0) value = value.slice(0, prec);
        }
        out += value;
        if (expanded.stop) return out;
        p = conv.end - 1;
        continue;
      }
      if (conv.precision !== null) {
        const prec = conv.precision === '*' ? Number(starArgs.shift()) : conv.precision;
        if (Number.isFinite(prec) && prec >= 0) value = value.slice(0, prec);
      }
      out += value;
      p = conv.end - 1;
    }
    if (!consumed || ai === start) break;
  }
  return out;
}
function effectiveFd0HereString(stage) {
  const pipeline = { kind: 'pipeline' };
  const unknown = { kind: 'unknown' };
  const fds = new Map([[0, pipeline]]);
  for (let k = 0; k < stage.length; k += 1) {
    const token = stage[k];
    if (token.type !== 'op' || token.kind !== 'in') continue;
    const prev = stage[k - 1];
    const io = token.glued && prev?.type === 'word' && !prev.quoted && !prev.escaped && /^\d+$/.test(prev.value) ? Number(prev.value) : 0;
    if (token.value === '<<<') {
      fds.set(io, { kind: 'here', word: stage[k + 1] || null });
      continue;
    }
    if (token.value === '<&') {
      const target = stage[k + 1];
      if (target?.dynamic) {
        fds.set(io, unknown);
        continue;
      }
      if (target?.type === 'word') {
        const match = target.value.match(/^(\d+)-?$/);
        if (match) {
          const src = Number(match[1]);
          fds.set(io, fds.get(src) || unknown);
          if (target.value.endsWith('-') && src !== io) fds.delete(src);
          continue;
        }
      }
      fds.set(io, { kind: 'file' });
      continue;
    }
    fds.set(io, { kind: 'file' });
  }
  return fds.get(0) || pipeline;
}
function checkPipelineProducer(stage, directory, command) {
  const targets = targetIndices(stage);
  const words = wordsFor(stage, targets);
  const cmd = executable(words);
  if (!cmd?.base) return false;
  if (cmd.base === 'printf' || cmd.base === 'echo') {
    const args = [];
    const entries = words.slice(cmd.index + 1);
    let optionsEnded = false;
    let echoExpand = false;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.token.dynamic) return true;
      const value = entry.token.value;
      if (!optionsEnded) {
        if (cmd.base === 'printf' && value === '--') { optionsEnded = true; continue; }
        if (cmd.base === 'printf' && value.startsWith('-v')) {
          return false;
        }
        if (cmd.base === 'echo' && /^-[neE]+$/.test(value)) {
          for (const flag of value.slice(1)) {
            if (flag === 'e') echoExpand = true;
            if (flag === 'E') echoExpand = false;
          }
          continue;
        }
        if (cmd.base === 'printf' && value.startsWith('-') && value !== '-' && value !== '--') return false;
        optionsEnded = true;
      }
      args.push(value);
    }
    const gnu = words[cmd.index].token.value.includes('/')
      || words.slice(0, cmd.index).some(entry => new Set(['env', 'exec', 'nohup', 'nice', 'timeout', 'sudo']).has(shellBase(entry.token.value)));
    const program = cmd.base === 'printf'
      ? renderPrintf(args, { gnu })
      : echoExpand
        ? (() => {
            const parts = [];
            for (const arg of args) {
              const expanded = expandPrintfEscapes(arg, { stop: true, echo: true });
              parts.push(expanded.text);
              if (expanded.stop) break;
            }
            return parts.join(' ');
          })()
        : args.join(' ');
    if (program === null) return true;
    const scanned = program.replace(/\0/g, '');
    return scanned.length > 0 && Boolean(checkBashCommand(scanned, directory));
  }
  if (!new Set(['cat', 'head', 'tail', 'tac']).has(cmd.base)) return false;
  const raw = words.slice(cmd.index + 1).map(entry => entry.token);
  const operands = cmd.base === 'cat' || cmd.base === 'tac' ? argsAfter(words, cmd.index) : headTailOperands(raw);
  const here = effectiveFd0HereString(stage);
  if (here.kind === 'unknown') return true;
  if (here.kind === 'here') {
    if (here.word?.dynamic) return true;
    if (here.word?.type === 'word' && checkBashCommand(here.word.value, directory)) return true;
  }
  if (!operands || operands.some(token => token.dynamic) || operands.length > 0) return !operands;
  if ((cmd.base === 'head' || cmd.base === 'tail') && raw.some(token => /^(?:-n|--lines|-c|--bytes)$/.test(token.value) || /^-[nc][+-]?[0-9]+/.test(token.value) || /^(?:--lines|--bytes)=/.test(token.value))) return true;
  return heredocSections(command).some(section => (
    section.fd === 0 && Boolean(checkBashCommand(section.body, directory))
  ));
}
function copyInvocation(tokens, command) {
  const operands = []; let optionsEnded = false; let target = null;
  const valueOptions = command === 'cp'
    ? new Set(['-S', '--suffix'])
    : new Set(['-m', '--mode', '-o', '--owner', '-g', '--group', '--strip-program', '-S', '--suffix']);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]; if (token.dynamic) return null;
    if (!optionsEnded) {
      if (token.value === '--') { optionsEnded = true; continue; }
      if (token.value === '-t' || token.value === '--target-directory') {
        if (!tokens[i + 1] || tokens[i + 1].dynamic) return null;
        target = tokens[++i]; continue;
      }
      if (token.value.startsWith('--target-directory=')) {
        target = { ...token, value: token.value.slice('--target-directory='.length) };
        continue;
      }
      if (valueOptions.has(token.value)) {
        if (!tokens[i + 1] || tokens[i + 1].dynamic) return null;
        i += 1; continue;
      }
      if (/^(?:--suffix|--mode|--owner|--group|--strip-program|--backup)=/.test(token.value)) continue;
      if (token.value.startsWith('-') && token.value !== '-') continue;
    }
    operands.push(token);
  }
  return { operands, target };
}
function checkSegment(segment, directory) {
  const targets = targetIndices(segment);
  for (let i = 0; i < segment.length; i += 1) {
    const token = segment[i]; if (token.type !== 'op' || token.kind !== 'out') continue;
    const target = segment[i + 1]; if (token.value === '>&' && target?.type === 'word' && /^(?:\d+|-)$/.test(target.value)) continue;
    if (writeTarget(target, directory)) return true;
  }
  for (const token of segment) {
    if (token.type === 'word') {
      for (const code of token.nested || []) if (checkBashCommand(code, directory)) return true;
    }
  }
  const words = commandWords(segment);
  if (words[0]?.token.value === 'coproc') {
    const unnamed = segment.filter((_, index) => index !== words[0].index);
    if (checkSegment(unnamed, directory)) return true;
    if (words[1]) {
      const named = segment.filter((_, index) => index !== words[0].index && index !== words[1].index);
      if (checkSegment(named, directory)) return true;
    }
    return false;
  }
  const cmd = executable(words); if (!cmd) return false; if (!cmd.base) return true;
  if (SHELL_COMMANDS.has(cmd.base)) {
    const shellArgs = words.slice(cmd.index + 1);
    if (shellArgs.some(entry => entry.token.dynamic)) return true;
    const invocation = parseShellInvocation(shellArgs);
    if (invocation.invalid || invocation.noexec) return false;
    if (invocation.codeIndex >= 0) {
      const code = shellArgs[invocation.codeIndex]?.token;
      return !code || checkBashCommand(code.value, directory);
    }
  }
  if (cmd.base === 'eval') { const code = words.slice(cmd.index + 1); return code.some(entry => entry.token.dynamic) || (code.length > 0 && checkBashCommand(code.map(entry => entry.token.value).join(' '), directory)); }
  const args = argsAfter(words, cmd.index);
  if (cmd.base === 'tee') { const operands = teeOperands(words.slice(cmd.index + 1).map(entry => entry.token)); return !operands || operands.some(token => writeTarget(token, directory)); }
  if (cmd.base === 'rm') return args.some(token => writeTarget(token, directory));
  if (cmd.base === 'mv') { const operands = mvOperands(words.slice(cmd.index + 1).map(entry => entry.token)); return !operands || operands.some(token => writeTarget(token, directory)); }
  if (cmd.base === 'truncate') { const operands = truncateOperands(words.slice(cmd.index + 1).map(entry => entry.token)); return !operands || operands.some(token => writeTarget(token, directory)); }
  if (cmd.base === 'touch') { const operands = touchOperands(words.slice(cmd.index + 1).map(entry => entry.token)); return !operands || operands.some(token => writeTarget(token, directory)); }
  if (cmd.base === 'cp' || cmd.base === 'install') {
    const rawArgs = words.slice(cmd.index + 1).map(entry => entry.token);
    const invocation = copyInvocation(rawArgs, cmd.base); if (!invocation) return true;
    if (invocation.target) {
      if (writeTarget(invocation.target, directory)) return true;
      return invocation.operands.some(source => writeTarget({ ...source, value: path.join(invocation.target.value, path.basename(source.value)) }, directory));
    }
    const destination = invocation.operands.at(-1);
    if (destination && !destination.dynamic && !destination.ambiguous) {
      const absoluteDestination = path.resolve(directory || process.cwd(), destination.value);
      let directoryDestination = destination.value.endsWith('/') || destination.value.endsWith('\\');
      try { directoryDestination ||= statSync(absoluteDestination).isDirectory(); } catch { /* missing destinations are handled as files */ }
      if (directoryDestination) {
        return invocation.operands.slice(0, -1).some(source => writeTarget({ ...source, value: path.join(destination.value, path.basename(source.value)) }, directory));
      }
    }
    return writeTarget(destination, directory);
  }
  if (cmd.base === 'sed' || cmd.base === 'perl') {
    const commandArgs = words.slice(cmd.index + 1);
    if (commandArgs.some(entry => entry.token.dynamic)) return true;
    const inPlace = commandArgs.some(entry => {
      const value = entry.token.value;
      if (value === '--in-place' || value.startsWith('--in-place=')) return true;
      return cmd.base === 'perl' ? !value.startsWith('-I') && /^-[^-]*i/.test(value) : /^-[^-]*[iI]/.test(value);
    });
    if (inPlace) return args.filter(token => !/^(?:s|y|tr)[/#]/.test(token.value)).some(token => writeTarget(token, directory));
  }
  return false;
}

function checkBashCommand(command, directory) {
  for (const section of heredocSections(command)) {
    const shellConsumer = splitPipelineGroups(tokenizeShell(section.commandLine)).some(stages => (
      stages.some(segment => section.fd === 0
        && segment.some(token => token.type === 'op' && token.value.startsWith('<<'))
        && shellReadsStdinProgram(segment))
    ));
    if (shellConsumer && checkBashCommand(section.body, directory)) return sourceMutationNotice(command);
  }
  for (const stages of splitPipelineGroups(tokenizeShell(command))) {
    for (let i = 0; i < stages.length; i += 1) {
      if (checkSegment(stages[i], directory)) return sourceMutationNotice(command);
      if (shellReadsStdinProgram(stages[i])) {
        const here = effectiveFd0HereString(stages[i]);
        if (here.kind === 'unknown') return sourceMutationNotice(command);
        if (here.kind === 'here') {
          if (here.word?.dynamic) return sourceMutationNotice(command);
          if (here.word?.type === 'word' && checkBashCommand(here.word.value, directory)) return sourceMutationNotice(command);
        }
      }
      if (i > 0 && shellReadsStdinProgram(stages[i])) {
        for (let j = i - 1; j >= 0; j -= 1) {
          if (checkPipelineProducer(stages[j], directory, command)) return sourceMutationNotice(command);
          if (!isPassthroughStage(stages[j])) break;
        }
      }
    }
  }
  return null;
}

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Extract tool name (handle both cases)
  const toolName = data.tool_name || data.toolName || '';
  const worker = teamWorkerIdentity();
  const directory = data.cwd || data.directory || data.tool_input?.cwd || data.toolInput?.cwd || data.tool_input?.directory || data.toolInput?.directory || process.cwd();

  if (worker) {
    if (toolName === 'Task' || toolName === 'task') {
      console.log(JSON.stringify({
        continue: false,
        reason: 'team-worker-task-blocked',
        message: `Worker ${worker} cannot spawn/delegate Task calls in worker mode.`
      }));
      return;
    }

    if (toolName === 'Skill' || toolName === 'skill') {
      console.log(JSON.stringify({
        continue: false,
        reason: 'team-worker-skill-blocked',
        message: `Worker ${worker} cannot invoke Skill tool in worker mode.`
      }));
      return;
    }
  }

  // Handle Bash tool separately - check for file modification patterns
  if (toolName === 'Bash' || toolName === 'bash') {
    const toolInput = data.tool_input || data.toolInput || {};
    const command = toolInput.command || '';
    if (worker) {
      const violation = workerCommandViolation(command);
      if (violation) {
        console.log(JSON.stringify({
          continue: false,
          reason: 'team-worker-bash-blocked',
          message: `${violation}\nCommand blocked: ${command}`
        }));
        return;
      }
    }
    const warning = checkBashCommand(command, directory);
    if (warning) {
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: warning
        }
      }));
    } else {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    }
    return;
  }

  // Skill-vs-agent guard: deny bundled Skill identifiers before Claude Code's
  // native Task/Agent boundary while leaving real agents untouched.
  if (toolName === 'Task' || toolName === 'Agent') {
    const toolInput = data.tool_input || data.toolInput || {};
    const skillAgentDeny = evaluateSkillAsAgentCall(toolName, toolInput, directory);
    if (skillAgentDeny) {
      console.log(JSON.stringify(skillAgentDeny));
      return;
    }
  }

  // Activate skill state when Skill tool is invoked (issue #1033)
  // Writes skill-active-state.json so the persistent-mode Stop hook can
  // prevent premature session termination while a skill is executing.
  if (toolName === 'Skill' || toolName === 'skill') {
    const sessionId = data.sessionId || data.session_id || data.sessionid || '';
    const toolInput = data.tool_input || data.toolInput || {};
    const skillName = getInvokedSkillName(toolInput);
    if (skillName) {
      await writeSkillActiveState(directory, skillName, sessionId);
    }
  }

  // Only check Edit and Write tools
  if (!['Edit', 'Write', 'edit', 'write'].includes(toolName)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Extract file path (handle nested structures)
  const toolInput = data.tool_input || data.toolInput || {};
  const filePath = toolInput.file_path || toolInput.filePath || '';

  // No file path? Allow
  if (!filePath) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if allowed path
  if (isAllowedPath(filePath, directory)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if source file
  if (isSourceFile(filePath)) {
    const warning = `[DELEGATION NOTICE] Direct ${toolName} on source file: ${filePath}

Recommended: Delegate to executor agent instead:
  Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="...")

This is a soft warning. Operation will proceed.`;

    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: warning
      }
    }));
    return;
  }

  // Not a source file, allow without warning
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});
