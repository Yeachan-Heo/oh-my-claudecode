import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { isAllowedPath, isTempOrScratchpadPath } from '../omc-orchestrator/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const hookScript = resolve(__dirname, '../../../templates/hooks/pre-tool-use.mjs');

function runPreToolUseHookRaw(
  tool_name: string,
  tool_input: Record<string, unknown>,
  cwd: string | null = process.cwd(),
  env: Record<string, string | undefined> = {},
) {
  const payload = {
    tool_name,
    tool_input,
    ...(cwd ? { cwd } : {}),
  };

  const result = spawnSync('node', [hookScript], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toBeTruthy();
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

function runPreToolUseHook(command: string, cwd = process.cwd()) {
  return runPreToolUseHookRaw('Bash', { command }, cwd);
}

function hasDelegationNotice(output: Record<string, unknown>): boolean {
  const hookSpecificOutput = output.hookSpecificOutput;
  return Boolean(
    hookSpecificOutput &&
      typeof hookSpecificOutput === 'object' &&
      'additionalContext' in hookSpecificOutput,
  );
}

describe('pre-tool-use template source extension detection', () => {
  it('does not warn for .json with stderr redirect', () => {
    const output = runPreToolUseHook(
      'cat ~/.claude/settings.json 2>/dev/null | python3 -m json.tool',
    );

    expect(output.continue).toBe(true);
    expect(output.suppressOutput).toBe(true);
    expect(hasDelegationNotice(output)).toBe(false);
  });

  it('still warns for real source files with redirection target', () => {
    const output = runPreToolUseHook('cat fragment.txt > src/app.js');
    const hookSpecificOutput = output.hookSpecificOutput as
      | { additionalContext?: string }
      | undefined;

    expect(output.continue).toBe(true);
    expect(hasDelegationNotice(output)).toBe(true);
    expect(hookSpecificOutput?.additionalContext).toContain('Bash command may modify source files');
  });

  describe('read-only commands and non-source redirect targets stay quiet', () => {
    it.each([
      ['grep over source files with a stderr redirect', 'grep -n foo *.mjs 2>/dev/null | head'],
      ['cat of a source file with a stderr redirect', 'cat src/app.mjs 2>/dev/null | head -20'],
      ['cat of a source file redirected to non-source log/txt', 'cat src/app.js > /tmp/out.txt'],
      ['executing .sh script with stdout redirect to log and stderr redirect', 'nohup bash batch-verify.sh 123 456 > batch-run.log 2>&1'],
      ['python script execution redirected to log', 'python3 scripts/measure.py > results.txt 2>&1'],
      ['node command piped to tee writing log', 'node build.js 2>&1 | tee build.log'],
      ['find for source files with a stderr redirect', 'ls -la; find . -name "*.mjs" 2>/dev/null'],
      ['write and source mention in different segments', 'echo hi > notes.txt; grep -n pattern app.ts'],
      ['non-source write followed by a source read', 'printf "%s" x > README.md && node --check hooks/run.mjs'],
    ])('does not warn: %s', (_label, command) => {
      const output = runPreToolUseHook(command);

      expect(output.continue).toBe(true);
      expect(hasDelegationNotice(output)).toBe(false);
    });
  });

  describe('throwaway scratchpad and temporary file writes stay quiet (Class 1)', () => {
    it.each([
      ['Write to macOS session scratchpad fixture', 'Write', { file_path: '/private/tmp/claude-501/project/session/scratchpad/corpus-fixture/tests/test_pairs.py' }],
      ['Edit to linux scratchpad fixture', 'Edit', { file_path: '/tmp/claude-user/project/session/scratchpad/test.js' }],
      ['Write to generic tmp path', 'Write', { file_path: '/tmp/test-fixture.ts' }],
      ['Edit to var tmp path', 'Edit', { file_path: '/var/tmp/run.sh' }],
    ])('does not warn for %s', (_label, toolName, input) => {
      const output = runPreToolUseHookRaw(toolName, input);

      expect(output.continue).toBe(true);
      expect(hasDelegationNotice(output)).toBe(false);
    });

    it('still warns for in-project source file writes', () => {
      const output = runPreToolUseHookRaw('Write', { file_path: 'src/app.ts' });
      const hookSpecificOutput = output.hookSpecificOutput as
        | { additionalContext?: string }
        | undefined;

      expect(output.continue).toBe(true);
      expect(hasDelegationNotice(output)).toBe(true);
      expect(hookSpecificOutput?.additionalContext).toContain('Direct Write on source file');
    });
  });

  describe('bounded path allowance agrees with the TypeScript helper', () => {
    it.each([
      ['/tmp/omc-fixture.ts', '/home/project', true],
      ['/tmp/project/src/app.ts', '/tmp/project', false],
      ['/tmp/project2/src/app.ts', '/tmp/project', true],
      ['/tmpfoo/src/app.ts', '/home/project', false],
      ['scratchpad/src/app.ts', '/home/project', false],
      ['C:\\Windows\\Temp\\fixture.ts', '/home/project', true],
      ['C:\\Users\\alice\\AppData\\Local\\Temp\\fixture.ts', '/home/project', true],
      ['\\\\server\\share\\fixture.ts', '/home/project', false],
    ] as const)('matches for %s from %s', (filePath, cwd, expected) => {
      expect(isAllowedPath(filePath, cwd)).toBe(expected);
      expect(isTempOrScratchpadPath(filePath, cwd)).toBe(expected && !filePath.startsWith('scratchpad'));

      const output = runPreToolUseHookRaw('Write', { file_path: filePath }, cwd);
      expect(hasDelegationNotice(output)).toBe(!expected);
    });

    it('allows an explicitly configured UNC temp root but not an arbitrary UNC share', () => {
      const env = { TMP: '\\\\server\\share\\Temp' };
      const allowed = '\\\\server\\share\\Temp\\fixture.ts';
      const rejected = '\\\\server\\share\\Other\\fixture.ts';
      const previousTmp = process.env.TMP;
      process.env.TMP = env.TMP;
      try {
        expect(isAllowedPath(allowed, '/home/project')).toBe(true);
        expect(isAllowedPath(rejected, '/home/project')).toBe(false);
      } finally {
        if (previousTmp === undefined) delete process.env.TMP;
        else process.env.TMP = previousTmp;
      }

      const output = runPreToolUseHookRaw('Write', { file_path: allowed }, '/home/project', env);
      expect(hasDelegationNotice(output)).toBe(false);
      expect(hasDelegationNotice(runPreToolUseHookRaw('Write', { file_path: rejected }, '/home/project', env))).toBe(true);
    });
  });

  describe('canonical project and nested-repository rejection', () => {
    it('rejects a temp-looking project path even when the project is rooted under /tmp', () => {
      const project = mkdtempSync(join(tmpdir(), 'omc-project-'));
      try {
        const target = join(project, 'src', 'app.ts');
        expect(isTempOrScratchpadPath(target, project)).toBe(false);
        expect(isAllowedPath(target, project)).toBe(false);
        expect(hasDelegationNotice(runPreToolUseHookRaw('Write', { file_path: target }, project))).toBe(true);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it('uses a nested tool-input cwd when the top-level hook cwd is absent', () => {
      const project = mkdtempSync(join(tmpdir(), 'omc-nested-cwd-'));
      try {
        const target = join(project, 'src', 'app.ts');
        const output = runPreToolUseHookRaw('Write', { file_path: target, cwd: project }, null);
        expect(hasDelegationNotice(output)).toBe(true);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it('rejects a nearest-existing-parent symlink that resolves into the project', () => {
      const root = mkdtempSync(join(tmpdir(), 'omc-symlink-'));
      const project = join(root, 'project');
      const alias = join(root, 'temp-alias');
      mkdirSync(join(project, 'src'), { recursive: true });
      try {
        try {
          symlinkSync(project, alias, 'dir');
        } catch {
          return;
        }
        const target = join(alias, 'src', 'app.ts');
        expect(isTempOrScratchpadPath(target, project)).toBe(false);
        expect(isAllowedPath(target, project)).toBe(false);
        expect(hasDelegationNotice(runPreToolUseHookRaw('Write', { file_path: target }, project))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('rejects a source target inside a nested temporary git repository', () => {
      const root = mkdtempSync(join(tmpdir(), 'omc-nested-git-'));
      const project = join(root, 'project');
      const nested = join(root, 'nested-repo');
      mkdirSync(project, { recursive: true });
      mkdirSync(nested, { recursive: true });
      try {
        execFileSync('git', ['init', '--quiet'], { cwd: nested });
        const target = join(nested, 'src', 'app.ts');
        expect(isTempOrScratchpadPath(target, project)).toBe(false);
        expect(hasDelegationNotice(runPreToolUseHookRaw('Write', { file_path: target }, project))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('notice payload is bounded', () => {
    it('truncates a long command and reports its real length', () => {
      const filler = 'x'.repeat(500);
      const command = `sed -i "s/${filler}/y/" src/app.ts`;
      const output = runPreToolUseHook(command);
      const additionalContext = (
        output.hookSpecificOutput as { additionalContext?: string } | undefined
      )?.additionalContext;

      expect(hasDelegationNotice(output)).toBe(true);
      expect(additionalContext).toContain('Bash command may modify source files');
      expect(additionalContext).toContain(`(${command.length} chars)`);
      expect(additionalContext).not.toContain(filler);
    });

    it('leaves a short command intact', () => {
      const command = 'sed -i s/a/b/ src/app.ts';
      const additionalContext = (
        runPreToolUseHook(command).hookSpecificOutput as
          | { additionalContext?: string }
          | undefined
      )?.additionalContext;

      expect(hasDelegationNotice(runPreToolUseHook(command))).toBe(true);
      expect(additionalContext).not.toContain('chars)');
    });
  });

  describe('real source writes still warn', () => {
    it.each([
      ['in-place sed', 'sed -i s/a/b/ src/app.ts'],
      ['redirect into a source file', 'echo "x" > lib/util.js'],
      ['append into a source file', 'cat fragment.txt >> src/index.mjs'],
      ['tee into a source file', 'curl https://example.com/file.js | tee src/vendor.js'],
      ['source write after a read-only segment', 'ls -la | head; sed -i s/x/y/ src/main.py'],
    ])('warns: %s', (_label, command) => {
      const output = runPreToolUseHook(command);
      const hookSpecificOutput = output.hookSpecificOutput as
        | { additionalContext?: string }
        | undefined;

      expect(output.continue).toBe(true);
      expect(hasDelegationNotice(output)).toBe(true);
    });
  });

  describe('quote-aware Bash mutation matrix', () => {
    it.each([
      ['quoted redirect operator', "printf '%s' 'echo x > src/app.ts'", false],
      ['escaped redirect operator', 'echo x \\> src/app.ts', false],
      ['quoted source input redirect', 'cat < src/app.ts', false],
      ['stderr redirect only', 'cat src/app.ts 2>/dev/null', false],
      ['script stdout and stderr to logs', 'bash verify.sh > results.txt 2> errors.log', false],
      ['pipeline to a non-source tee destination', 'cat src/app.ts | tee build.log', false],
      ['compound source read after log write', 'echo x > notes.txt; grep app.ts src/app.ts', false],
      ['subshell log write', '(echo x > output.txt)', false],
      ['shell -c log write', "bash -c 'echo x > /tmp/inner.log'", false],
      ['eval log write', "eval 'echo x > results.txt'", false],
      ['copy source into a log file', 'cp src/input.ts results.txt', false],
      ['install source into a log file', 'install src/input.ts results.txt', false],
      ['non-in-place perl read', "perl -e 'print' src/input.ts", false],
      ['read-only sed with --quiet', "sed --quiet -e '/foo/p' src/app.ts", false],
      ['read-only sed with --silent', "sed --silent -e '/foo/p' src/app.ts", false],
      ['read-only sed with -n', "sed -n -e 's/foo/bar/p' src/app.ts", false],
    ] as const)('stays quiet: %s', (_label, command, expectedWarning) => {
      expect(hasDelegationNotice(runPreToolUseHook(command))).toBe(expectedWarning);
    });

    it.each([
      ['quoted source redirect target', "echo x > 'src/app.ts'", true],
      ['escaped source redirect target', 'echo x > src/app\\.ts', true],
      ['escaped-space source redirect target', 'echo x > src/foo\\ bar.ts', true],
      ['multiple redirects with a source target', 'echo x > notes.txt > src/app.ts', true],
      ['pipeline tee source target', 'printf x | tee src/app.ts', true],
      ['compound source write', 'echo x > notes.txt; echo y > src/app.ts', true],
      ['subshell source write', '(echo x > src/app.ts)', true],
      ['shell -c source write', "bash -c 'echo x > src/app.ts'", true],
      ['eval source write', "eval 'echo x > src/app.ts'", true],
      ['environment output target', 'echo x > "$OUT"', true],
      ['command substitution output target', 'echo x > $(printf src/app.ts)', true],
      ['process substitution output target', 'echo x > >(tee src/app.ts)', true],
      ['process substitution nested source write', 'cat < <(echo x > src/app.ts)', true],
      ['rm source target', 'rm -f src/app.ts', true],
      ['mv source target', 'mv src/app.ts results.txt', true],
      ['cp source destination', 'cp src/input.txt src/app.ts', true],
      ['install source destination', 'install src/input.txt src/app.ts', true],
      ['touch source target', 'touch src/app.ts', true],
      ['truncate source target', 'truncate -s 0 src/app.ts', true],
      ['in-place sed source target', 'sed -i s/a/b/ src/app.ts', true],
      ['in-place sed attached backup suffix', "sed -ibak 's/a/b/' src/app.ts", true],
      ['in-place sed dotted backup suffix', "sed -i.bak 's/a/b/' src/app.ts", true],
      ['in-place sed long backup suffix', "sed --in-place=bak 's/a/b/' src/app.ts", true],
      ['in-place perl source target', "perl -pi -e 's/a/b/' src/app.ts", true],
    ] as const)('warns: %s', (_label, command, expectedWarning) => {
      expect(hasDelegationNotice(runPreToolUseHook(command))).toBe(expectedWarning);
    });
  });
});
