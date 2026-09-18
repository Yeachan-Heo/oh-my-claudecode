// Read Budget Preflight (issue #4054)
//
// `agents/explore.md` has carried a `<Context_Budget>` section since #587: use
// `lsp_document_symbols` for an outline, read large files with `offset`/`limit`,
// never pull a 500+ line file in full. Nothing enforced it — the rule was prose
// in one agent definition while the cost accumulates in every agent and in the
// main loop.
//
// This evaluator turns that rule into a gate. A `Read` with neither `offset` nor
// `limit`, against an existing file over the line budget, is warned once and then
// denied. Targeted reads, small files, allowlisted paths, and an explicit off
// switch all pass through untouched — the allow list matters more than the deny.
//
// The correctness argument is stronger than the token one: `Read` caps its own
// output at 25,000 tokens, so a full read of a 2,500 line file silently returns
// a fraction of it and still reads like a complete answer.
//
// Configuration (`.omc-config.json` or `.omc/config.json`):
//
//   {
//     "context": {
//       "readBudget": {
//         "enabled": true,
//         "maxLines": 1500,
//         "mode": "warn-then-deny",
//         "allowPaths": ["docs/adr/**", "CHANGELOG.md"]
//       }
//     }
//   }
//
// Env overrides: `OMC_READ_BUDGET=off` disables the gate entirely (this is the
// replacement for explore.md's unenforceable "unless the caller specifically
// asked for full file content" clause — a PreToolUse hook cannot see caller
// intent, so the escape has to be explicit). `OMC_READ_BUDGET_MAX_LINES`
// overrides the threshold for one-off runs.
//
// Bash is gated too, but only for a bare `cat <file>`: `cat f | grep x`,
// `cat f > g`, and `sed -n '1,200p' f` are all targeted reads and stay allowed.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';

const STATE_FILENAME = 'read-budget-warnings.json';
const WARNING_RETENTION_SECONDS = 6 * 3600;
const DEFAULT_MAX_LINES = 1500;
const DEFAULT_MODE = 'warn-then-deny';
// Above this size the file is over any sane line budget; skip the line count.
const HUGE_FILE_BYTES = 5 * 1024 * 1024;
const READ_TOOL_NAMES = new Set(['Read', 'View']);

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function readBudgetConfig(loadOmcConfig) {
  try {
    const cfg = typeof loadOmcConfig === 'function' ? loadOmcConfig() : null;
    return cfg?.context?.readBudget ?? null;
  } catch {
    return null;
  }
}

function resolveMaxLines(cfg, env) {
  const fromEnv = Number.parseInt(env.OMC_READ_BUDGET_MAX_LINES || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (Number.isFinite(cfg?.maxLines) && cfg.maxLines > 0) return cfg.maxLines;
  return DEFAULT_MAX_LINES;
}

function resolveMode(cfg) {
  const mode = typeof cfg?.mode === 'string' ? cfg.mode.trim() : '';
  return mode === 'deny' || mode === 'warn' ? mode : DEFAULT_MODE;
}

// Minimal glob support: `*` within a segment, `**` across segments. Patterns are
// matched against both the cwd-relative and the absolute path so a user can write
// either form in config.
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function isAllowlisted(cfg, absolutePath, cwd) {
  const patterns = Array.isArray(cfg?.allowPaths) ? cfg.allowPaths : [];
  if (patterns.length === 0) return false;
  const rel = relative(cwd, absolutePath).split('\\').join('/');
  const abs = absolutePath.split('\\').join('/');
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern.trim()) continue;
    let re;
    try {
      re = globToRegExp(pattern.trim().split('\\').join('/'));
    } catch {
      continue;
    }
    if (re.test(rel) || re.test(abs)) return true;
  }
  return false;
}

function hasTargetedRange(toolInput) {
  for (const key of ['offset', 'limit', 'startLine', 'endLine', 'start_line', 'end_line']) {
    const value = toolInput?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return true;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return true;
  }
  return false;
}

function extractReadPath(toolInput) {
  for (const key of ['file_path', 'filePath', 'path', 'file']) {
    const value = toolInput?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

// Only a bare `cat FILE` is a full read. Anything piped, redirected, chained, or
// substituted is either targeted or not a plain dump, so it passes through.
function extractBareCatPath(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed || /[|><;&`]|\$\(/.test(trimmed)) return null;
  const match = /^cat\s+(?!-)(\S+)$/.exec(trimmed);
  if (!match) return null;
  const candidate = match[1].replace(/^['"]|['"]$/g, '');
  return candidate || null;
}

function countLines(absolutePath) {
  const stats = statSync(absolutePath);
  if (!stats.isFile()) return null;
  if (stats.size > HUGE_FILE_BYTES) return Number.POSITIVE_INFINITY;
  const content = readFileSync(absolutePath, 'utf-8');
  if (content === '') return 0;
  let lines = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lines++;
  }
  // A trailing newline does not start another line.
  if (content.charCodeAt(content.length - 1) === 10) lines--;
  return lines;
}

function loadWarnings(stateDir) {
  if (!stateDir) return {};
  try {
    const p = join(stateDir, STATE_FILENAME);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return parsed && typeof parsed.warned === 'object' && parsed.warned ? parsed.warned : {};
  } catch {
    return {};
  }
}

function saveWarnings(stateDir, warned) {
  if (!stateDir) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, STATE_FILENAME), JSON.stringify({ warned }, null, 2));
  } catch {
    // Non-critical: a failed write means the next full read warns again instead
    // of denying, which fails open by design.
  }
}

function alreadyWarned(stateDir, key) {
  const warned = loadWarnings(stateDir);
  const ts = warned[key];
  return typeof ts === 'number' && ts > nowSec() - WARNING_RETENTION_SECONDS;
}

function recordWarning(stateDir, key) {
  const cutoff = nowSec() - WARNING_RETENTION_SECONDS;
  const warned = loadWarnings(stateDir);
  const pruned = {};
  for (const [k, ts] of Object.entries(warned)) {
    if (typeof ts === 'number' && ts > cutoff) pruned[k] = ts;
  }
  pruned[key] = nowSec();
  saveWarnings(stateDir, pruned);
}

function describeLines(lineCount) {
  return Number.isFinite(lineCount) ? `${lineCount} lines` : 'over 5 MB';
}

function remedy(displayPath) {
  return (
    `Use \`lsp_document_symbols\` on \`${displayPath}\` for the outline, ` +
    '`ast_grep_search` for structural matches, or `Read` with `offset`/`limit` for a specific range.'
  );
}

function warnReason(displayPath, lineCount, maxLines) {
  return (
    `[OMC READ BUDGET] \`${displayPath}\` is ${describeLines(lineCount)} (budget ${maxLines}). ` +
    'This full read is allowed once. ' +
    `${remedy(displayPath)} ` +
    'Read caps its own output at 25,000 tokens, so a full read of a file this size returns a partial ' +
    'view that still reads like a complete answer. ' +
    'Further full reads of this file are denied — off switch: `OMC_READ_BUDGET=off`.'
  );
}

function denyReason(displayPath, lineCount, maxLines) {
  return (
    `[OMC READ BUDGET] Denied: \`${displayPath}\` is ${describeLines(lineCount)} (budget ${maxLines}) ` +
    'and this call has no `offset`/`limit`. ' +
    `${remedy(displayPath)} ` +
    'Allowlist verbatim-value paths via `context.readBudget.allowPaths`, raise ' +
    '`context.readBudget.maxLines`, or disable with `OMC_READ_BUDGET=off`.'
  );
}

/**
 * Evaluate the read budget for the current PreToolUse call.
 *
 * @param {object} args
 * @param {string} args.toolName - Claude Code tool name.
 * @param {object} [args.toolInput] - Tool input payload.
 * @param {string} [args.stateDir] - Directory used to persist warn-once state.
 * @param {object} [args.env=process.env] - Environment for the off switch/threshold.
 * @param {Function} [args.loadOmcConfig] - Resolved OMC config loader.
 * @param {string} [args.cwd=process.cwd()] - Directory used to resolve relative paths.
 * @returns {null | { decision: 'block' | 'warn', reason: string, path: string, lineCount: number }}
 */
export function evaluateReadBudget({
  toolName,
  toolInput,
  stateDir,
  env = process.env,
  loadOmcConfig,
  cwd = process.cwd(),
} = {}) {
  if (!toolName) return null;
  if ((env.OMC_READ_BUDGET || '').trim().toLowerCase() === 'off') return null;

  const cfg = readBudgetConfig(loadOmcConfig);
  if (cfg && cfg.enabled === false) return null;

  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};

  let rawPath = null;
  if (READ_TOOL_NAMES.has(toolName)) {
    if (hasTargetedRange(input)) return null;
    rawPath = extractReadPath(input);
  } else if (toolName === 'Bash') {
    rawPath = extractBareCatPath(input.command);
  }
  if (!rawPath) return null;

  const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
  if (!existsSync(absolutePath)) return null;
  if (isAllowlisted(cfg, absolutePath, cwd)) return null;

  const maxLines = resolveMaxLines(cfg, env);
  let lineCount;
  try {
    lineCount = countLines(absolutePath);
  } catch {
    return null;
  }
  if (lineCount === null || !(lineCount > maxLines)) return null;

  const displayPath = relative(cwd, absolutePath).split('\\').join('/') || rawPath;
  const mode = resolveMode(cfg);

  if (mode === 'warn') {
    return { decision: 'warn', reason: warnReason(displayPath, lineCount, maxLines), path: absolutePath, lineCount };
  }
  if (mode === 'deny') {
    return { decision: 'block', reason: denyReason(displayPath, lineCount, maxLines), path: absolutePath, lineCount };
  }

  if (alreadyWarned(stateDir, absolutePath)) {
    return { decision: 'block', reason: denyReason(displayPath, lineCount, maxLines), path: absolutePath, lineCount };
  }
  recordWarning(stateDir, absolutePath);
  return { decision: 'warn', reason: warnReason(displayPath, lineCount, maxLines), path: absolutePath, lineCount };
}
