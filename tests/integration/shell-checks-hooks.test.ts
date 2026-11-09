/**
 * Shell checks wired into the real hook scripts (OMC_SHELL_CHECKS=1): pre-tool-enforcer.mjs denies or warns,
 * post-tool-verifier.mjs and post-tool-use-failure.mjs record error classes. Without the variable the hooks must
 * behave as before and leave no log. Expected decisions depend on the platform of the machine running the test:
 * the Windows-only checks (length, CR parser bug, backslash halving) run only on win32.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const onWindows = process.platform === 'win32';
const SYNTAX_LIMIT = '3000'; // the cap of the variable; a loaded machine must not turn a slow bash -n into a skipped check
const haveBash = (await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'shell-checks.mjs')).href)).findBashForSyntax() !== null;

type HookJson = { continue?: boolean; suppressOutput?: boolean; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };
type HookResult = { code: number | null; stdout: string; stderr: string; json: HookJson | null };

const BODY = 'a line of here-document text that makes the command long enough for the truncation check 0123456789\n';
function longCommand(): string {
  const head = "cat > /tmp/omc-test-long.txt <<'EOF'\n";
  const tail = '\nEOF\nwc -c /tmp/omc-test-long.txt';
  let middle = '';
  while (head.length + middle.length + tail.length < 8000) middle += BODY;
  return head + middle.slice(0, 8000 - head.length - tail.length).replace(/\n$/, 'x') + tail;
}

describe('shell checks in the hooks', () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let counter = 0;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shell-checks-'));
    env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      // where findBashForSyntax looks for Git Bash on Windows
      ProgramFiles: process.env.ProgramFiles,
      ProgramW6432: process.env.ProgramW6432,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH,
      HOME: cwd,
      USERPROFILE: cwd,
      XDG_CONFIG_HOME: join(cwd, 'config'),
      CLAUDE_CONFIG_DIR: join(cwd, 'claude'),
      NODE_NO_WARNINGS: '1',
      OMC_DISABLE_MULTIREPO: '1',
      OMC_STATE_DIR: join(cwd, '.omc'),
      OMC_PRE_TOOL_ADVISORY_COOLDOWN_MS: '0',
    };
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  const session = () => `shell-checks-${process.pid}-${++counter}`;

  function runHook(script: string, input: unknown, extraEnv: Record<string, string> = {}, scriptsRoot = ROOT): HookResult {
    const result = spawnSync(process.execPath, [join(scriptsRoot, 'scripts', script)], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      cwd,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    });
    let json: HookJson | null = null;
    try { json = JSON.parse(result.stdout); } catch { /* not JSON */ }
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
  }

  const preInput = (command: string, tool = 'Bash', sid = session()) => ({
    hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, tool_use_id: `toolu_${sid}`, cwd, session_id: sid, permission_mode: 'bypassPermissions',
  });
  const decision = (r: HookResult) => r.json?.hookSpecificOutput?.permissionDecision;
  const context = (r: HookResult) => String(r.json?.hookSpecificOutput?.additionalContext ?? '');

  function findFiles(dir: string, name: string): string[] {
    if (!existsSync(dir)) return [];
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...findFiles(path, name));
      else if (entry.name === name) found.push(path);
    }
    return found;
  }
  const rows = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

  it('does nothing without OMC_SHELL_CHECKS=1 (also for 0, true and empty), and writes no log', () => {
    const logDir = join(cwd, 'logs');
    for (const value of [undefined, '', '0', 'true', 'yes']) {
      const extra: Record<string, string> = { OMC_SHELL_CHECKS_LOG_DIR: logDir };
      if (value !== undefined) extra.OMC_SHELL_CHECKS = value;
      for (const [tool, command] of [['Bash', longCommand()], ['Bash', 'echo "$(echo hi) $(printf %s $\'\\r\' | wc -c)"'], ['Bash', 'echo "never closed'], ['PowerShell', 'ssh host "ls \\$HOME"']]) {
        const result = runHook('pre-tool-enforcer.mjs', preInput(command, tool), extra);
        expect(result.code).toBe(0);
        expect(decision(result)).not.toBe('deny');
        expect(context(result)).not.toContain('[SHELL CHECK]');
      }
    }
    const failure = runHook('post-tool-use-failure.mjs', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'ls' }, error: "bash: -c: line 1: unexpected EOF while looking for matching `''", cwd, session_id: session() }, { OMC_SHELL_CHECKS_LOG_DIR: logDir });
    expect(failure.code).toBe(0);
    expect(existsSync(logDir)).toBe(false);
    expect(findFiles(join(cwd, '.omc'), 'checks.jsonl')).toEqual([]);
    expect(findFiles(join(cwd, '.omc'), 'errors.jsonl')).toEqual([]);
  });

  it('with OMC_SHELL_CHECKS=1 denies or warns as the platform requires and logs one row per command', () => {
    const logDir = join(cwd, 'logs');
    const extra = { OMC_SHELL_CHECKS: '1', OMC_SHELL_CHECKS_LOG_DIR: logDir, OMC_SHELL_SYNTAX_TIMEOUT_MS: SYNTAX_LIMIT };
    const secret = 'sk-secret1234567890abcd';
    const unclosed = 'echo "this command is longer than two hundred characters so that the syntax check also runs on Windows, where it covers only longer commands; the double quote is never closed until the end of the command';
    const valid = 'git -C "E:/repo" status --short | head -20; echo "state: $(date \'+%F %T\')"; ls -la \'E:/repo/docs\' | head -5; printf \'%s\\n\' "end of the check, which is longer than two hundred characters and syntactically valid"';
    const table: Array<[string, string, 'deny' | 'warn' | 'allow']> = [
      ['Bash', `${longCommand()}\necho API_KEY=${secret}`, onWindows ? 'deny' : 'allow'],
      ['Bash', 'echo "$(echo hi) $(printf %s $\'\\r\' | wc -c)"', onWindows ? 'deny' : 'allow'],
      ['Bash', unclosed, haveBash ? 'deny' : 'allow'],
      ['Bash', valid, 'allow'],
      ['Bash', "printf '%s\\n' 'C:\\\\Users\\\\x'", onWindows ? 'warn' : 'allow'],
      ['PowerShell', 'ssh host "ls \\$HOME; echo \\$(date)"', 'warn'],
      ['PowerShell', 'Get-ChildItem C:\\missing 2>/dev/null', onWindows ? 'warn' : 'allow'],
    ];
    for (const [tool, command, expected] of table) {
      const sid = session();
      const result = runHook('pre-tool-enforcer.mjs', preInput(command, tool, sid), extra);
      expect(result.code, result.stderr).toBe(0);
      if (expected === 'deny') {
        expect(decision(result), result.stdout.slice(0, 300)).toBe('deny');
        expect(String(result.json?.hookSpecificOutput?.permissionDecisionReason).startsWith('[SHELL CHECK] ')).toBe(true);
      } else {
        expect(decision(result), result.stdout.slice(0, 300)).not.toBe('deny');
        expect(context(result).includes('[SHELL CHECK]'), `${tool}: ${context(result).slice(0, 120)}`).toBe(expected === 'warn');
        if (expected === 'warn') {
          expect(result.json?.suppressOutput).toBeUndefined(); // the warning is meant to be seen
        } else {
          // no finding: the output is exactly what the hook emits without the checks (PowerShell has no
          // advisory of its own, so there the hook stays silent with suppressOutput: true)
          expect(result.json).toEqual(runHook('pre-tool-enforcer.mjs', preInput(command, tool, session())).json);
        }
      }
      const logged = rows(join(logDir, 'checks.jsonl')).filter((row) => row.session_id === sid);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ point: 'shell-check', decision: expected, tool_use_id: `toolu_${sid}`, tool_name: tool, platform: process.platform });
      expect(typeof logged[0].durationMs).toBe('number');
      expect(typeof logged[0].command === 'string').toBe(expected === 'deny');
      if (logged[0].command) {
        expect(logged[0].command.length).toBeLessThanOrEqual(300);
        expect(JSON.stringify(logged[0])).not.toContain(secret);
      }
    }
  });

  it('writes the log under the state root when OMC_SHELL_CHECKS_LOG_DIR is not set', () => {
    const sid = session();
    const extra = { OMC_SHELL_CHECKS: '1' };
    expect(runHook('pre-tool-enforcer.mjs', preInput('echo ok', 'Bash', sid), extra).code).toBe(0);
    expect(runHook('post-tool-use-failure.mjs', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'ls' }, error: "bash: -c: line 1: unexpected EOF while looking for matching `''", cwd, session_id: sid }, extra).code).toBe(0);
    const checks = findFiles(join(cwd, '.omc'), 'checks.jsonl');
    const errors = findFiles(join(cwd, '.omc'), 'errors.jsonl');
    expect(checks.flatMap(rows).some((row) => row.session_id === sid)).toBe(true);
    expect(errors.flatMap(rows).some((row) => row.session_id === sid)).toBe(true);
    expect(checks[0]).toContain(join('state', 'shell-checks'));
  });

  it('adds a warning to the context the rest of the hook emits instead of replacing it', () => {
    const extra = { OMC_SHELL_CHECKS: '1', OMC_SHELL_CHECKS_LOG_DIR: join(cwd, 'logs') };
    const command = "printf '%s\\n' 'C:\\\\Users\\\\x'";
    const plain = runHook('pre-tool-enforcer.mjs', preInput(command, 'Bash', session()));
    const checked = runHook('pre-tool-enforcer.mjs', preInput(command, 'Bash', session()), extra);
    expect(checked.code).toBe(0);
    if (!onWindows) {
      expect(context(checked)).toBe(context(plain));
      return;
    }
    const warning = context(checked).split('\n\n')[0];
    expect(warning.startsWith('[SHELL CHECK] ')).toBe(true);
    expect(context(checked)).toBe(context(plain) ? `${warning}\n\n${context(plain)}` : warning);
  });

  it('never blocks on its own failure: a broken shell-checks.mjs gives the output of the hook without the variable', () => {
    const copy = join(cwd, 'plugin-copy');
    for (const part of ['scripts', 'hooks', 'package.json']) cpSync(join(ROOT, part), join(copy, part), { recursive: true });
    writeFileSync(join(copy, 'scripts', 'lib', 'shell-checks.mjs'), "throw new Error('broken');\n");
    const input = preInput('echo "never closed', 'Bash', 'shell-checks-broken');
    const withVariable = runHook('pre-tool-enforcer.mjs', input, { OMC_SHELL_CHECKS: '1' }, copy);
    const without = runHook('pre-tool-enforcer.mjs', input, {}, copy);
    expect(withVariable.code).toBe(0);
    expect(without.code).toBe(0);
    expect(withVariable.stdout).toBe(without.stdout);
    expect(decision(withVariable)).not.toBe('deny');
    const post = [
      ['post-tool-verifier.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '', stderr: "bash: -c: line 1: unexpected EOF while looking for matching `''" }, cwd, session_id: 'shell-checks-broken' }],
      ['post-tool-use-failure.mjs', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'ls' }, error: 'Exit code 2', cwd, session_id: 'shell-checks-broken' }],
    ] as const;
    for (const [script, payload] of post) {
      const a = runHook(script, payload, { OMC_SHELL_CHECKS: '1' }, copy);
      const b = runHook(script, payload, {}, copy);
      expect(a.code).toBe(0);
      expect(a.stdout).toBe(b.stdout);
    }
  });

  it('exits 0 with continue:true on broken JSON input in all three hooks', () => {
    for (const script of ['pre-tool-enforcer.mjs', 'post-tool-verifier.mjs', 'post-tool-use-failure.mjs']) {
      const result = runHook(script, '{"tool_name": "Bash", "tool_input": {', { OMC_SHELL_CHECKS: '1' });
      expect(result.code, script).toBe(0);
      expect(result.stdout, script).toMatch(/"continue":\s*true/);
    }
  });

  it('records error classes of Bash and PowerShell results with their cause, without false rows', () => {
    const logDir = join(cwd, 'logs');
    const extra = { OMC_SHELL_CHECKS: '1', OMC_SHELL_CHECKS_LOG_DIR: logDir };
    const long = longCommand();
    const eof = "/usr/bin/bash: -c: line 60: unexpected EOF while looking for matching `''";
    const cr = 'echo "$(echo hi) $(printf %s $\'\\r\' | wc -c)"';
    type Case = [script: string, tool: string, command: string, fields: Record<string, unknown>, classes: string[], cause: string | null];
    const table: Case[] = [
      ['post-tool-use-failure.mjs', 'Bash', long, { error: `Exit code 2\n${eof}` }, ['unexpected-eof'], onWindows ? 'truncation' : 'manual'],
      ['post-tool-use-failure.mjs', 'Bash', cr, { error: "Exit code 2\nbash: eval: line 1: unexpected EOF while looking for matching `)'" }, ['unexpected-eof'], onWindows ? 'parser-bug' : 'manual'],
      ['post-tool-use-failure.mjs', 'Bash', 'echo "never closed', { error: `Exit code 2\n${eof}` }, ['unexpected-eof'], 'manual'],
      ['post-tool-verifier.mjs', 'Bash', long, { tool_response: { stdout: 'saved', stderr: "/usr/bin/bash: -c: line 61: warning: here-document at line 1 delimited by end-of-file (wanted `EOF')" } }, ['heredoc-eof'], onWindows ? 'truncation' : 'manual'],
      ['post-tool-use-failure.mjs', 'Bash', 'x'.repeat(30000), { error: 'Error: spawn ENAMETOOLONG' }, ['enametoolong'], null],
      ['post-tool-verifier.mjs', 'Bash', 'python3 -c "print(\'x\')"', { tool_response: { stdout: 'x', stderr: "<string>:1: SyntaxWarning: invalid escape sequence '\\.'" } }, ['python-invalid-escape'], null],
      ['post-tool-use-failure.mjs', 'Bash', 'C:\\Windows\\System32\\OpenSSH\\ssh.exe host ls', { error: 'Exit code 127\n/usr/bin/bash: line 1: C:WindowsSystem32OpenSSHssh.exe: command not found' }, ['win-path-not-found'], null],
      ['post-tool-use-failure.mjs', 'PowerShell', 'Get-ChildItem x 2>/dev/null', { error: "Out-File: Could not find a part of the path 'C:\\dev\\null'." }, ['ps-dev-null'], null],
      ['post-tool-verifier.mjs', 'Bash', 'grep -rn "unexpected EOF" logs/', { tool_response: { stdout: "logs/a.txt:3:bash: -c: line 1: unexpected EOF while looking for matching `''\nlogs/b.txt:9:  ENAMETOOLONG in a note", stderr: '' } }, [], null],
      ['post-tool-verifier.mjs', 'Read', 'x', { tool_response: "bash: -c: line 1: unexpected EOF while looking for matching `''" }, [], null],
    ];
    for (const [script, tool, command, fields, classes, cause] of table) {
      const sid = session();
      const input = { hook_event_name: script.startsWith('post-tool-use-failure') ? 'PostToolUseFailure' : 'PostToolUse', tool_name: tool, tool_input: { command }, tool_use_id: `toolu_${sid}`, cwd, session_id: sid, ...fields };
      const result = runHook(script, input, extra);
      expect(result.code, `${script}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toMatch(/"continue":\s*true/);
      const logged = rows(join(logDir, 'errors.jsonl')).filter((row) => row.session_id === sid);
      if (!classes.length) {
        expect(logged, `${script} ${tool}`).toEqual([]);
        continue;
      }
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ point: 'shell-error', classes, tool_use_id: `toolu_${sid}`, hook: script.replace('.mjs', ''), is_error: script.startsWith('post-tool-use-failure') });
      expect(logged[0].cause ?? null).toBe(cause);
      if (command.length >= 40) expect(JSON.stringify(logged[0])).not.toContain(command.slice(0, 40));
    }
  });
});
