/**
 * Shell command checks (scripts/lib/shell-checks.mjs): the pure functions.
 *
 * Every case of tests/fixtures/shell-checks/cases.txt is run for both platform behaviours (win32 = Git Bash on
 * Windows, linux = Linux and macOS with a Homebrew bash) on whatever machine runs the test, because the platform is a
 * parameter of the check. On Windows a few sentinel tests also compare the model of Git Bash (cut at about 8190
 * characters, halved backslashes, the CR parser bug) with the real bash.exe, so they fail on purpose when a Git for
 * Windows update changes that behaviour.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lib: any = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'shell-checks.mjs')).href);

type Expected = { decision: 'allow' | 'deny'; checks: string[] };
type Case = { id: string; tool: string; win32: Expected; linux: Expected; description: string; command: string };

function loadCases(): Case[] {
  const text = readFileSync(join(ROOT, 'tests', 'fixtures', 'shell-checks', 'cases.txt'), 'utf8').replace(/\r\n/g, '\n');
  return text.split(/^(?==== )/m).filter((block) => block.startsWith('=== ')).map((block) => {
    const newline = block.indexOf('\n');
    const [id, tool, win, linux, ...description] = block.slice(4, newline).split(' | ').map((part) => part.trim());
    const expected = (field: string, name: string): Expected => {
      const match = new RegExp(`^${name}: (allow|deny) (\\S+)$`).exec(field);
      if (!match) throw new Error(`cases.txt ${id}: bad field "${field}"`);
      return { decision: match[1] as 'allow' | 'deny', checks: match[2] === '-' ? [] : match[2].split(',').sort() };
    };
    return { id, tool, win32: expected(win, 'win'), linux: expected(linux, 'linux'), description: description.join(' | '), command: block.slice(newline + 1).replace(/\n$/, '') };
  });
}

const cases = loadCases();
const bashPath: string | null = lib.findBashForSyntax();
const GIT_BASH: string | null = process.platform === 'win32' ? lib.findBashForSyntax('win32') : null;
const onWindows = process.platform === 'win32' && GIT_BASH !== null && existsSync(GIT_BASH);

// A command shaped like a long here-document with an exact effective length: chars + 4 x apostrophes + 460.
function commandOfEffectiveLength(effective: number, apostrophes = 2): string {
  const head = "cat > /tmp/omc-test-length.txt <<'EOF'\n";
  const tail = '\nEOF\nwc -c /tmp/omc-test-length.txt';
  const quotes = "'x' ".repeat(Math.max(0, (apostrophes - 2) / 2));
  const chars = effective - lib.LENGTH_WRAPPER - lib.APOSTROPHE_EXTRA * apostrophes;
  let middle = quotes;
  while (middle.length < chars - head.length - tail.length) middle += 'a line of here-document text for the truncation boundary tests 0123456789\n';
  middle = middle.slice(0, chars - head.length - tail.length).replace(/\n$/, 'x');
  const command = head + middle + tail;
  const count = command.split("'").length - 1;
  if (count !== apostrophes || command.length + lib.APOSTROPHE_EXTRA * count + lib.LENGTH_WRAPPER !== effective) {
    throw new Error(`commandOfEffectiveLength(${effective}, ${apostrophes}): ${command.length} characters, ${count} apostrophes`);
  }
  return command;
}

describe('shell checks: cases', () => {
  it('has unique ids and only known checks', () => {
    const known = new Set(['length', 'cr-parser', 'syntax', 'heredoc', 'backslash', 'ps-ssh-dollar', 'ps-dev-null']);
    expect(cases.length).toBeGreaterThan(60);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) for (const e of [c.win32, c.linux]) for (const check of e.checks) expect(known.has(check), `${c.id}: ${check}`).toBe(true);
  });

  describe.skipIf(!bashPath)('each case on both platform behaviours', () => {
    it.each(cases.map((c) => [c.id, c.description, c] as const))('%s %s', (_id, _description, c) => {
      for (const platform of ['win32', 'linux'] as const) {
        const result = c.tool === 'Bash'
          ? lib.checkBashCommand(c.command, { platform, bashPath, timeoutMs: 15000 })
          : lib.checkPowerShellCommand(c.command, { platform });
        const expected = c[platform];
        expect(`${platform}: ${result.decision} [${[...result.checks].sort()}]`).toBe(`${platform}: ${expected.decision} [${expected.checks}]`);
        if (result.decision === 'deny') {
          expect(result.reason.startsWith('[SHELL CHECK] ')).toBe(true);
          expect(result.context).toBe('');
        } else if (expected.checks.length) {
          expect(result.context.startsWith('[SHELL CHECK] ')).toBe(true);
        } else {
          expect(result.context).toBe('');
        }
      }
    });
  });
});

describe.skipIf(!bashPath)('shell checks: length boundary', () => {
  it.each([
    [7000, 2, 'allow'], [7699, 2, 'allow'], [7700, 2, 'deny'], [7900, 2, 'deny'], [8190, 2, 'deny'],
    [7690, 300, 'allow'], [7710, 300, 'deny'], [30000, 2, 'deny'],
  ] as const)('effective length %i with %i apostrophes: win32 %s, linux allow', (effective, apostrophes, decision) => {
    const command = commandOfEffectiveLength(effective, apostrophes);
    const win = lib.checkBashCommand(command, { platform: 'win32', bashPath, timeoutMs: 15000 });
    const linux = lib.checkBashCommand(command, { platform: 'linux', bashPath, timeoutMs: 15000 });
    expect(win.decision).toBe(decision);
    expect(win.checks.includes('length')).toBe(decision === 'deny');
    expect(win.length).toMatchObject({ effective, chars: command.length });
    if (decision === 'deny') {
      expect(win.reason).toContain(`The command has ${String(command.length).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} characters`);
      expect(win.reason).toContain('Write the script to a file');
      expect(win.reason).toContain('on stdin');
      expect(win.reason).toContain('8 190');
      expect(win.syntax.ran).toBe(false); // no bash -n for a command that is denied anyway
    }
    expect(linux.decision).toBe('allow');
    expect(linux.checks.includes('length')).toBe(false);
  });

  it('honors OMC_SHELL_CHECKS_LENGTH_LIMIT only inside 1000-100000', () => {
    const command = commandOfEffectiveLength(7000, 2);
    const at = (value: string | undefined) => lib.checkBashCommand(command, { platform: 'win32', bashPath, env: { ...process.env, OMC_SHELL_CHECKS_LENGTH_LIMIT: value }, timeoutMs: 15000 }).decision;
    expect(at(undefined)).toBe('allow');
    expect(at('6000')).toBe('deny');
    expect(at('9000')).toBe('allow');
    for (const bad of ['', 'abc', '999', '100001', '7000.5']) expect(at(bad)).toBe('allow');
    expect(lib.lengthDenyAt({ OMC_SHELL_CHECKS_LENGTH_LIMIT: '1000' })).toBe(1000);
    expect(lib.lengthDenyAt({})).toBe(7700);
  });
});

// Each sentinel starts Git Bash up to 32 times (about 0.1-1 s each on Windows), more than the default 30 s test timeout allows.
describe.skipIf(!onWindows)('shell checks: sentinels against the real Git Bash (Windows only)', { timeout: 180_000 }, () => {
  const run = (args: string[], options: Record<string, unknown> = {}) => spawnSync(GIT_BASH as string, args, { encoding: 'utf8', windowsHide: true, timeout: 20000, ...options });

  it('Git Bash still cuts the -c argument at about 8190 characters (8185 passes, 8195 is cut)', () => {
    const output = (n: number) => run(['-c', `echo ${'x'.repeat(n - 15)}; echo END`]).stdout;
    expect(output(8185)).toContain('END');
    expect(output(8195)).not.toContain('END');
  });

  // The Bash tool of Claude Code 2.1.318 runs bash -c "source <snapshot> ... && eval '<command>' < /dev/null && pwd -P >| <file>"
  // with every ' of the command written as '"'"' (the wrapper measured about 451 characters).
  const BEFORE = "source /c/Users/user/.claude/shell-snapshots/snapshot-bash-1762671234567-abcdef.sh 2>/dev/null || true && export TEMP='E:\\Temp' TMP='E:\\Temp' && shopt -u extglob 2>/dev/null || true && { \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval '";
  const AFTER = "' < /dev/null && pwd -P >| /d/Temp/claude-5345-cwd";
  const wrapped = (command: string) => BEFORE + command.split("'").join("'\"'\"'") + AFTER;
  const echoOfEffectiveLength = (effective: number, apostrophes: number) => {
    const quotes = "'a' ".repeat(apostrophes / 2);
    const end = '; echo END';
    const command = 'echo ' + quotes + 'x'.repeat(effective - lib.LENGTH_WRAPPER - lib.APOSTROPHE_EXTRA * apostrophes - 5 - end.length - quotes.length) + end;
    expect(lib.effectiveBashLength(command).effective).toBe(effective);
    return command;
  };

  it('the effective length formula separates the commands that survive the Bash tool wrapper from the ones that are cut', () => {
    for (const [effective, apostrophes, survives] of [[7699, 0, true], [7699, 400, true], [7699, 800, true], [8300, 0, false], [8300, 400, false]] as const) {
      const command = echoOfEffectiveLength(effective, apostrophes);
      const result = run(['-c', wrapped(command)]);
      expect(result.stdout.includes('END'), `effective ${effective}, apostrophes ${apostrophes}`).toBe(survives);
      expect(lib.checkBashCommand(command, { platform: 'win32', syntax: false }).decision === 'deny').toBe(!survives);
    }
  });

  it('denies the CR parser pattern exactly where bash -c fails with unexpected EOF', () => {
    const differing: string[] = [];
    for (const c of cases.filter((x) => x.id.startsWith('B'))) {
      const result = run(['-c', c.command], { timeout: 10000 });
      const fails = /unexpected EOF while looking for matching/.test(result.stderr);
      if (fails !== c.win32.checks.includes('cr-parser')) differing.push(`${c.id}: bash ${fails ? 'fails' : 'passes'}`);
    }
    expect(differing).toEqual([]);
  });

  it('gitBashHalved matches what Git Bash does to runs of backslashes', () => {
    const BS = '\\';
    const differing: string[] = [];
    for (const text of [BS, BS + BS, BS + BS + BS, BS.repeat(4), BS.repeat(5), `a${BS}${BS}"`, `${BS}${BS}${BS}"`, `${BS}${BS}$`, `x${BS}${BS}y${BS}${BS}${BS}z`]) {
      const out = run(['-c', `printf '%s' '${text}'`]).stdout;
      if (out !== lib.gitBashHalved(text)) differing.push(`${JSON.stringify(text)}: bash ${JSON.stringify(out)}, model ${JSON.stringify(lib.gitBashHalved(text))}`);
    }
    // Inside a quoted here-document, including before ' and `.
    for (const text of [`A${BS}${BS}'B${BS}${BS}${BS}\`C`, `x${BS.repeat(4)}'y`, `${BS}${BS}\``, `${BS.repeat(3)}'`, `a${BS}${BS}${BS}"b`]) {
      const out = run(['-c', `cat <<'E'\n${text}\nE`]).stdout.replace(/\n$/, '');
      if (out !== lib.gitBashHalved(text)) differing.push(`here-document ${JSON.stringify(text)}: bash ${JSON.stringify(out)}, model ${JSON.stringify(lib.gitBashHalved(text))}`);
    }
    expect(differing).toEqual([]);
  });
});

describe('shell checks: tokenizer', () => {
  it('reads here-documents, command substitutions, case inside $(...), comments and descriptor redirections', () => {
    const t1 = lib.tokenizeBash("cat <<'EOF' > a\nx 'y\nEOF\necho \"$(case $a in b) echo c;; esac)\" # note 'n\nls 2>&1 | wc");
    expect(t1.heredocs).toHaveLength(1);
    expect(t1.heredocs[0]).toMatchObject({ terminated: true, delimiter: 'EOF', quoted: true, body: "x 'y\n" });
    expect(t1.errors).toEqual([]);
    const substitutions: Array<{ closed: boolean }> = [];
    lib.walkBashParts(t1.tokens, (part: { kind: string; closed: boolean }) => { if (part.kind === 'cmdsub') substitutions.push(part); });
    expect(substitutions).toHaveLength(1);
    expect(substitutions[0].closed).toBe(true);
    expect(t1.tokens.some((t: { type: string; text?: string }) => t.type === 'comment' && t.text === "# note 'n")).toBe(true);
    expect(t1.tokens.some((t: { type: string; value?: string; fd?: string }) => t.type === 'redir' && t.value === '>&' && t.fd === '2')).toBe(true);

    const t2 = lib.tokenizeBash('cat <<-X\n\tbody\n\tX\nx=$(cat <<Y\nb\nY)\necho "${a:-$(echo "}")}" $((1<<2))');
    expect(t2.heredocs.map((h: { terminated: boolean }) => h.terminated)).toEqual([true, true]);
    expect(t2.heredocs[1].nested).toBe(true);
    expect(t2.errors).toEqual([]);

    expect(lib.tokenizeBash("echo 'open\necho \"x").errors.some((e: { what: string }) => e.what === "'")).toBe(true);

    const t4 = lib.tokenizeBash('a=(1 "2 3") ; ls !(x) ; diff <(ls) >(cat)');
    const kinds: string[] = [];
    lib.walkBashParts(t4.tokens, (part: { kind: string }) => kinds.push(part.kind));
    expect(kinds.filter((k) => k === 'group')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'procsub')).toHaveLength(2);
    expect(t4.errors).toEqual([]);
  });

  it('does not close $(...) early on a subshell or a case pattern', () => {
    for (const source of ['$( (a) | b )', '$([[ x =~ ^(a|b)$ ]] && echo y)', '$((cd x; ls) | wc)', '$( (case a in (b) echo;; esac) )']) {
      const t = lib.tokenizeBash(source);
      const words = t.tokens.filter((x: { type: string }) => x.type === 'word');
      expect(t.errors, source).toEqual([]);
      expect(words, source).toHaveLength(1);
      expect(words[0].parts[0], source).toMatchObject({ kind: 'cmdsub', closed: true });
      expect(words[0].end, source).toBe(source.length);
    }
  });

  it('gives backticks and unquoted here-document bodies tokens, and quoted bodies none', () => {
    const t = lib.tokenizeBash('echo `rm -rf x` && cat <<EOF\n$(rm -rf y) `ls`\nEOF');
    const backticks: Array<{ tokens: Array<{ type: string }> }> = [];
    lib.walkBashParts(t.tokens, (part: { kind: string; tokens: Array<{ type: string }> }) => { if (part.kind === 'backtick') backticks.push(part); });
    expect(backticks).toHaveLength(1);
    expect(backticks[0].tokens.some((x) => x.type === 'word' && lib.wordValue(x) === 'rm')).toBe(true);
    const body = t.heredocs[0].parts as Array<{ kind: string }>;
    expect(body.some((part) => part.kind === 'cmdsub')).toBe(true);
    expect(body.some((part) => part.kind === 'backtick')).toBe(true);
    expect(lib.tokenizeBash("cat <<'EOF'\n$(x)\nEOF").heredocs[0].parts).toBeUndefined();
  });

  it('ends a literal part where the expansion after it starts', () => {
    const text = 'echo a$b "c$d" ${e:-f$g}';
    const t = lib.tokenizeBash(text);
    const summary: string[] = [];
    lib.walkBashParts(t.tokens, (part: { kind: string; text?: string }) => { if (part.kind === 'lit' || part.kind === 'param') summary.push(`${part.kind}:${part.text}`); });
    expect(summary).toEqual(['lit:echo', 'lit:a', 'param:$b', 'lit:c', 'param:$d', 'param:${e:-f$g}', 'lit:e:-f', 'param:$g']);
    expect(lib.wordText(t.tokens[1])).toBe('a\u0000');
  });

  it('takes a here-document delimiter literally, including expansions, and ignores a CR at the end of the closing line', () => {
    const delimiter = (source: string) => lib.tokenizeBash(source).heredocs[0];
    expect(delimiter('cat <<$EOF\nhi\n$EOF')).toMatchObject({ delimiter: '$EOF', terminated: true, quoted: false });
    expect(delimiter('cat <<"$X"\nhi\n$X')).toMatchObject({ delimiter: '$X', terminated: true, quoted: true });
    expect(delimiter("cat <<'A B'\nhi\nA B")).toMatchObject({ delimiter: 'A B', terminated: true });
    expect(delimiter('cat <<EOF\r\nhi\r\nEOF\r\n').terminated).toBe(true);
    expect(delimiter('cat <<EOF\nhi\nEOF x').terminated).toBe(false);
    for (const platform of ['win32', 'linux']) {
      expect(lib.checkBashCommand('cat <<$EOF\nhi\n$EOF', { platform, syntax: false }).decision).toBe('allow');
      expect(lib.checkBashCommand('cat <<EOF\r\nx\r\nEOF\r', { platform, syntax: false }).decision).toBe('allow');
    }
  });

  it('treats a carriage return as a word character', () => {
    const t = lib.tokenizeBash('rm\r x');
    expect(lib.wordValue(t.tokens[0])).toBe('rm\r');
  });

  it('splits PowerShell into code, strings, here-strings and comments', () => {
    const segments = lib.tokenizePowerShell("ssh h 'a''b' \"c `\" $(Get-X \"d\") e\" # \"f\"\n@'\nx \"y\n'@ <# g #> z");
    expect(segments.map((s: { kind: string }) => s.kind).join(',')).toBe('code,single,code,double,code,comment,code,here-single,code,comment,code');
  });

  it('survives extreme input quickly and reports too-deep nesting', () => {
    const inputs: Array<[string, string]> = [
      ['$( x15000', '$('.repeat(15000)], ['${ x10000', '${'.repeat(10000)], ['$(( x10000', '$(('.repeat(10000)],
      ['" x20000', '"'.repeat(20000)], ['` x10000', '`'.repeat(10000)], ['( x20000', '('.repeat(20000)],
      ['\\ x30000 before "', '\\'.repeat(30000) + '"'], ['\\ x30000', '\\'.repeat(30000)],
    ];
    for (const [label, input] of inputs) {
      const start = process.hrtime.bigint();
      const tokenized = lib.tokenizeBash(input);
      lib.findCrParserBug(input, tokenized);
      lib.gitBashHalved(input);
      lib.halvedBackslashRuns(input);
      const result = lib.checkBashCommand(input, { platform: 'win32', syntax: false });
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      expect(['allow', 'deny'], label).toContain(result.decision);
      expect(ms, `${label}: ${Math.round(ms)} ms`).toBeLessThan(2000);
    }
    expect(lib.tokenizeBash('$('.repeat(15000)).errors.some((e: { kind: string }) => e.kind === 'too-deep')).toBe(true);
  });
});

describe('shell checks: helpers', () => {
  it('recognizes the escapes that produce a carriage return in $\'...\'', () => {
    const yes = ['\\r', 'a\\rb', '\\015', '\\15', '\\x0d', '\\x0D', '\\u000d', '\\U0000000D', '\\cM', '\\cm', '\\x0de'];
    const no = ['\\t', '\\n', '\\\\r', '\\xd0', '\\x0', '\\0', 'r'];
    for (const text of yes) expect(lib.ansiProducesCarriageReturn(text), text).toBe(true);
    for (const text of no) expect(lib.ansiProducesCarriageReturn(text), text).toBe(false);
  });

  it('masks secrets and keeps ordinary paths', () => {
    const masked = lib.maskSecrets('curl -H "Authorization: Bearer abcdefghijklmnop" https://u:pass123@example.com API_KEY=sk-1234567890abcdefgh token=zxcvbnm12 ghp_abcdefghijklmnopqrstuvwx 0123456789abcdef0123456789abcdef01 E:/repo/docs/PLAN.md');
    for (const secret of ['abcdefghijklmnop', 'pass123', 'sk-1234567890abcdefgh', 'zxcvbnm12', 'ghp_abcdefghijklmnopqrstuvwx', '0123456789abcdef0123456789abcdef01']) expect(masked).not.toContain(secret);
    expect(masked).toContain('E:/repo/docs/PLAN.md');
    const masked2 = lib.maskSecrets("curl -u admin:SecretA x; mysql -uroot -pSecretB db; app --password SecretC --token=SecretD; sshpass -p SecretE ssh h; curl -H 'Cookie: session=abcdef1234567890F' x; python -c \"os.environ['API_KEY']='SecretG'\"");
    for (const secret of ['SecretA', 'SecretB', 'SecretC', 'SecretD', 'SecretE', 'abcdef1234567890F', 'SecretG']) expect(masked2).not.toContain(secret);
    expect(masked2).toContain('curl -u admin:');
    expect(masked2).toContain('mysql -uroot');
  });

  it('keeps OMC_SHELL_SYNTAX_TIMEOUT_MS inside 100-3000 ms, below the hook budget', () => {
    for (const [value, expected] of [[undefined, 1000], ['', 1000], ['abc', 1000], ['50', 1000], ['100', 100], ['2500', 2500], ['3000', 3000], ['3001', 1000], ['15000', 1000]] as const) {
      expect(lib.syntaxTimeoutMs(value === undefined ? {} : { OMC_SHELL_SYNTAX_TIMEOUT_MS: value }), String(value)).toBe(expected);
    }
  });

  it('classifies tool errors and ignores a grep that only lists the words', () => {
    const found = lib.classifyToolErrors(["/usr/bin/bash: -c: line 60: unexpected EOF while looking for matching `''"]);
    expect(found.map((f: { class: string }) => f.class)).toEqual(['unexpected-eof']);
    expect(lib.classifyToolErrors(["logs/a.txt:3:bash: -c: line 1: unexpected EOF while looking for matching `''\nlogs/b.txt:9:  ENAMETOOLONG in a note"])).toEqual([]);
    expect(lib.classifyToolErrors(['Error: spawn ENAMETOOLONG']).map((f: { class: string }) => f.class)).toEqual(['enametoolong']);
  });
});

describe('shell checks: logs', () => {
  it('renames a log above 50 MB and keeps the newest two renamed files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shell-checks-log-'));
    try {
      for (const stamp of ['20200101-000000', '20200102-000000', '20200103-000000']) writeFileSync(join(dir, `checks-${stamp}.jsonl`), '{}\n');
      writeFileSync(join(dir, 'errors-20200101-000000.jsonl'), '{}\n');
      const big = join(dir, 'checks.jsonl');
      writeFileSync(big, '');
      truncateSync(big, lib.LOG_MAX_BYTES + 1);
      lib.appendShellLog('checks.jsonl', { a: 1 }, { logDir: dir, env: {} });
      const names = readdirSync(dir).sort();
      expect(names.filter((n) => n.startsWith('checks-'))).toHaveLength(2);
      expect(names).not.toContain('checks-20200101-000000.jsonl');
      expect(names).not.toContain('checks-20200102-000000.jsonl');
      expect(names).toContain('checks-20200103-000000.jsonl');
      expect(names).toContain('errors-20200101-000000.jsonl');
      expect(readFileSync(big, 'utf8')).toBe('{"a":1}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes to OMC_SHELL_CHECKS_LOG_DIR first, then the directory the hook passes', () => {
    expect(lib.shellLogDir({ OMC_SHELL_CHECKS_LOG_DIR: '/a' }, '/b')).toBe('/a');
    expect(lib.shellLogDir({}, '/b')).toBe('/b');
    expect(lib.shellLogDir({})).toContain(join('.omc', 'state', 'shell-checks'));
  });
});

describe.skipIf(!bashPath)('shell checks: bash -n handling', () => {
  it('does not deny when bash itself fails (not exit 2): allow with syntax.reason bash-failure, a here-document is still found', () => {
    const unclosed = cases.find((c) => c.id === 'S02')!.command;
    const crashed = lib.checkBashCommand(unclosed, { platform: 'linux', bashPath: process.execPath, timeoutMs: 15000 });
    expect(crashed.decision).toBe('allow');
    expect(crashed.syntax).toMatchObject({ ran: true, reason: 'bash-failure' });
    expect(crashed.syntax.code).not.toBe(0);
    expect(crashed.syntax.code).not.toBe(2);
    const heredoc = lib.checkBashCommand("cat <<'EOF'\nno end", { platform: 'linux', bashPath: process.execPath, timeoutMs: 15000 });
    expect(heredoc.decision).toBe('deny');
    expect(heredoc.checks).toEqual(['heredoc']);
  });

  it('skips bash -n for short commands on Windows only', () => {
    expect(lib.SYNTAX_MIN_CHARS).toEqual({ win32: 200, default: 0 });
    const short = 'echo "unclosed';
    expect(lib.checkBashCommand(short, { platform: 'win32', bashPath, timeoutMs: 15000 }).decision).toBe('allow');
    expect(lib.checkBashCommand(short, { platform: 'linux', bashPath, timeoutMs: 15000 }).decision).toBe('deny');
  });
});
