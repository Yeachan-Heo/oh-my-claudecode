#!/usr/bin/env node
/**
 * OMC Pre-Tool-Use Hook (Node.js)
 * Enforces delegation by warning when orchestrator attempts direct source file edits.
 * Also activates skill-active state for Stop hook protection (issue #1033).
 */

import * as path from 'path';
import { dirname } from 'path';
import { existsSync, readdirSync, mkdirSync, writeFileSync, renameSync, readFileSync, realpathSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { homedir, tmpdir } from 'os';
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { isSkillVisibleToUser } from './lib/skill-entitlements.mjs';

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
  const fmMatch = content.match(/^---[\r\n]+([\s\S]*?)[\r\n]+---/);
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
  let probe = clean; const tail = [];
  while (true) {
    try { return portablePath([realpathSync(probe), ...tail].join('/')); } catch {
      const parent = path.dirname(probe); if (parent === probe) return clean;
      tail.unshift(path.basename(probe)); probe = parent;
    }
  }
}
function nearestGitRoot(directory) {
  let probe = canonicalPath(absolutePortable(directory));
  if (!isAbsolutePath(probe) || isWindowsPath(probe) !== (process.platform === 'win32')) return null;
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
  const canonical = canonicalPath(target), roots = projectRoots(directory), canonicalRoots = roots.map(canonicalPath);
  if (roots.some(root => withinPath(target, root) || withinPath(canonical, canonicalPath(root))) || hasGitAncestor(canonical)) return false;
  const temps = approvedTempRoots(), canonicalTemps = temps.map(canonicalPath);
  const lexical = temps.some(root => withinPath(target, root)) || WINDOWS_TEMP.some(pattern => pattern.test(target));
  const resolved = canonicalTemps.some(root => withinPath(canonical, root)) || WINDOWS_TEMP.some(pattern => pattern.test(canonical));
  return lexical && resolved;
}

function isAllowedPath(filePath, directory) {
  if (!filePath) return true;
  const clean = portablePath(filePath);
  if (clean.startsWith('../') || clean === '..') return false;
  if (ALLOWED_PATH_PATTERNS.some(pattern => pattern.test(clean))) return true;
  if (isTempOrScratchpadPath(filePath, directory)) return true;
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

function shellGroup(text, openIndex) {
  let depth = 0; let quote = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { if (ch === '\\') i += 1; else if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return { end: i, inner: text.slice(openIndex + 1, i) };
  }
  return { end: text.length - 1, inner: text.slice(openIndex + 1) };
}

function tokenizeShell(command) {
  const tokens = []; let value = ''; let dynamic = false; let nested = []; let quote = null;
  const flush = () => { if (value || dynamic || quote) tokens.push({ type: 'word', value, dynamic, nested }); value = ''; dynamic = false; nested = []; };
  const op = (value, kind) => { flush(); tokens.push({ type: 'op', value, kind }); };
  const text = String(command || '');
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (quote === "'") { if (ch === "'") quote = null; else value += ch; i += 1; continue; }
    if (quote === '"') {
      if (ch === '"') { quote = null; i += 1; continue; }
      if (ch === '\\') { if (i + 1 < text.length) value += text[i + 1]; i += 2; continue; }
      if (ch === '$' && text[i + 1] === '(') { const g = shellGroup(text, i + 1); value += text.slice(i, g.end + 1); dynamic = true; nested.push(g.inner); i = g.end + 1; continue; }
      if (ch === '`') { const end = text.indexOf('`', i + 1); value += text.slice(i, end < 0 ? text.length : end + 1); dynamic = true; if (end >= 0) nested.push(text.slice(i + 1, end)); i = end < 0 ? text.length : end + 1; continue; }
      if (ch === '$') { value += ch; dynamic = true; i += 1; continue; }
      value += ch; i += 1; continue;
    }
    if (ch === "'") { quote = "'"; i += 1; continue; }
    if (ch === '"') { quote = '"'; i += 1; continue; }
    if (ch === '\\') { if (i + 1 < text.length) value += text[i + 1]; i += 2; continue; }
    if (/\s/.test(ch)) { flush(); i += 1; continue; }
    if (ch === '$' && text[i + 1] === '(') { const g = shellGroup(text, i + 1); value += text.slice(i, g.end + 1); dynamic = true; nested.push(g.inner); i = g.end + 1; continue; }
    if ((ch === '<' || ch === '>') && text[i + 1] === '(') { const g = shellGroup(text, i + 1); value += text.slice(i, g.end + 1); dynamic = true; nested.push(g.inner); i = g.end + 1; continue; }
    if (ch === '`') { const end = text.indexOf('`', i + 1); value += text.slice(i, end < 0 ? text.length : end + 1); dynamic = true; if (end >= 0) nested.push(text.slice(i + 1, end)); i = end < 0 ? text.length : end + 1; continue; }
    if (ch === '$') { value += ch; dynamic = true; i += 1; continue; }
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

const COMMAND_WRAPPERS = new Set(['command', 'env', 'exec', 'nohup', 'nice', 'time', 'timeout', 'sudo']);
const SHELL_COMMANDS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'ash']);
function shellBase(value) { const clean = String(value || '').replace(/\\/g, '/'); return clean.slice(clean.lastIndexOf('/') + 1).toLowerCase(); }
function splitSegments(tokens) { const out = []; let segment = []; for (const token of tokens) { if (token.type === 'op' && token.kind === 'sep') { if (segment.length) out.push(segment); segment = []; } else segment.push(token); } if (segment.length) out.push(segment); return out; }
function targetIndices(segment) { const out = new Set(); for (let i = 0; i < segment.length; i += 1) if (segment[i].type === 'op' && (segment[i].kind === 'in' || segment[i].kind === 'out') && segment[i + 1]?.type === 'word') out.add(i + 1); return out; }
function writeTarget(token, directory) { return !token || token.type !== 'word' || token.dynamic || !token.value || (isSourceFile(token.value) && !isAllowedPath(token.value, directory)); }
function wordsFor(segment, targets) { return segment.map((token, index) => ({ token, index })).filter(entry => entry.token.type === 'word' && !targets.has(entry.index)); }
function executable(words) { for (let i = 0; i < words.length; i += 1) { const value = words[i].token.value; if (words[i].token.dynamic) return { index: i, base: null }; if (value.includes('=') || COMMAND_WRAPPERS.has(shellBase(value))) continue; return { index: i, base: shellBase(value) }; } return null; }
function argsAfter(words, start) { return words.slice(start + 1).map(entry => entry.token).filter(token => token.value !== '--' && !token.value.startsWith('-')); }
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
  const words = wordsFor(segment, targets);
  const cmd = executable(words); if (!cmd) return false; if (!cmd.base) return true;
  if (SHELL_COMMANDS.has(cmd.base)) {
    const shellArgs = words.slice(cmd.index + 1);
    if (shellArgs.some(entry => entry.token.dynamic)) return true;
    const flag = shellArgs.findIndex(entry => entry.token.value === '--command' || /^-[^-]*c/.test(entry.token.value));
    if (flag >= 0) { const code = shellArgs[flag + 1]?.token; return !code || checkBashCommand(code.value, directory); }
  }
  if (cmd.base === 'eval') { const code = words.slice(cmd.index + 1); return code.some(entry => entry.token.dynamic) || (code.length > 0 && checkBashCommand(code.map(entry => entry.token.value).join(' '), directory)); }
  const args = argsAfter(words, cmd.index);
  if (cmd.base === 'tee') { const operands = teeOperands(words.slice(cmd.index + 1).map(entry => entry.token)); return !operands || operands.some(token => writeTarget(token, directory)); }
  if (new Set(['rm', 'mv', 'touch', 'truncate']).has(cmd.base)) return args.some(token => writeTarget(token, directory));
  if (cmd.base === 'cp' || cmd.base === 'install') return writeTarget(args.at(-1), directory);
  if (cmd.base === 'sed' || cmd.base === 'perl') {
    const inPlace = words.slice(cmd.index + 1).some(entry => entry.token.value === '--in-place' || entry.token.value.startsWith('--in-place=') || /^-[^-]*i/.test(entry.token.value));
    if (inPlace) return args.filter(token => !/^(?:s|y|tr)[/#]/.test(token.value)).some(token => writeTarget(token, directory));
  }
  return false;
}

function checkBashCommand(command, directory) {
  const offending = splitSegments(tokenizeShell(command)).find(segment => checkSegment(segment, directory));

  if (offending) {
    return `[DELEGATION NOTICE] Bash command may modify source files: ${summarizeCommand(command)}

Recommended: Delegate to executor agent instead:
  Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="...")

This is a soft warning. Operation will proceed.`;
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
