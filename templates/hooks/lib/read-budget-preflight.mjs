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
//         "maxBytes": 45000,
//         "mode": "warn-then-deny",
//         "allowPaths": ["docs/adr/**", "CHANGELOG.md"]
//       }
//     }
//   }
//
// Two budgets, either firing (issue #4062). Lines are a weak proxy for Read's
// 25,000-token output cap: tokens per line vary by roughly 3x across real
// files, so one line threshold is loose on dense files and blind on sparse
// ones. Bytes track the cap directly, so `maxBytes` is measured first and the
// line budget stays as the familiar, repo-tunable second key.
//
// Binaries are skipped outright rather than decoded as UTF-8: a PNG has no
// meaningful line count, and none of the remedies below apply to it.
//
// Env overrides: `OMC_READ_BUDGET=off` disables the gate entirely (this is the
// replacement for explore.md's unenforceable "unless the caller specifically
// asked for full file content" clause — a PreToolUse hook cannot see caller
// intent, so the escape has to be explicit). `OMC_READ_BUDGET_MAX_LINES` and
// `OMC_READ_BUDGET_MAX_BYTES` override the thresholds for one-off runs.
//
// Bash is gated too, but only for a bare `cat <file>`: `cat f | grep x`,
// `cat f > g`, and `sed -n '1,200p' f` are all targeted reads and stay allowed.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'fs';
import { extname, isAbsolute, join, relative, resolve } from 'path';

const STATE_FILENAME = 'read-budget-warnings.json';
const WARNING_RETENTION_SECONDS = 6 * 3600;
const DEFAULT_MAX_LINES = 1500;
// Truncating reads observed in practice run ~2.4-2.8 bytes per token, putting
// the 25,000-token cap around 60-70 KB. 45 KB sits deliberately below that: a
// false positive costs one bounded re-read, a false negative is a silent
// partial view that reads like a complete answer.
const DEFAULT_MAX_BYTES = 45000;
const DEFAULT_MODE = 'warn-then-deny';
// Above this size we stop decoding the file to count lines and report bytes.
const HUGE_FILE_BYTES = 5 * 1024 * 1024;
const READ_TOOL_NAMES = new Set(['Read', 'View']);
const BINARY_SNIFF_BYTES = 8 * 1024;
// Extension check first (free, covers the common case), NUL sniff as backstop.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.tiff', '.tif', '.webp', '.avif', '.heic',
  '.pdf', '.psd', '.ai', '.sketch',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.jar', '.war',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.obj', '.class', '.wasm', '.node',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.db', '.sqlite', '.sqlite3', '.mdb',
  '.pyc', '.pyo', '.dat', '.iso', '.dmg', '.pkg', '.deb', '.rpm',
]);

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

function parsePositiveDecimalInteger(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function resolveMaxLines(cfg, env) {
  const fromEnv = parsePositiveDecimalInteger(env.OMC_READ_BUDGET_MAX_LINES);
  if (fromEnv !== null) return fromEnv;
  if (Number.isFinite(cfg?.maxLines) && cfg.maxLines > 0) return cfg.maxLines;
  return DEFAULT_MAX_LINES;
}

function resolveMaxBytes(cfg, env) {
  const fromEnv = parsePositiveDecimalInteger(env.OMC_READ_BUDGET_MAX_BYTES);
  if (fromEnv !== null) return fromEnv;
  if (Number.isFinite(cfg?.maxBytes) && cfg.maxBytes > 0) return cfg.maxBytes;
  return DEFAULT_MAX_BYTES;
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
  // `pages` is the range key Read itself requires on a PDF over 10 pages, so a
  // call carrying it is targeted by the tool's own contract (issue #4062).
  const pages = toolInput?.pages;
  if (Array.isArray(pages) && pages.length > 0) return true;
  if (typeof pages === 'number' && Number.isFinite(pages)) return true;
  if (typeof pages === 'string' && pages.trim() !== '') return true;
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

// A binary has no line count worth computing and none of the remedies apply to
// it, so the gate skips it instead of decoding megabytes as UTF-8 (issue #4062).
function looksBinary(absolutePath) {
  if (BINARY_EXTENSIONS.has(extname(absolutePath).toLowerCase())) return true;
  let fd;
  try {
    fd = openSync(absolutePath, 'r');
    const buffer = Buffer.allocUnsafe(BINARY_SNIFF_BYTES);
    const read = readSync(fd, buffer, 0, BINARY_SNIFF_BYTES, 0);
    for (let i = 0; i < read; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } catch {
    // Unreadable means the gate has nothing to measure; treat as skip.
    return true;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function countLines(absolutePath, byteSize) {
  if (byteSize > HUGE_FILE_BYTES) return Number.POSITIVE_INFINITY;
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

/**
 * Measure one candidate path against both budgets.
 *
 * @returns {null | { over: boolean, lineCount: number, byteSize: number, trigger: 'bytes' | 'lines' }}
 *   `null` means "not measurable / not this gate's business" (directory, binary).
 */
function measure(absolutePath, maxLines, maxBytes) {
  const stats = statSync(absolutePath);
  if (!stats.isFile()) return null;
  if (looksBinary(absolutePath)) return null;
  const byteSize = stats.size;
  if (byteSize > maxBytes) {
    // Already over on bytes: no reason to decode the file to count lines.
    return { over: true, lineCount: Number.NaN, byteSize, trigger: 'bytes' };
  }
  const lineCount = countLines(absolutePath, byteSize);
  if (lineCount > maxLines) return { over: true, lineCount, byteSize, trigger: 'lines' };
  return { over: false, lineCount, byteSize, trigger: 'lines' };
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

// `measurement.trigger` decides which budget is quoted: quoting a line count on
// a file that tripped the byte budget (and was never decoded) would be a made-up
// number.
function describeSize(measurement, maxLines, maxBytes) {
  if (measurement.trigger === 'bytes') {
    return `${measurement.byteSize} bytes (budget ${maxBytes})`;
  }
  if (!Number.isFinite(measurement.lineCount)) {
    return `over 5 MB (line budget ${maxLines})`;
  }
  return `${measurement.lineCount} lines (budget ${maxLines})`;
}

// Ordered by what actually gets used after a truncated read: a bounded re-read
// dominates in practice, and a language server is frequently not even on PATH,
// so the structural tools come last rather than first (issue #4062).
function remedy(displayPath) {
  return (
    `Re-read \`${displayPath}\` with \`offset\`/\`limit\` for the range you need, ` +
    'delegate the sweep to a subagent, or use `ast_grep_search`/`lsp_document_symbols` ' +
    'when a structural view is what you are after.'
  );
}

function warnReason(displayPath, measurement, maxLines, maxBytes) {
  return (
    `[OMC READ BUDGET] \`${displayPath}\` is ${describeSize(measurement, maxLines, maxBytes)}. ` +
    'This full read is allowed once. ' +
    `${remedy(displayPath)} ` +
    'Read caps its own output at 25,000 tokens, so a full read of a file this size returns a partial ' +
    'view that still reads like a complete answer. ' +
    'Further full reads of this file are denied — off switch: `OMC_READ_BUDGET=off`.'
  );
}

function denyReason(displayPath, measurement, maxLines, maxBytes) {
  return (
    `[OMC READ BUDGET] Denied: \`${displayPath}\` is ${describeSize(measurement, maxLines, maxBytes)} ` +
    'and this call has no `offset`/`limit`. ' +
    `${remedy(displayPath)} ` +
    'Allowlist verbatim-value paths via `context.readBudget.allowPaths`, raise ' +
    '`context.readBudget.maxLines`/`context.readBudget.maxBytes`, or disable with `OMC_READ_BUDGET=off`.'
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
 * @returns {null | { decision: 'block' | 'warn', reason: string, path: string, lineCount: number,
 *   byteSize: number, trigger: 'bytes' | 'lines' }}
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
  const maxBytes = resolveMaxBytes(cfg, env);
  let measurement;
  try {
    measurement = measure(absolutePath, maxLines, maxBytes);
  } catch {
    return null;
  }
  if (!measurement || !measurement.over) return null;

  const displayPath = relative(cwd, absolutePath).split('\\').join('/') || rawPath;
  const mode = resolveMode(cfg);
  const base = {
    path: absolutePath,
    lineCount: measurement.lineCount,
    byteSize: measurement.byteSize,
    trigger: measurement.trigger,
  };
  const warn = { decision: 'warn', reason: warnReason(displayPath, measurement, maxLines, maxBytes), ...base };
  const block = { decision: 'block', reason: denyReason(displayPath, measurement, maxLines, maxBytes), ...base };

  if (mode === 'warn') return warn;
  if (mode === 'deny') return block;

  if (alreadyWarned(stateDir, absolutePath)) return block;
  recordWarning(stateDir, absolutePath);
  return warn;
}
