/**
 * Setup Contract Regression Tests
 *
 * Guards against recurring setup violations found in issues #2155, #2084, #2348, #2347.
 * Two core contracts:
 *   1. Never hardcode paths — use getClaudeConfigDir() or CLAUDE_CONFIG_DIR env var
 *   2. Never install to root ~/.claude when CLAUDE_CONFIG_DIR is set to a custom path
 *
 * Scanning approach: narrow construction-pattern matching (not broad string literals)
 * to avoid false positives and allowlist bloat.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');

// ── Helpers ──────────────────────────────────────────────────────────────────

function findFiles(dir: string, extensions: string[], excludeDirs: string[] = []): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name)) continue;
      results.push(...findFiles(fullPath, extensions, excludeDirs));
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

function relPath(absPath: string): string {
  return relative(REPO_ROOT, absPath);
}

/**
 * Check if a match at a given line index is inside a function with a given name.
 * Finds the enclosing function by scanning backward for `function <name>` declarations
 * and tracking brace nesting to confirm the match is within its body.
 */
function isInsideFunction(lines: string[], matchLineIdx: number, functionNames: string[]): boolean {
  // Simple approach: scan backward from the match line to find the nearest
  // `function <name>` declaration. If found before we leave the function body, return true.
  let braceDepth = 0;
  for (let i = matchLineIdx; i >= 0; i--) {
    const line = lines[i];

    // Check for the function declaration on this line first
    for (const name of functionNames) {
      if (line.includes(`function ${name}`)) {
        // Verify we're still inside this function (braceDepth should be <= 0,
        // meaning we haven't exited more scopes than we entered)
        return braceDepth <= 0;
      }
    }

    // Count braces on this line (going backward: } means entering a scope, { means leaving)
    for (const ch of line) {
      if (ch === '}') braceDepth++;
      if (ch === '{') braceDepth--;
    }

    // If braceDepth becomes positive, we've exited the enclosing scope completely
    // (more closing braces than opening ones above us)
    if (braceDepth > 0) return false;
  }
  return false;
}

/**
 * Check if a line is inside a string literal (part of an array of strings or template).
 * Detects patterns like: 'const x = join(__dirname, ...)' (a string being constructed, not actual code).
 */
function isInsideStringLiteral(line: string, pattern: RegExp): boolean {
  const trimmed = line.trim();
  // Lines that are string elements in an array (start with quote)
  if (/^['"`]/.test(trimmed)) return true;
  // Lines where the pattern match is inside a string literal assignment
  // e.g.: const code = 'join(__dirname, "lib")';
  const beforeMatch = line.substring(0, line.search(pattern));
  const quoteCount = (beforeMatch.match(/['"]/g) || []).length;
  return quoteCount % 2 === 1; // odd number of quotes means we're inside a string
}

// ── Contract 1: No dangerous join(homedir(), '.claude') in runtime source ────
// Issue #2155 — functions that construct config paths inline instead of using getClaudeConfigDir()

describe('Contract 1: no join(homedir()...".claude") outside canonical helpers', () => {
  const SRC_DIR = join(REPO_ROOT, 'src');
  const tsFiles = findFiles(SRC_DIR, ['.ts'], ['__tests__', 'node_modules']);

  // Canonical helper file and legitimate comparison functions
  const EXCLUDED_FILE = 'src/utils/config-dir.ts';
  // Functions that legitimately need to reference ~/.claude as a default/comparison
  const EXCLUDED_FUNCTIONS = [
    'isDefaultClaudeConfigDir',
    'isDefaultClaudeConfigDirPath',
    'prepareOmcLaunchConfigDir', // entry-point with its own CLAUDE_CONFIG_DIR || fallback
  ];

  // Pattern: join(homedir() ... '.claude') — the dangerous inline path construction
  const DANGEROUS_PATTERN = /join\(homedir\(\)[^)]*['"]\.claude['"]/;

  const violations: { file: string; line: number; text: string }[] = [];

  for (const file of tsFiles) {
    const rel = relPath(file);
    if (rel === EXCLUDED_FILE) continue;
    // Skip .d.ts files
    if (file.endsWith('.d.ts')) continue;

    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (DANGEROUS_PATTERN.test(lines[i])) {
        // Check if inside an excluded function
        if (!isInsideFunction(lines, i, EXCLUDED_FUNCTIONS)) {
          violations.push({ file: rel, line: i + 1, text: lines[i].trim() });
        }
      }
    }
  }

  it('has no unguarded join(homedir(), ".claude") in runtime TypeScript', () => {
    if (violations.length > 0) {
      const details = violations
        .map(v => `  ${v.file}:${v.line}: ${v.text}`)
        .join('\n');
      expect.fail(
        `Found join(homedir(), '.claude') outside canonical helpers:\n${details}\n\n` +
        `Use getClaudeConfigDir() instead of join(homedir(), '.claude').`
      );
    }
  });
});

// ── Contract 2: No unguarded $HOME/.claude in runtime shell scripts ──────────
// Issue #2155 §11-13 — scripts with inline $HOME/.claude without CLAUDE_CONFIG_DIR guard

describe('Contract 2: no unguarded $HOME/.claude in shell/script files', () => {
  const SCRIPT_DIRS = [
    join(REPO_ROOT, 'scripts'),
    join(REPO_ROOT, 'templates', 'hooks'),
  ];
  const EXTENSIONS = ['.mjs', '.cjs', '.sh'];
  const CONFIG_DIR_HELPERS = new Set([
    'scripts/lib/config-dir.mjs',
    'scripts/lib/config-dir.cjs',
    'scripts/lib/config-dir.sh',
  ]);

  // The safe pattern: ${CLAUDE_CONFIG_DIR:-$HOME/.claude}
  const SAFE_PATTERN = /\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}/;
  const DANGEROUS_PATTERN = /\$HOME\/\.claude/;

  const violations: { file: string; line: number; text: string }[] = [];

  for (const dir of SCRIPT_DIRS) {
    const files = findFiles(dir, EXTENSIONS);
    for (const file of files) {
      const rel = relPath(file);
      if (CONFIG_DIR_HELPERS.has(rel)) continue;

      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (DANGEROUS_PATTERN.test(line) && !SAFE_PATTERN.test(line)) {
          // Skip comment lines
          const trimmed = line.trim();
          if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
          violations.push({ file: rel, line: i + 1, text: trimmed });
        }
      }
    }
  }

  it('has no $HOME/.claude without ${CLAUDE_CONFIG_DIR:-...} guard in scripts', () => {
    if (violations.length > 0) {
      const details = violations
        .map(v => `  ${v.file}:${v.line}: ${v.text}`)
        .join('\n');
      expect.fail(
        `Found $HOME/.claude without CLAUDE_CONFIG_DIR guard:\n${details}\n\n` +
        `Replace with: \${CLAUDE_CONFIG_DIR:-$HOME/.claude}`
      );
    }
  });
});

// ── Contract 3: No raw __dirname path resolution in installer outside getPackageDir() ──
// PR #2347 — __dirname is undefined in ESM bundles; must use getPackageDir()

describe('Contract 3: no raw __dirname path resolution in installer outside getPackageDir()', () => {
  const INSTALLER_FILES = [
    join(REPO_ROOT, 'src', 'installer', 'index.ts'),
    join(REPO_ROOT, 'src', 'installer', 'hooks.ts'),
  ];

  // Pattern: join(__dirname, ... used for path resolution
  const DANGEROUS_PATTERN = /join\(__dirname\s*,/;

  const violations: { file: string; line: number; text: string }[] = [];

  for (const file of INSTALLER_FILES) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (DANGEROUS_PATTERN.test(lines[i])) {
        // Allow inside getPackageDir() function body
        if (isInsideFunction(lines, i, ['getPackageDir'])) continue;
        // Allow inside string literals (e.g., generated code written to files)
        if (isInsideStringLiteral(lines[i], DANGEROUS_PATTERN)) continue;
        violations.push({ file: relPath(file), line: i + 1, text: lines[i].trim() });
      }
    }
  }

  it('has no join(__dirname, ...) outside getPackageDir() in installer', () => {
    if (violations.length > 0) {
      const details = violations
        .map(v => `  ${v.file}:${v.line}: ${v.text}`)
        .join('\n');
      expect.fail(
        `Found join(__dirname, ...) outside getPackageDir():\n${details}\n\n` +
        `Use getPackageDir() instead of __dirname for path resolution.`
      );
    }
  });
});

// ── Contract 4: No absolute node binary paths in generated hook commands ─────
// Issue #2348 — CI baked /opt/hostedtoolcache/node/... into hooks

describe('Contract 4: no absolute node binary paths in hook commands', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
  });

  it('getHooksSettingsConfig() produces no absolute node paths (default config)', async () => {
    delete process.env.CLAUDE_CONFIG_DIR;

    // Dynamic import to get fresh module evaluation
    const { getHooksSettingsConfig } = await import('../installer/hooks.js');
    const config = getHooksSettingsConfig();

    const absoluteNodePattern = /^["']?\/[^\s]*node["']?\s/;
    const violations: { event: string; command: string }[] = [];

    for (const [eventType, eventHooks] of Object.entries(config.hooks)) {
      for (const hookGroup of eventHooks as Array<{ hooks: Array<{ command: string }> }>) {
        for (const hook of hookGroup.hooks) {
          if (absoluteNodePattern.test(hook.command)) {
            violations.push({ event: eventType, command: hook.command });
          }
        }
      }
    }

    if (violations.length > 0) {
      const details = violations
        .map(v => `  ${v.event}: ${v.command}`)
        .join('\n');
      expect.fail(
        `Found absolute node binary paths in hook commands:\n${details}\n\n` +
        `Hook commands must use bare 'node' or shell variable expansion, not resolved absolute paths.`
      );
    }
  });
});

// ── Contract 5: No hardcoded paths in LLM-consumed artifacts ─────────────────
// Architect recommendation + Issue #2155 §16

describe('Contract 5: no hardcoded ~/.claude in LLM-consumed artifacts', () => {
  const AGENTS_DIR = join(REPO_ROOT, 'agents');
  const DOCS_DIR = join(REPO_ROOT, 'docs');

  // Match ~/.claude NOT inside portable notation [$CLAUDE_CONFIG_DIR|~/.claude]
  // or ${CLAUDE_CONFIG_DIR:-...} pattern
  const TILDE_CLAUDE_PATTERN = /~\/\.claude/;
  const SAFE_PORTABLE = /\[\$CLAUDE_CONFIG_DIR\|~\/\.claude\]/;
  const SAFE_ENV_FALLBACK = /\$\{CLAUDE_CONFIG_DIR:-/;

  function scanForViolations(dir: string): { file: string; line: number; text: string }[] {
    const violations: { file: string; line: number; text: string }[] = [];
    const files = findFiles(dir, ['.md']);

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (TILDE_CLAUDE_PATTERN.test(line) && !SAFE_PORTABLE.test(line) && !SAFE_ENV_FALLBACK.test(line)) {
          // Skip markdown comments
          const trimmed = line.trim();
          if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) continue;
          // Skip lines that are just describing what CLAUDE_CONFIG_DIR defaults to
          if (/default.*~\/\.claude/i.test(line) || /fallback.*~\/\.claude/i.test(line)) continue;
          // Skip lines documenting the config-dir behavior
          if (/CLAUDE_CONFIG_DIR/i.test(line)) continue;
          violations.push({ file: relPath(file), line: i + 1, text: trimmed });
        }
      }
    }
    return violations;
  }

  it('agents/*.md have no unguarded ~/.claude references', () => {
    if (!existsSync(AGENTS_DIR)) return;
    const violations = scanForViolations(AGENTS_DIR);
    if (violations.length > 0) {
      const details = violations.map(v => `  ${v.file}:${v.line}: ${v.text}`).join('\n');
      expect.fail(
        `Found unguarded ~/.claude in agent definitions:\n${details}\n\n` +
        `Use [$CLAUDE_CONFIG_DIR|~/.claude] notation in LLM-consumed artifacts.`
      );
    }
  });

  it('docs/CLAUDE.md (the installed template) has no unguarded ~/.claude references', () => {
    // Only scan docs/CLAUDE.md — this is the file installed to users' config dirs
    // and consumed by LLMs. Other docs/ files are developer documentation, not runtime artifacts.
    const claudeMdPath = join(DOCS_DIR, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) return;

    const content = readFileSync(claudeMdPath, 'utf-8');
    const lines = content.split('\n');
    const violations: { file: string; line: number; text: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (TILDE_CLAUDE_PATTERN.test(line) && !SAFE_PORTABLE.test(line) && !SAFE_ENV_FALLBACK.test(line)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) continue;
        if (/default.*~\/\.claude/i.test(line) || /fallback.*~\/\.claude/i.test(line)) continue;
        if (/CLAUDE_CONFIG_DIR/i.test(line)) continue;
        // Skip glob/permission patterns like ~/.claude/** (describes allowed paths, not path resolution)
        if (/~\/\.claude\/\*/.test(line)) continue;
        violations.push({ file: 'docs/CLAUDE.md', line: i + 1, text: trimmed });
      }
    }

    if (violations.length > 0) {
      const details = violations.map(v => `  ${v.file}:${v.line}: ${v.text}`).join('\n');
      expect.fail(
        `Found unguarded ~/.claude in docs/CLAUDE.md:\n${details}\n\n` +
        `Use [$CLAUDE_CONFIG_DIR|~/.claude] notation in LLM-consumed artifacts.`
      );
    }
  });
});

// ── Contract 9: hooks/hooks.json commands use $CLAUDE_PLUGIN_ROOT, no absolute paths ──
// Issue #2348 — plugin hook delivery must be portable

describe('Contract 9: hooks/hooks.json portability', () => {
  const HOOKS_JSON_PATH = join(REPO_ROOT, 'hooks', 'hooks.json');

  it('all hook commands reference $CLAUDE_PLUGIN_ROOT', () => {
    if (!existsSync(HOOKS_JSON_PATH)) return;

    const hooksJson = JSON.parse(readFileSync(HOOKS_JSON_PATH, 'utf-8'));
    const violations: { event: string; command: string }[] = [];

    for (const [eventType, eventHooks] of Object.entries(hooksJson.hooks || {})) {
      for (const hookGroup of eventHooks as Array<{ hooks: Array<{ type: string; command: string }> }>) {
        for (const hook of hookGroup.hooks) {
          if (hook.type !== 'command') continue;
          if (!hook.command.includes('$CLAUDE_PLUGIN_ROOT')) {
            violations.push({ event: eventType, command: hook.command });
          }
        }
      }
    }

    if (violations.length > 0) {
      const details = violations.map(v => `  ${v.event}: ${v.command}`).join('\n');
      expect.fail(
        `Found hook commands not using $CLAUDE_PLUGIN_ROOT:\n${details}\n\n` +
        `All plugin hook commands must reference $CLAUDE_PLUGIN_ROOT for portability.`
      );
    }
  });

  it('no hook command contains an absolute node binary path', () => {
    if (!existsSync(HOOKS_JSON_PATH)) return;

    const hooksJson = JSON.parse(readFileSync(HOOKS_JSON_PATH, 'utf-8'));
    const absoluteNodePattern = /^["']?\/[^\s"']*node["']?\s/;
    const violations: { event: string; command: string }[] = [];

    for (const [eventType, eventHooks] of Object.entries(hooksJson.hooks || {})) {
      for (const hookGroup of eventHooks as Array<{ hooks: Array<{ type: string; command: string }> }>) {
        for (const hook of hookGroup.hooks) {
          if (hook.type !== 'command') continue;
          if (absoluteNodePattern.test(hook.command)) {
            violations.push({ event: eventType, command: hook.command });
          }
        }
      }
    }

    if (violations.length > 0) {
      const details = violations.map(v => `  ${v.event}: ${v.command}`).join('\n');
      expect.fail(
        `Found absolute node binary paths in hooks.json:\n${details}\n\n` +
        `This is the exact regression from issue #2348. Hook commands must use bare 'node', not resolved absolute paths.`
      );
    }
  });
});

// ── Contract 10: Setup installer manages stale OMC-created files ─────────────
// User requirement: setup cleanup stale ~/.claude/skills and ~/.claude/agents created by OMC

describe('Contract 10: installer manages stale OMC-created agents and skills', () => {
  it('package ships agent definitions that can be enumerated', () => {
    const agentsDir = join(REPO_ROOT, 'agents');
    expect(existsSync(agentsDir)).toBe(true);

    const agentFiles = readdirSync(agentsDir).filter(f => f.endsWith('.md') && f !== 'AGENTS.md');
    expect(agentFiles.length).toBeGreaterThan(5);
  });

  it('package ships skill definitions that can be enumerated', () => {
    const skillsDir = join(REPO_ROOT, 'skills');
    expect(existsSync(skillsDir)).toBe(true);

    const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(skillsDir, d.name, 'SKILL.md')));
    expect(skillDirs.length).toBeGreaterThan(5);
  });

  it('syncBundledSkillDefinitions overwrites existing OMC skills (force copy)', () => {
    // The installer uses cpSync with { force: true } which overwrites stale versions
    // Verify this by checking the source code pattern
    const installerSource = readFileSync(join(REPO_ROOT, 'src', 'installer', 'index.ts'), 'utf-8');
    expect(installerSource).toContain('cpSync(sourceDir, targetDir, { recursive: true, force: true })');
  });

  it('install() overwrites existing agent files when force option is used', () => {
    // Verify the installer has the force-overwrite path for agents
    const installerSource = readFileSync(join(REPO_ROOT, 'src', 'installer', 'index.ts'), 'utf-8');
    // The installer checks: existsSync(filepath) && !options.force → skip
    // With force=true, it writes the file unconditionally
    expect(installerSource).toContain('existsSync(filepath) && !options.force');
  });

  it('OMC agent filenames are all lowercase kebab-case .md files', () => {
    // Ensures agent filenames follow a consistent pattern so stale detection is reliable
    const agentsDir = join(REPO_ROOT, 'agents');
    const agentFiles = readdirSync(agentsDir).filter(f => f.endsWith('.md') && f !== 'AGENTS.md');

    for (const file of agentFiles) {
      expect(file).toMatch(/^[a-z][a-z0-9-]*\.md$/);
    }
  });

  it('OMC skill directories match a consistent naming pattern', () => {
    const skillsDir = join(REPO_ROOT, 'skills');
    const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(skillsDir, d.name, 'SKILL.md')));

    for (const dir of skillDirs) {
      expect(dir.name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
