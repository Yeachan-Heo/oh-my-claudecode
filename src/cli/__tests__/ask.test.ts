import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parseAskArgs, resolveAskAdvisorScriptPath } from '../ask.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'index.ts');
const TSX_LOADER = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const ADVISOR_SCRIPT = join(REPO_ROOT, 'scripts', 'run-provider-advisor.js');

interface CliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

interface RunOptions {
  preserveClaudeSessionEnv?: boolean;
}

function buildChildEnv(
  envOverrides: Record<string, string> = {},
  options: RunOptions = {},
): NodeJS.ProcessEnv {
  if (options.preserveClaudeSessionEnv) {
    return { ...process.env, ...envOverrides };
  }

  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  return { ...cleanEnv, ...envOverrides };
}

function runCli(
  args: readonly string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
  options: RunOptions = {},
): CliRunResult {
  const result = spawnSync(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf-8',
    env: buildChildEnv(envOverrides, options),
  });

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message,
  };
}

function runAdvisorScript(
  args: readonly string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
  options: RunOptions = {},
): CliRunResult {
  const result = spawnSync(process.execPath, [ADVISOR_SCRIPT, ...args], {
    cwd,
    encoding: 'utf-8',
    env: buildChildEnv(envOverrides, options),
  });

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message,
  };
}

function runAdvisorScriptWithPrelude(
  preludePath: string,
  args: readonly string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
  options: RunOptions = {},
): CliRunResult {
  const result = spawnSync(process.execPath, ['--import', preludePath, ADVISOR_SCRIPT, ...args], {
    cwd,
    encoding: 'utf-8',
    env: buildChildEnv(envOverrides, options),
  });

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message,
  };
}

function writeAdvisorStub(dir: string): string {
  const stubPath = join(dir, 'advisor-stub.js');
  writeFileSync(
    stubPath,
    [
      '#!/usr/bin/env node',
      'const payload = {',
      '  provider: process.argv[2],',
      '  prompt: process.argv[3],',
      '  originalTask: process.env.OMC_ASK_ORIGINAL_TASK ?? null,',
      '  passthrough: process.env.ASK_WRAPPER_TOKEN ?? null,',
      '};',
      'process.stdout.write(JSON.stringify(payload));',
      'if (process.env.ASK_STUB_STDERR) process.stderr.write(process.env.ASK_STUB_STDERR);',
      'process.exit(Number(process.env.ASK_STUB_EXIT_CODE || 0));',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(stubPath, 0o755);
  return stubPath;
}

function writeFakeProviderBinary(dir: string, provider: 'claude' | 'gemini'): string {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, provider);
  writeFileSync(
    binPath,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake"; exit 0; fi\nif [ "$1" = "-p" ]; then echo "FAKE_PROVIDER_OK:$2"; exit 0; fi\necho "unexpected" 1>&2\nexit 9\n',
    'utf8',
  );
  chmodSync(binPath, 0o755);
  return binDir;
}

function writeSpawnSyncCapturePrelude(dir: string): string {
  const preludePath = join(dir, 'spawn-sync-capture-prelude.mjs');
  writeFileSync(
    preludePath,
    [
      "import childProcess from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      '',
      "Object.defineProperty(process, 'platform', { value: 'win32' });",
      'const capturePath = process.env.SPAWN_CAPTURE_PATH;',
      "const mode = process.env.SPAWN_CAPTURE_MODE || 'success';",
      'const calls = [];',
      'childProcess.spawnSync = (command, args = [], options = {}) => {',
      '  calls.push({',
      '    command,',
      '    args,',
      '    options: {',
      "      shell: options.shell ?? false,",
      "      encoding: options.encoding ?? null,",
      "      stdio: options.stdio ?? null,",
      "      input: options.input ?? null,",
      '      env: {',
      "        CLAUDECODE: options.env?.CLAUDECODE ?? null,",
      "        CLAUDE_SESSION_ID: options.env?.CLAUDE_SESSION_ID ?? null,",
      "        CLAUDECODE_SESSION_ID: options.env?.CLAUDECODE_SESSION_ID ?? null,",
      "        CLAUDE_CODE_ENTRYPOINT: options.env?.CLAUDE_CODE_ENTRYPOINT ?? null,",
      "        RUST_LOG: options.env?.RUST_LOG ?? null,",
      "        RUST_BACKTRACE: options.env?.RUST_BACKTRACE ?? null,",
      '      },',
      '    },',
      '  });',
      "  if (mode === 'missing' && command === 'where') {",
      "    return { status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null };",
      '  }',
      "  if (mode === 'missing' && (command === 'codex' || command === 'gemini') && Array.isArray(args) && args[0] === '--version') {",
      "    return { status: 1, stdout: '', stderr: \"'\" + command + \"' is not recognized\", pid: 0, output: [], signal: null };",
      '  }',
      "  const isVersionProbe = Array.isArray(args) && args[0] === '--version';",
      '  return {',
      '    status: 0,',
      "    stdout: isVersionProbe ? 'fake 1.0.0\\n' : 'FAKE_PROVIDER_OK',",
      "    stderr: '',",
      '    pid: 0,',
      '    output: [],',
      '    signal: null,',
      '  };',
      '};',
      'syncBuiltinESMExports();',
      'process.on(\'exit\', () => {',
      '  if (capturePath) {',
      "    writeFileSync(capturePath, JSON.stringify(calls), 'utf8');",
      '  }',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  return preludePath;
}


function writeFakeCodexBinary(dir: string): string {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, 'codex');
  writeFileSync(
    binPath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake"; exit 0; fi
if [ "$1" = "exec" ]; then
  echo "CODEX_OK"
  if [ -n "\${RUST_LOG:-}" ] || [ -n "\${RUST_BACKTRACE:-}" ]; then
    echo "RUST_LEAK:\${RUST_LOG:-}:\${RUST_BACKTRACE:-}" 1>&2
  fi
  exit 0
fi
echo "unexpected" 1>&2
exit 9
`,
    'utf8',
  );
  chmodSync(binPath, 0o755);
  return binDir;
}

describe('parseAskArgs', () => {
  it('supports positional and print/prompt flag forms', () => {
    expect(parseAskArgs(['claude', 'review', 'this'])).toEqual({ provider: 'claude', prompt: 'review this' });
    expect(parseAskArgs(['gemini', '-p', 'brainstorm'])).toEqual({ provider: 'gemini', prompt: 'brainstorm' });
    expect(parseAskArgs(['claude', '--print', 'draft', 'summary'])).toEqual({ provider: 'claude', prompt: 'draft summary' });
    expect(parseAskArgs(['gemini', '--prompt=ship safely'])).toEqual({ provider: 'gemini', prompt: 'ship safely' });
    expect(parseAskArgs(['codex', 'review', 'this'])).toEqual({ provider: 'codex', prompt: 'review this' });
  });

  it('supports --agent-prompt flag and equals syntax', () => {
    expect(parseAskArgs(['claude', '--agent-prompt', 'executor', 'do', 'it'])).toEqual({
      provider: 'claude',
      prompt: 'do it',
      agentPromptRole: 'executor',
    });

    expect(parseAskArgs(['gemini', '--agent-prompt=planner', '--prompt', 'plan', 'it'])).toEqual({
      provider: 'gemini',
      prompt: 'plan it',
      agentPromptRole: 'planner',
    });
  });

  it('rejects unsupported provider matrix', () => {
    expect(() => parseAskArgs(['openai', 'hi'])).toThrow(/Invalid provider/i);
  });
});

describe('omc ask command', () => {
  it('accepts canonical advisor env and forwards prompt/task to advisor', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omc-ask-canonical-'));
    try {
      const stubPath = writeAdvisorStub(wd);
      const result = runCli(
        ['ask', 'claude', '--print', 'hello world'],
        wd,
        { OMC_ASK_ADVISOR_SCRIPT: stubPath },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');

      const payload = JSON.parse(result.stdout);
      expect(payload).toEqual({
        provider: 'claude',
        prompt: 'hello world',
        originalTask: 'hello world',
        passthrough: null,
      });
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('accepts OMX advisor env alias in Phase-1 and emits deprecation warning', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omc-ask-alias-'));
    try {
      const stubPath = writeAdvisorStub(wd);
      const result = runCli(
        ['ask', 'gemini', 'legacy', 'path'],
        wd,
        { OMX_ASK_ADVISOR_SCRIPT: stubPath },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('DEPRECATED');
      expect(result.stderr).toContain('OMX_ASK_ADVISOR_SCRIPT');

      const payload = JSON.parse(result.stdout);
      expect(payload.provider).toBe('gemini');
      expect(payload.prompt).toBe('legacy path');
      expect(payload.originalTask).toBe('legacy path');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('allows codex ask inside a Claude Code session', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omc-ask-cli-codex-nested-'));
    try {
      const stubPath = writeAdvisorStub(wd);
      const result = runCli(
        ['ask', 'codex', '--prompt', 'cli nested codex prompt'],
        wd,
        {
          OMC_ASK_ADVISOR_SCRIPT: stubPath,
          CLAUDECODE: '1',
        },
        { preserveClaudeSessionEnv: true },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('Nested launches are not supported');

      const payload = JSON.parse(result.stdout);
      expect(payload).toEqual({
        provider: 'codex',
        prompt: 'cli nested codex prompt',
        originalTask: 'cli nested codex prompt',
        passthrough: null,
      });
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('allows gemini ask inside a Claude Code session', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omc-ask-cli-gemini-nested-'));
    try {
      const stubPath = writeAdvisorStub(wd);
      const result = runCli(
        ['ask', 'gemini', '--prompt', 'cli nested gemini prompt'],
        wd,
        {
          OMC_ASK_ADVISOR_SCRIPT: stubPath,
          CLAUDECODE: '1',
        },
        { preserveClaudeSessionEnv: true },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('Nested launches are not supported');

      const payload = JSON.parse(result.stdout);
      expect(payload.provider).toBe('gemini');
      expect(payload.prompt).toBe('cli nested gemini prompt');
      expect(payload.originalTask).toBe('cli nested gemini prompt');
      expect(payload.passthrough).toBeNull();
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('loads --agent-prompt role from resolved prompts dir and prepends role content', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omc-ask-agent-prompt-'));
    try {
      const stubPath = writeAdvisorStub(wd);
      mkdirSync(join(wd, '.omx'), { recursive: true });
      mkdirSync(join(wd, '.codex', 'prompts'), { recursive: true });
      writeFileSync(join(wd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }), 'utf8');
      writeFileSync(join(wd, '.codex', 'prompts', 'executor.md'), 'ROLE HEADER\nFollow checks.', 'utf8');

      const result = runCli(
        ['ask', 'claude', '--agent-prompt=executor', '--prompt', 'ship feature'],
        wd,
        { OMC_ASK_ADVISOR_SCRIPT: stubPath },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);

      const payload = JSON.parse(result.stdout);
      expect(payload.originalTask).toBe('ship feature');
      expect(payload.prompt).toContain('ROLE HEADER');
      expect(payload.prompt).toContain('ship feature');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });
});

describe('run-provider-advisor script contract', () => {
  it('writes artifact to .omc/artifacts/ask/{provider}-{slug}-{timestamp}.md', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omc-ask-artifact-'));
    try {
      const binDir = writeFakeProviderBinary(wd, 'claude');
      const result = runAdvisorScript(
        ['claude', '--print', 'artifact path contract'],
        wd,
        { PATH: `${binDir}:${process.env.PATH || ''}` },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);

      const artifactPath = result.stdout.trim();
      expect(artifactPath).toContain(join('.omc', 'artifacts', 'ask', 'claude-artifact-path-contract-'));
      expect(existsSync(artifactPath)).toBe(true);

      const artifact = readFileSync(artifactPath, 'utf8');
      expect(artifact).toContain('FAKE_PROVIDER_OK:artifact path contract');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('accepts OMX original-task alias in Phase-1 with deprecation warning', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omc-ask-original-alias-'));
    try {
      const binDir = writeFakeProviderBinary(wd, 'gemini');
      const result = runAdvisorScript(
        ['gemini', '--prompt', 'fallback task'],
        wd,
        {
          PATH: `${binDir}:${process.env.PATH || ''}`,
          OMX_ASK_ORIGINAL_TASK: 'legacy original task',
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('DEPRECATED');
      expect(result.stderr).toContain('OMX_ASK_ORIGINAL_TASK');

      const artifactPath = result.stdout.trim();
      const artifact = readFileSync(artifactPath, 'utf8');
      expect(artifact).toContain('## Original task\n\nlegacy original task');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it.each([
    ['claude', ['claude', '--prompt', 'nested claude prompt']],
    ['codex', ['codex', '--prompt', 'nested codex prompt']],
    ['gemini', ['gemini', '--prompt', 'nested gemini prompt']],
  ] as const)('strips Claude session env vars for %s advisor spawns', (provider, args) => {
    const wd = mkdtempSync(join(tmpdir(), `omc-ask-${provider}-advisor-env-`));
    try {
      const capturePath = join(wd, 'spawn-sync-calls.json');
      const preludePath = writeSpawnSyncCapturePrelude(wd);
      const result = runAdvisorScriptWithPrelude(
        preludePath,
        args,
        wd,
        {
          SPAWN_CAPTURE_PATH: capturePath,
          CLAUDECODE: '1',
          CLAUDE_SESSION_ID: 'session-123',
          CLAUDECODE_SESSION_ID: 'session-legacy',
          CLAUDE_CODE_ENTRYPOINT: 'plugin',
        },
        { preserveClaudeSessionEnv: true },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);

      const calls = JSON.parse(readFileSync(capturePath, 'utf8')) as Array<{
        command: string;
        args: string[];
        options: {
          shell: boolean;
          encoding: string | null;
          stdio: string | null;
          input: string | null;
          env: Record<string, string | null>;
        };
      }>;

      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.options.env).toMatchObject({
          CLAUDECODE: null,
          CLAUDE_SESSION_ID: null,
          CLAUDECODE_SESSION_ID: null,
          CLAUDE_CODE_ENTRYPOINT: null,
        });
      }
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('sanitizes Rust env vars for codex so artifacts do not capture Rust stderr logs', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omc-ask-codex-rust-env-'));
    try {
      const binDir = writeFakeCodexBinary(wd);
      const result = runAdvisorScript(
        ['codex', '--prompt', 'keep artifact small'],
        wd,
        {
          PATH: `${binDir}:${process.env.PATH || ''}`,
          RUST_LOG: 'trace',
          RUST_BACKTRACE: '1',
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');

      const artifactPath = result.stdout.trim();
      const artifact = readFileSync(artifactPath, 'utf8');
      expect(artifact).toContain('CODEX_OK');
      expect(artifact).not.toContain('RUST_LEAK');
      expect(artifact).not.toContain('trace');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('pipes the Windows codex prompt over stdin to avoid shell arg splitting', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omc-ask-codex-win32-shell-'));
    try {
      const capturePath = join(wd, 'spawn-sync-calls.json');
      const preludePath = writeSpawnSyncCapturePrelude(wd);
      const result = runAdvisorScriptWithPrelude(
        preludePath,
        ['codex', '--prompt', 'windows cmd support 你好'],
        wd,
        { SPAWN_CAPTURE_PATH: capturePath },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);

      const calls = JSON.parse(readFileSync(capturePath, 'utf8')) as Array<{
        command: string;
        args: string[];
        options: { shell: boolean; encoding: string | null; stdio: string | null; input: string | null };
      }>;

      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        command: 'codex',
        args: ['--version'],
        options: { shell: true, encoding: 'utf8', stdio: 'ignore', input: null },
      });
      expect(calls[1]).toMatchObject({
        command: 'codex',
        args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '-'],
        options: { shell: true, encoding: 'utf8', stdio: null, input: 'windows cmd support 你好' },
      });
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('pipes the Windows gemini prompt over stdin to avoid --prompt conflicts and AttachConsole failures', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omc-ask-gemini-win32-stdin-'));
    try {
      const capturePath = join(wd, 'spawn-sync-calls.json');
      const preludePath = writeSpawnSyncCapturePrelude(wd);
      const result = runAdvisorScriptWithPrelude(
        preludePath,
        ['gemini', '--prompt', 'ship safely 你好'],
        wd,
        { SPAWN_CAPTURE_PATH: capturePath },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);

      const calls = JSON.parse(readFileSync(capturePath, 'utf8')) as Array<{
        command: string;
        args: string[];
        options: { shell: boolean; encoding: string | null; stdio: string | null; input: string | null };
      }>;

      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        command: 'gemini',
        args: ['--version'],
        options: { shell: true, encoding: 'utf8', stdio: 'ignore', input: null },
      });
      expect(calls[1]).toMatchObject({
        command: 'gemini',
        args: ['--yolo'],
        options: { shell: true, encoding: 'utf8', stdio: null, input: 'ship safely 你好' },
      });
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('shows install guidance when a Windows codex binary is missing under shell:true', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omc-ask-codex-win32-missing-'));
    try {
      const capturePath = join(wd, 'spawn-sync-calls.json');
      const preludePath = writeSpawnSyncCapturePrelude(wd);
      const result = runAdvisorScriptWithPrelude(
        preludePath,
        ['codex', '--prompt', 'windows missing binary'],
        wd,
        {
          SPAWN_CAPTURE_PATH: capturePath,
          SPAWN_CAPTURE_MODE: 'missing',
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Missing required local CLI binary: codex');
      expect(result.stderr).toContain('codex --version');

      const calls = JSON.parse(readFileSync(capturePath, 'utf8')) as Array<{
        command: string;
        args: string[];
        options: { shell: boolean; encoding: string | null; stdio: string | null; input: string | null };
      }>;

      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        command: 'codex',
        args: ['--version'],
        options: { shell: true, encoding: 'utf8', stdio: 'ignore', input: null },
      });
      expect(calls[1]).toMatchObject({
        command: 'where',
        args: ['codex'],
      });
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });
});

describe('resolveAskAdvisorScriptPath', () => {
  it('resolves canonical env and supports package-root relative paths', () => {
    const packageRoot = '/tmp/pkg-root';
    expect(resolveAskAdvisorScriptPath(packageRoot, { OMC_ASK_ADVISOR_SCRIPT: 'scripts/custom.js' } as NodeJS.ProcessEnv))
      .toBe('/tmp/pkg-root/scripts/custom.js');
    expect(resolveAskAdvisorScriptPath(packageRoot, { OMC_ASK_ADVISOR_SCRIPT: '/opt/custom.js' } as NodeJS.ProcessEnv))
      .toBe('/opt/custom.js');
  });
});
