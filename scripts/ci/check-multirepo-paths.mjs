#!/usr/bin/env node
/**
 * AST-grep CI gate: detect raw .omc path constructions that bypass
 * resolveSessionStatePaths() / getOmcRoot() / resolveOmcStateRoot().
 *
 * Exits non-zero if any match is found outside the whitelist.
 * Run: node scripts/ci/check-multirepo-paths.mjs [--root <dir>]
 */
import { createRequire } from 'node:module';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync, readFileSync } from 'node:fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// Parse --root argument. When --root is provided, the broad WHITELIST_DIRS
// (e.g. `tests/`) are NOT applied — this allows pointing the gate at a test
// fixture directory to verify enforcement still triggers.
const rootArgIdx = process.argv.indexOf('--root');
const hasRootOverride = rootArgIdx !== -1;
const searchRoot = hasRootOverride ? resolve(process.argv[rootArgIdx + 1]) : REPO_ROOT;

// Files/dirs that are intentionally allowed to contain raw .omc constructions.
// Canonical delegators own the path logic; specific scripts own workspace-marker
// resolution; tests assert on constructed paths.
const WHITELIST_FILES = new Set([
  // Canonical path resolvers (source of truth)
  'src/lib/worktree-paths.ts',
  'scripts/lib/state-root.mjs',
  'scripts/lib/state-root.cjs',
  // The gate itself (contains '.omc' literals in its own patterns)
  'scripts/ci/check-multirepo-paths.mjs',
  // Hook scripts that resolve workspace markers inline (own resolver, pre-dist)
  'scripts/post-tool-verifier.mjs',
  'scripts/pre-tool-enforcer.mjs',
  'scripts/skill-injector.mjs',
  'scripts/session-start.mjs',
  'scripts/code-simplifier.mjs',
  // Hook templates (shipped in distribution, own resolver pre-dist)
  'templates/hooks/code-simplifier.mjs',
  // Multi-repo test fixtures and audits (construct fake .omc trees)
  'scripts/smoke-multirepo.mjs',
  'scripts/audit-multirepo-e2e.mjs',
].map(p => resolve(REPO_ROOT, p)));

// Entire directories whitelisted (raw paths are legitimate in these contexts).
// Keep this list MINIMAL — broad whitelists make the gate cosmetic.
const WHITELIST_DIRS = [
  resolve(REPO_ROOT, 'tests'),       // tests construct raw paths for assertions
  resolve(REPO_ROOT, 'src', 'lib'),  // canonical path source (worktree-paths.ts and friends)
];

function isWhitelisted(filePath) {
  const abs = resolve(filePath);
  if (WHITELIST_FILES.has(abs)) return true;
  // When user explicitly targets a subtree with --root, skip broad dir whitelists
  // so the gate can be exercised against fixture directories under tests/.
  if (!hasRootOverride) {
    for (const dir of WHITELIST_DIRS) {
      if (abs.startsWith(dir + sep) || abs.startsWith(dir + '/')) return true;
    }
    // Any __tests__ directory anywhere in the repo
    if (abs.includes(`${sep}__tests__${sep}`) || abs.includes('/__tests__/')) return true;
    // Any *.test.{ts,tsx,js,mjs,cjs} file constructs fixture paths for assertions
    if (/\.test\.(ts|tsx|js|mjs|cjs)$/.test(abs)) return true;
  }
  return false;
}

/**
 * A match is benign when the first argument resolves to a known GLOBAL config root
 * (homedir(), os.homedir(), getClaudeConfigDir(), CLAUDE_CONFIG_DIR). These are
 * NOT workspace state — they're per-user installs of the OMC binary itself.
 * The multi-repo enforcement applies only to workspace-scoped `.omc/`.
 */
// Global config first-arg patterns. When join()'s first arg is one of these,
// the construction is a per-user OMC install config path (NOT workspace state).
const GLOBAL_FIRST_ARG_PATTERNS = [
  /^(?:path\.)?join\(\s*homedir\(\)\s*,/,
  /^(?:path\.)?join\(\s*os\.homedir\(\)\s*,/,
  /^(?:path\.)?join\(\s*getClaudeConfigDir\(\)\s*,/,
  /^(?:path\.)?join\(\s*CLAUDE_CONFIG_DIR\s*,/,
  /^(?:path\.)?join\(\s*configDir\s*,/,
];
function isGlobalConfigMatch(matchText) {
  // matchText looks like: join(homedir(), '.omc', 'state', ...) or path.join(os.homedir(), '.omc', ...)
  // Args may span lines — normalize whitespace before matching.
  const normalized = matchText.replace(/\s+/g, ' ').trimStart();
  return GLOBAL_FIRST_ARG_PATTERNS.some(re => re.test(normalized));
}

const req = createRequire(resolve(REPO_ROOT, 'package.json'));
let sg;
try {
  sg = req('@ast-grep/napi');
} catch (e) {
  console.error('ERROR: @ast-grep/napi not found. Run npm ci first.');
  process.exit(2);
}

const { parse, Lang } = sg;

// Patterns to search — (language, pattern string) pairs
const TS_PATTERNS = [
  "join($_, '.omc', $$$)",
  'join($_, ".omc", $$$)',
  "path.join($_, '.omc', $$$)",
  "`${$_}/.omc/$$$`",
  "`${$_}\\.omc\\$$$`",
];
const JS_PATTERNS = [
  "join($_, '.omc', $$$)",
  'join($_, ".omc", $$$)',
  "path.join($_, '.omc', $$$)",
  "`${$_}/.omc/$$$`",
  "`${$_}\\.omc\\$$$`",
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'bridge', 'coverage', '.omc']);

function* walkFiles(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkFiles(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

let totalHits = 0;
const hitLines = [];

for (const filePath of walkFiles(searchRoot)) {
  const ext = filePath.split('.').pop();
  let lang, patterns;
  if (ext === 'ts' || ext === 'tsx') {
    lang = Lang.TypeScript;
    patterns = TS_PATTERNS;
  } else if (ext === 'mjs' || ext === 'cjs' || ext === 'js') {
    lang = Lang.JavaScript;
    patterns = JS_PATTERNS;
  } else {
    continue;
  }

  if (isWhitelisted(filePath)) continue;

  let src;
  try { src = readFileSync(filePath, 'utf-8'); } catch { continue; }

  let root;
  try { root = parse(lang, src); } catch { continue; }

  const sgRoot = root.root();
  for (const pat of patterns) {
    let matches;
    try { matches = sgRoot.findAll(pat); } catch { continue; }
    for (const match of matches) {
      const pos = match.range().start;
      const rel = relative(REPO_ROOT, filePath);
      const line = pos?.line ?? '?';
      const fullText = match.text();
      const text = fullText.trim().slice(0, 80);
      // Skip global-config constructions: homedir()/.omc, getClaudeConfigDir()/.omc, etc.
      if (isGlobalConfigMatch(fullText)) continue;
      hitLines.push(`  ${rel}:${line}  ${text}`);
      totalHits++;
    }
  }
}

if (totalHits === 0) {
  console.log('multirepo-paths gate: OK (no raw .omc constructions found outside whitelist)');
  process.exit(0);
} else {
  console.error(`multirepo-paths gate: FAIL — ${totalHits} raw .omc construction(s) found:\n`);
  for (const line of hitLines) {
    console.error(line);
  }
  console.error('\nFix: use resolveSessionStatePaths() / getOmcRoot() / resolveOmcStateRoot() instead.');
  process.exit(1);
}
