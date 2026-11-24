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
function runPreToolUseHookRaw(tool_name, tool_input, cwd = process.cwd(), env = {}) {
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
    return JSON.parse(result.stdout.trim());
}
function runPreToolUseHook(command, cwd = process.cwd()) {
    return runPreToolUseHookRaw('Bash', { command }, cwd);
}
function hasDelegationNotice(output) {
    const hookSpecificOutput = output.hookSpecificOutput;
    return Boolean(hookSpecificOutput &&
        typeof hookSpecificOutput === 'object' &&
        'additionalContext' in hookSpecificOutput);
}
describe('pre-tool-use template source extension detection', () => {
    it('does not warn for .json with stderr redirect', () => {
        const output = runPreToolUseHook('cat ~/.claude/settings.json 2>/dev/null | python3 -m json.tool');
        expect(output.continue).toBe(true);
        expect(output.suppressOutput).toBe(true);
        expect(hasDelegationNotice(output)).toBe(false);
    });
    it('still warns for real source files with redirection target', () => {
        const output = runPreToolUseHook('cat fragment.txt > src/app.js');
        const hookSpecificOutput = output.hookSpecificOutput;
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
            const hookSpecificOutput = output.hookSpecificOutput;
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
            ['C:\\Windows\\Temp\\fixture.ts', '/home/project', process.platform === 'win32'],
            ['C:\\Users\\alice\\AppData\\Local\\Temp\\fixture.ts', '/home/project', process.platform === 'win32'],
            ['\\\\server\\share\\fixture.ts', '/home/project', false],
        ])('matches for %s from %s', (filePath, cwd, expected) => {
            expect(isAllowedPath(filePath, cwd)).toBe(expected);
            expect(isTempOrScratchpadPath(filePath, cwd)).toBe(expected && !filePath.startsWith('scratchpad'));
            const output = runPreToolUseHookRaw('Write', { file_path: filePath }, cwd);
            expect(hasDelegationNotice(output)).toBe(!expected);
        });
        it('allows an explicitly configured UNC temp root but not an arbitrary UNC share', () => {
            const hostIsWindows = process.platform === 'win32';
            const env = { TMP: '\\\\server\\share\\Temp' };
            const allowed = '\\\\server\\share\\Temp\\fixture.ts';
            const rejected = '\\\\server\\share\\Other\\fixture.ts';
            const previousTmp = process.env.TMP;
            process.env.TMP = env.TMP;
            try {
                expect(isAllowedPath(allowed, '/home/project')).toBe(hostIsWindows);
                expect(isAllowedPath(rejected, '/home/project')).toBe(false);
            }
            finally {
                if (previousTmp === undefined)
                    delete process.env.TMP;
                else
                    process.env.TMP = previousTmp;
            }
            const output = runPreToolUseHookRaw('Write', { file_path: allowed }, '/home/project', env);
            expect(hasDelegationNotice(output)).toBe(!hostIsWindows);
            expect(hasDelegationNotice(runPreToolUseHookRaw('Write', { file_path: rejected }, '/home/project', env))).toBe(true);
        });
        it('keeps absolute project metadata and CLAUDE_CONFIG_DIR decisions in parity', () => {
            const project = mkdtempSync(join(tmpdir(), 'omc-parity-project-'));
            const config = mkdtempSync(join(tmpdir(), 'omc-parity-config-'));
            const previousConfig = process.env.CLAUDE_CONFIG_DIR;
            process.env.CLAUDE_CONFIG_DIR = config;
            try {
                for (const target of [join(project, '.omc', 'state.ts'), join(config, 'agents', 'worker.ts')]) {
                    expect(isAllowedPath(target, project)).toBe(true);
                    expect(hasDelegationNotice(runPreToolUseHookRaw('Write', { file_path: target }, project, { CLAUDE_CONFIG_DIR: config }))).toBe(false);
                }
            }
            finally {
                if (previousConfig === undefined)
                    delete process.env.CLAUDE_CONFIG_DIR;
                else
                    process.env.CLAUDE_CONFIG_DIR = previousConfig;
                rmSync(project, { recursive: true, force: true });
                rmSync(config, { recursive: true, force: true });
            }
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
            }
            finally {
                rmSync(project, { recursive: true, force: true });
            }
        });
        it('uses a nested tool-input cwd when the top-level hook cwd is absent', () => {
            const project = mkdtempSync(join(tmpdir(), 'omc-nested-cwd-'));
            try {
                const target = join(project, 'src', 'app.ts');
                const output = runPreToolUseHookRaw('Write', { file_path: target, cwd: project }, null);
                expect(hasDelegationNotice(output)).toBe(true);
            }
            finally {
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
                }
                catch {
                    return;
                }
                const target = join(alias, 'src', 'app.ts');
                expect(isTempOrScratchpadPath(target, project)).toBe(false);
                expect(isAllowedPath(target, project)).toBe(false);
                expect(hasDelegationNotice(runPreToolUseHookRaw('Write', { file_path: target }, project))).toBe(true);
            }
            finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
        it('rejects symlink-plus-parent traversal that escapes the lexical temp root', () => {
            const root = mkdtempSync(join(tmpdir(), 'omc-symlink-parent-'));
            const alias = join(root, 'alias');
            try {
                try {
                    symlinkSync('/opt', alias, 'dir');
                }
                catch {
                    return;
                }
                const target = `${alias}/../etc/app.ts`;
                expect(isTempOrScratchpadPath(target, '/home/project')).toBe(false);
                expect(isAllowedPath(target, '/home/project')).toBe(false);
                expect(hasDelegationNotice(runPreToolUseHookRaw('Write', { file_path: target }, '/home/project'))).toBe(true);
            }
            finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
        it('resolves GIT_DIR and GIT_WORK_TREE when cwd is a project subdirectory', () => {
            const root = mkdtempSync(join(tmpdir(), 'omc-git-env-'));
            const project = join(root, 'project');
            const subdir = join(project, 'nested');
            const gitDir = join(root, 'repo.git');
            mkdirSync(subdir, { recursive: true });
            try {
                execFileSync('git', ['init', '--bare', '--quiet', gitDir]);
                const target = join(project, 'src', 'app.ts');
                const env = { GIT_DIR: gitDir, GIT_WORK_TREE: project };
                const previousGitDir = process.env.GIT_DIR;
                const previousGitWorkTree = process.env.GIT_WORK_TREE;
                process.env.GIT_DIR = gitDir;
                process.env.GIT_WORK_TREE = project;
                try {
                    expect(isAllowedPath(target, subdir)).toBe(false);
                }
                finally {
                    if (previousGitDir === undefined)
                        delete process.env.GIT_DIR;
                    else
                        process.env.GIT_DIR = previousGitDir;
                    if (previousGitWorkTree === undefined)
                        delete process.env.GIT_WORK_TREE;
                    else
                        process.env.GIT_WORK_TREE = previousGitWorkTree;
                }
                expect(hasDelegationNotice(runPreToolUseHookRaw('Write', { file_path: target }, subdir, env))).toBe(true);
            }
            finally {
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
            }
            finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });
    describe('notice payload is bounded', () => {
        it('truncates a long command and reports its real length', () => {
            const filler = 'x'.repeat(500);
            const command = `sed -i "s/${filler}/y/" src/app.ts`;
            const output = runPreToolUseHook(command);
            const additionalContext = output.hookSpecificOutput?.additionalContext;
            expect(hasDelegationNotice(output)).toBe(true);
            expect(additionalContext).toContain('Bash command may modify source files');
            expect(additionalContext).toContain(`(${command.length} chars)`);
            expect(additionalContext).not.toContain(filler);
        });
        it('leaves a short command intact', () => {
            const command = 'sed -i s/a/b/ src/app.ts';
            const additionalContext = runPreToolUseHook(command).hookSpecificOutput?.additionalContext;
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
            const hookSpecificOutput = output.hookSpecificOutput;
            expect(output.continue).toBe(true);
            expect(hasDelegationNotice(output)).toBe(true);
            expect(hookSpecificOutput?.additionalContext).toContain('Bash command may modify source files');
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
            ['tee dash-prefixed log after end-of-options', 'printf x | tee -- -build.log', false],
            ['tee multiple non-source operands after end-of-options', 'printf x | tee -- build.log -notes.txt', false],
            ['compound source read after log write', 'echo x > notes.txt; grep app.ts src/app.ts', false],
            ['subshell log write', '(echo x > output.txt)', false],
            ['shell -c log write', "bash -c 'echo x > /tmp/inner.log'", false],
            ['eval log write', "eval 'echo x > results.txt'", false],
            ['timeout wrapper with literal script log write', 'timeout 30 bash verify.sh > results.txt', false],
            ['sudo wrapper with literal script log write', 'sudo -n bash verify.sh > results.txt', false],
            ['sudo preserve-env list wrapping a source read', 'sudo --preserve-env=PATH cat src/app.ts', false],
            ['env wrapper with literal script log write', 'env -i bash verify.sh > results.txt', false],
            ['copy source into a log file', 'cp src/input.ts results.txt', false],
            ['install source into a log file', 'install src/input.ts results.txt', false],
            ['copy source into an explicit temp target directory', 'cp -t /tmp src/app.ts', false],
            ['install source into an explicit temp target directory', 'install --target-directory=/tmp src/app.ts', false],
            ['copy suffix option value is not a source operand', 'cp --suffix x.ts README.md build/', false],
            ['mv suffix option value is not a source operand', 'mv --suffix fake.ts README.md build/', false],
            ['touch reference operand is read-only', 'touch -r src/app.ts build.log', false],
            ['truncate reference operand is read-only', 'truncate -r src/app.ts build.log', false],
            ['truncate long reference operand is read-only', 'truncate --reference src/app.ts build.log', false],
            ['truncate equals reference operand is read-only', 'truncate --reference=src/app.ts build.log', false],
            ['pipeline stdin program writing only a log', "printf '%s\\n' 'echo x > build.log' | bash", false],
            ['pipeline stdin program is data for -c', "printf '%s\\n' 'echo x > src/app.ts' | bash -c 'true'", false],
            ['pipeline stdin program is data for a script operand', "printf '%s\\n' 'echo x > src/app.ts' | bash verify.sh", false],
            ['literal producer piped to a non-shell is data', "printf '%s\\n' 'echo x > src/app.ts' | cat", false],
            ['touch long reference operand is read-only', 'touch --reference src/app.ts build.log', false],
            ['non-in-place perl read', "perl -e 'print' src/input.ts", false],
            ['Perl include path is not in-place editing', "perl -Ilib -ne 'print' src/app.ts", false],
            ['read-only sed with --quiet', "sed --quiet -e '/foo/p' src/app.ts", false],
            ['read-only sed with --silent', "sed --silent -e '/foo/p' src/app.ts", false],
            ['read-only sed with -n', "sed -n -e 's/foo/bar/p' src/app.ts", false],
            ['comment containing redirect syntax', 'printf x > build.log # > src/app.ts', false],
            ['heredoc body containing redirect syntax', "cat <<'EOF' > build.log\n> src/app.ts\nEOF", false],
            ['shell script heredoc is data, not a program', "bash verify.sh <<'EOF'\nrm src/app.ts\nEOF", false],
            ['shell command-string heredoc is data, not a program', "bash -c 'cat >/dev/null' <<'EOF'\nrm src/app.ts\nEOF", false],
            ['non-stdin fd heredoc is data, not a program', "bash 3<<'EOF'\nrm src/app.ts\nEOF", false],
            ['shell script operand ending in a digit keeps heredoc as data', "bash verify3<<'EOF'\nrm src/app.ts\nEOF", false],
            ['digit-prefixed quoted heredoc is data', "cat <<'123' > build.log\necho x > src/app.ts\n123", false],
            ['digit-prefixed unquoted heredoc is data', "cat <<123 > build.log\necho x > src/app.ts\n123", false],
            ['overridden first stdin heredoc is not the program', "bash <<'ONE' <<'TWO'\necho x > src/app.ts\nONE\ntrue\nTWO", false],
            ['concatenated quoted heredoc word stays data', "cat <<'1'23 > build.log\ndata\n123\necho done", false],
            ['backslash-newline continues unquoted heredoc delimiter', "cat <<EO\\\nF > build.log\necho x > src/app.ts\nEOF", false],
            ['later file redirect overrides fd0 heredoc', "bash <<'EOF' </dev/null\necho x > src/app.ts\nEOF", false],
            ['later here-string overrides fd0 heredoc', "bash <<'EOF' <<<'true'\necho x > src/app.ts\nEOF", false],
            ['printf %b \\c stops remaining format arguments', "printf '%b%s' 'true\\c' 'echo x > src/app.ts' | bash", false],
            ['spaced IO number is a command not a redirect', '2 > build.log rm src/app.ts', false],
            ['redirected cat is not a pipeline passthrough', "printf '%s\\n' 'echo x > src/app.ts' | cat > build.log | bash", false],
            ['quoted IO number is a command not a redirect', "'2'> build.log rm src/app.ts", false],
            ['ampersand redirect does not take an IO prefix', '2&> build.log rm src/app.ts', false],
            ['escaped IO number is a command not a redirect', '\\2>build.log rm src/app.ts', false],
            ['env printf format \\c uses GNU stop', "env printf 'true\\n\\cecho x > src/app.ts\\n' | bash", false],
            ['printf -v writes no pipeline stdout', "printf -v var '%s\\n' 'echo x > src/app.ts' | bash", false],
            ['gnu printf format \\c stops remaining output', "/usr/bin/printf 'true\\n\\cecho x > src/app.ts\\n' | bash", false],
            ['unknown printf format escape keeps the backslash', "printf 'echo x \\> src/app.ts\\n' | bash", false],
            ['echo -- is data not end-of-options', "echo -- 'rm src/app.ts' | bash", false],
            ['single-quoted backslash does not hide a later data heredoc', "printf '%s' '\\' > build.log; cat <<EOF > build.log\necho x > src/app.ts\nEOF", false],
            ['unrecognized echo option stays output data', 'echo -x rm src/app.ts | bash', false],
            ['unsupported ANSI-C escape keeps the backslash', "echo $'echo x \\> src/app.ts' | bash", false],
            ['double-quoted nonspecial backslash is not a source path', 'rm "src/app.\\ts"', false],
            ['NUL-truncated empty -c argument is not the next word', "bash -c $'\\c@junk' 'rm src/app.ts'", false],
            ['empty quoted redirect target is invalid not a source write', "echo x > '' rm src/app.ts", false],
            ['printf %b doubled backslash keeps escaped redirect', "printf '%b' 'echo x \\\\> src/app.ts\\n' | bash", false],
            ['gnu printf invalid \\U is not a reconstructed rm', "/usr/bin/printf '\\UFFFFFFFFrm src/app.ts\\n' | bash", false],
            ['builtin printf over-max \\U is not a reconstructed rm', "printf '\\U00110000rm src/app.ts\\n' | bash", false],
            ['command -v does not unwrap rm', 'command -v rm src/app.ts', false],
            ['command -V does not unwrap rm', 'command -V rm src/app.ts', false],
            ['invalid printf option produces no stdout program', "printf -x 'rm src/app.ts' | bash", false],
            ['echo -E does not expand escapes into a stdin program', "echo -E 'true\\nrm src/app.ts' | bash", false],
            ['invalid plus option after -c is not a program', "bash -c +z 'rm src/app.ts'", false],
            ['plus-D after -c dumps strings and does not run the command', "bash -c +D 'rm src/app.ts'", false],
            ['bash -n -c does not execute the command string', "bash -n -c 'rm src/app.ts'", false],
            ['bash -o noexec -c does not execute the command string', "bash -o noexec -c 'rm src/app.ts'", false],
            ['builtin rm is not a shell builtin', 'builtin rm src/app.ts', false],
            ['path-qualified printf is not a shell builtin', "builtin /usr/bin/printf '%s\\n' 'rm src/app.ts' | bash", false],
            ['invalid -O argument aborts before -c', "bash -O -n -c 'rm src/app.ts'", false],
            ['script operand then -c is not a command string', "bash /dev/null -c 'rm src/app.ts'", false],
            ['cat -n -- - is not a byte-preserving passthrough', "printf '%s\\n' 'rm src/app.ts' | cat -n -- - | bash", false],
            ['second -- after option delimiter is a cat filename', "printf '%s\\n' 'rm src/app.ts' | cat -- -- | bash", false],
            ['cat -u with stdin redirect is not pipeline passthrough', "printf '%s\\n' 'rm src/app.ts' | cat -u < /etc/hosts | bash", false],
            ['prefix file before stdin operand is not a transparent cat', "printf '%s\\n' 'rm src/app.ts' | cat /etc/hosts - | bash", false],
            ['suffix file after stdin operand is not a transparent cat', "printf '%s' 'rm src/app.ts' | cat - /etc/hosts | bash", false],
            ['later missing file after stdin operand is not modeled as passthrough', "printf '%s\\n' 'rm src/app.ts' | cat - -- -- | bash", false],
            ['here-string then stdin redirect is not the effective program', "cat <<< 'rm src/app.ts' < /dev/null | bash", false],
            ['direct-shell here-string then stdin redirect is not the program', "bash <<< 'rm src/app.ts' < /dev/null", false],
            ['named coprocess writing only a log', 'coproc worker bash verify.sh > results.log', false],
        ])('stays quiet: %s', (_label, command, expectedWarning) => {
            expect(hasDelegationNotice(runPreToolUseHook(command))).toBe(expectedWarning);
        });
        it.each([
            ['quoted source redirect target', "echo x > 'src/app.ts'", true],
            ['escaped source redirect target', 'echo x > src/app\\.ts', true],
            ['escaped-space source redirect target', 'echo x > src/foo\\ bar.ts', true],
            ['multiple redirects with a source target', 'echo x > notes.txt > src/app.ts', true],
            ['pipeline tee source target', 'printf x | tee src/app.ts', true],
            ['tee unquoted dash-prefixed source after end-of-options', 'printf x | tee -- -generated.ts', true],
            ['tee quoted dash-prefixed source after end-of-options', "printf x | tee -- '-generated.ts'", true],
            ['tee multiple operands including dash-prefixed source', 'printf x | tee -- build.log -generated.ts notes.txt', true],
            ['tee supported option before dash-prefixed source', 'printf x | tee -a -- -generated.ts', true],
            ['tee ambiguous dynamic option', 'printf x | tee "$TEE_OPTION" build.log', true],
            ['compound source write', 'echo x > notes.txt; echo y > src/app.ts', true],
            ['conditional reserved-word source write', 'if true; then sed -i s/a/b/ src/app.ts; fi', true],
            ['loop reserved-word source write', 'while true; do rm src/app.ts; done', true],
            ['coprocess reserved-word source write', 'coproc rm -f src/app.ts', true],
            ['named coprocess source write', 'coproc worker rm -f src/app.ts', true],
            ['subshell source write', '(echo x > src/app.ts)', true],
            ['shell -c source write', "bash -c 'echo x > src/app.ts'", true],
            ['shell heredoc program source write', "bash <<'EOF'\necho hacked > src/app.ts\nEOF", true],
            ['final stdin heredoc is the program', "bash <<'ONE' <<'TWO'\ntrue\nONE\necho hacked > src/app.ts\nTWO", true],
            ['digit-prefixed quoted shell heredoc is a program', "bash <<'123'\necho hacked > src/app.ts\n123", true],
            ['stdin heredoc is scoped to its command', "bash <<'ONE'; cat <<'TWO'\necho hacked > src/app.ts\nONE\ntrue\nTWO", true],
            ['printf format assembles pipeline stdin program', "printf 'echo x > %s\\n' src/app.ts | bash", true],
            ['printf width-qualified conversion assembles stdin program', "printf '%1s\\n' 'echo x > src/app.ts' | bash", true],
            ['printf format octal escape with conversion assembles stdin program', "printf '%s\\012' 'echo x > src/app.ts' | bash", true],
            ['printf format hex escape with conversion assembles stdin program', "printf '%s\\x0a' 'echo x > src/app.ts' | bash", true],
            ['printf precision selects redirect from argument', "printf 'echo x %.1s src/app.ts\\n' '>ignored' | bash", true],
            ['printf unicode format escape assembles redirect', "printf 'echo x \\u003e %s\\n' src/app.ts | bash", true],
            ['printf long unicode format escape assembles redirect', "printf 'echo x \\U0000003e %s\\n' src/app.ts | bash", true],
            ['heredoc producer piped into a stdin shell', "cat <<'EOF' | bash\necho x > src/app.ts\nEOF", true],
            ['nonzero heredoc duplicated onto stdin is a program', "bash 3<<'EOF' 0<&3\necho x > src/app.ts\nEOF", true],
            ['spaced dup source fd still transfers stdin', "bash 3<<'EOF' 0<& 3\necho x > src/app.ts\nEOF", true],
            ['printf %b expands argument escapes into a stdin program', "printf '%b' 'true\\necho x > src/app.ts\\n' | bash", true],
            ['printf %b expands octal argument escapes into a stdin program', "printf '%b' 'true\\012echo x > src/app.ts\\012' | bash", true],
            ['printf %b expands hex argument escapes into a stdin program', "printf '%b' 'true\\x0aecho x > src/app.ts\\x0a' | bash", true],
            ['printf reuses format for remaining stdin program args', "printf '%s\\n' true 'echo x > src/app.ts' | bash", true],
            ['duplicate-text stdin heredoc owners stay distinct', "bash <<'EOF';bash <<'EOF'\necho hacked > src/app.ts\nEOF\ntrue\nEOF", true],
            ['concatenated quoted heredoc word does not swallow following writes', "cat <<'1'23 > build.log\ndata\n123\necho hacked > src/app.ts\necho done", true],
            ['pipeline stdin shell program source write', "printf '%s\\n' 'echo x > src/app.ts' | bash", true],
            ['leading IO number is not the executable', '2>/dev/null sed -i s/a/b/ src/app.ts', true],
            ['arithmetic shift is not a heredoc', '(( x = 1 << 2 )); echo x > src/app.ts', true],
            ['escaped quote in double-quoted heredoc delimiter', "cat <<\"E\\\"OF\" > build.log\ndata\nE\"OF\necho x > src/app.ts", true],
            ['bash printf format \\\\c does not stop output', "printf 'true\\n\\cecho x > src/app.ts\\n' | bash", true],
            ['nonspecial backslash in double-quoted heredoc delimiter', "cat <<\"E\\qOF\" > build.log\ndata\nE\\qOF\necho x > src/app.ts", true],
            ['stderr-only cat redirect still forwards stdin', "printf '%s\\n' 'echo x > src/app.ts' | cat 2> build.log | bash", true],
            ['stderr close on cat still forwards stdin', "printf '%s\\n' 'echo x > src/app.ts' | cat 2>&- | bash", true],
            ['arg suffix is not a destination fd for stdin dup', "bash 4<<'EOF' -s arg3<&4\necho x > src/app.ts\nEOF", true],
            ['heredoc dup after a long preceding command', "printf '%s' 123456789012345678901234567890 > build.log; bash 3<<'EOF' 0<&3\necho x > src/app.ts\nEOF", true],
            ['literal program through an intermediary cat stage', "printf '%s\\n' 'echo x > src/app.ts' | cat | bash", true],
            ['echo pipeline stdin shell program source write', "echo 'echo x > src/app.ts' | bash", true],
            ['echo joins arguments with spaces for recursive scan', 'echo rm src/app.ts | bash', true],
            ['ANSI-C apostrophe in command substitution still scans rm', "echo \"$(printf '%s' $'x\\')' \\'; rm src/app.ts)\" > build.log", true],
            ['ANSI-C quoted text is not a heredoc marker', "printf '%s' $'x\\' <<EOF' \\' > build.log\nrm src/app.ts", true],
            ['explicit stdin pipeline shell program source write', "printf '%s\\n' 'echo x > src/app.ts' | bash -s", true],
            ['ANSI-C quoted heredoc delimiter is decoded', "cat <<$'EOF' > build.log\ndata\nEOF\nrm src/app.ts", true],
            ['ANSI-C encoded operand still deletes the source file', "rm $'src/app.\\x74s'", true],
            ['ANSI-C encoded redirect in echo program', "echo $'echo x \\x3e src/app.ts' | bash", true],
            ['short ANSI-C \\u escape decodes a redirect', "echo $'echo x \\u3e src/app.ts' | bash", true],
            ['out-of-range ANSI-C \\U does not abort later rm', "printf '%s' $'\\UFFFFFFFF' > build.log; rm src/app.ts", true],
            ['ANSI-C \\cJ inserts a newline into a pipeline program', "echo $'true\\cJrm src/app.ts' | bash", true],
            ['ANSI-C NUL from \\c@ truncates the operand', "rm $'src/app.ts\\c@junk'", true],
            ['NUL-truncated ANSI-C heredoc delimiter still terminates', "cat <<$'EOF\\c@junk' > build.log\ndata\nEOF\nrm src/app.ts", true],
            ['invalid printf \\U does not abort later rm', "printf '\\UFFFFFFFF'; rm src/app.ts", true],
            ['quoted heredoc body backslash is not a line continuation', "cat <<'EOF' > build.log\ndata\\\nEOF\nrm src/app.ts", true],
            ['bash -c then -x still executes the command string', "bash -c -x 'rm src/app.ts'", true],
            ['head -n 1 heredoc still forwards stdin to bash', "head -n 1 <<'EOF' | bash\nrm src/app.ts\ntrue\nEOF", true],
            ['here-string is a shell stdin program', "bash <<< 'rm src/app.ts'", true],
            ['echo -e expands newline into a stdin program', "echo -e 'true\\nrm src/app.ts' | bash", true],
            ['escaped backtick does not close command substitution', "echo \"`echo \\\\\\`; rm src/app.ts`\" > build.log", true],
            ['locale-quoted heredoc delimiter still terminates', 'cat <<$"EOF" > build.log\ndata\nEOF\nrm src/app.ts', true],
            ['ANSI-C quote inside backticks does not close substitution', "echo \"`printf '%s' $'x\\''; rm src/app.ts`\" > build.log", true],
            ['echo -e \\c stops further output', "echo -e 'rm src/app.ts\\c junk' | bash", true],
            ['echo -e short \\u decodes a redirect', "echo -e 'echo x \\u3e src/app.ts' | bash", true],
            ['echo -e Unicode NUL does not hide following rm', "echo -e '\\u0rm src/app.ts' | bash", true],
            ['bash -c plus-option still executes the command string', "bash -c +x 'rm src/app.ts'", true],
            ['unexpanded dollar-paren heredoc delimiter still terminates', "cat <<$(printf EOF) > build.log\ndata\n$(printf EOF)\nrm src/app.ts", true],
            ['nested parameter expansion in dollar-paren delimiter still terminates', "cat <<$(echo ${x-)}) > build.log\ndata\n$(echo ${x-)})\nrm src/app.ts", true],
            ['literal brace in parameter default does not swallow delimiter', "cat <<$(echo ${x:-{}) > build.log\ndata\n$(echo ${x:-{})\nrm src/app.ts", true],
            ['bash -c plus-i still executes the command string', "bash -c +i 'rm src/app.ts'", true],
            ['valid plus option still reads stdin program', "printf '%s\\n' 'rm src/app.ts' | bash +x", true],
            ['builtin printf pipeline producer is inspected', "builtin printf '%s\\n' 'rm src/app.ts' | bash", true],
            ['builtin echo pipeline producer is inspected', "builtin echo 'rm src/app.ts' | bash", true],
            ['trailing -n after -c command is $0 not noexec', "bash -c 'rm src/app.ts' -n", true],
            ['builtin command still invokes rm', 'builtin command rm src/app.ts', true],
            ['dash-prefixed rcfile is a filename operand', "bash --rcfile -foo -c 'rm src/app.ts'", true],
            ['later +n clears noexec', "bash -n +n -c 'rm src/app.ts'", true],
            ['cat -- - is a stdin passthrough', "printf '%s\\n' 'rm src/app.ts' | cat -- - | bash", true],
            ['cat -u -- - is a byte-preserving passthrough', "printf '%s\\n' 'rm src/app.ts' | cat -u -- - | bash", true],
            ['no-op 0<&0 keeps pipeline stdin on cat', "printf '%s\\n' 'rm src/app.ts' | cat -u 0<&0 | bash", true],
            ['head -c slices stdin before the shell program', "head -c 13 <<'EOF' | bash\nrm src/app.tsJUNK\nEOF", true],
            ['cat here-string feeds a pipeline program', "cat <<< 'rm src/app.ts' | bash", true],
            ['tail attached +count still transforms stdin', "tail -n+2 <<'EOF' | bash\n#\nrm src/app.ts\nEOF", true],
            ['byte-neutral /dev/null cat operand still forwards stdin', "printf '%s\\n' 'rm src/app.ts' | cat - /dev/null | bash", true],
            ['later here-string overrides earlier stdin redirect', "cat < /dev/null <<< 'rm src/app.ts' | bash", true],
            ['here-string survives fd-zero self-duplication', "cat <<< 'rm src/app.ts' 0<&0 | bash", true],
            ['here-string restored through fd duplication', "cat <<< 'rm src/app.ts' 3<&0 0<&3 | bash", true],
            ['direct-shell later here-string overrides stdin redirect', "bash < /dev/null <<< 'rm src/app.ts'", true],
            ['saved pipeline stdin restored after here-string', "printf '%s\\n' 'rm src/app.ts' | cat 3<&0 <<< 'echo safe' 0<&3 | bash", true],
            ['saved pipeline stdin restored by moving fd', "printf '%s\\n' 'rm src/app.ts' | cat 3<&0 <<< 'echo safe' 0<&3- | bash", true],
            ['self-move 0<&0- keeps a here-string', "cat <<< 'rm src/app.ts' 0<&0- | bash", true],
            ['dynamic duplication target is scanned conservatively', "fd=0; cat <<< 'rm src/app.ts' 0<&$fd | bash", true],
            ['executing long option --noediting still runs -c', "bash --noediting -c 'rm src/app.ts'", true],
            ['stdin -n +n clears noexec', "printf '%s\\n' 'rm src/app.ts' | bash -n +n", true],
            ['lone dash is bash stdin like --', "bash - <<'EOF'\nrm src/app.ts\nEOF", true],
            ['pipeline into lone dash bash', "printf '%s\\n' 'rm src/app.ts' | bash -", true],
            ['explicit stdin shell heredoc source write', "bash -s <<'EOF'\necho hacked > src/app.ts\nEOF", true],
            ['explicit fd zero shell heredoc source write', "bash 0<<'EOF'\necho hacked > src/app.ts\nEOF", true],
            ['shell rcfile option still reads heredoc program', "bash --rcfile /tmp/rc <<'EOF'\necho hacked > src/app.ts\nEOF", true],
            ['shell shopt option still reads heredoc program', "bash -O extglob <<'EOF'\necho hacked > src/app.ts\nEOF", true],
            ['shell option value still reads heredoc program', "bash -o posix <<'EOF'\necho hacked > src/app.ts\nEOF", true],
            ['shell stdin program with digit-suffixed argument still recurses', "bash -s arg3<<'EOF'\necho hacked > src/app.ts\nEOF", true],
            ['shell stdin program with escaped-space digit argument still recurses', "bash -s arg\\ 3<<'EOF'\necho hacked > src/app.ts\nEOF", true],
            ['shell -c option terminator source write', "bash -c -- 'echo x > src/app.ts'", true],
            ['shell -c dynamic code', 'bash -c "$CODE"', true],
            ['shell dynamic option before quoted code', "bash $FLAG 'echo x > src/app.ts'", true],
            ['dynamic shell executable', "$SHELL -c 'echo x > src/app.ts'", true],
            ['eval source write', "eval 'echo x > src/app.ts'", true],
            ['eval dynamic code', 'eval "$CODE"', true],
            ['timeout wrapper source mutation', 'timeout 30 sed -i s/a/b/ src/app.ts', true],
            ['sudo wrapper source mutation', 'sudo -n sed -i s/a/b/ src/app.ts', true],
            ['env wrapper source mutation', 'env -i sed -i s/a/b/ src/app.ts', true],
            ['environment output target', 'echo x > "$OUT"', true],
            ['command substitution output target', 'echo x > $(printf src/app.ts)', true],
            ['process substitution output target', 'echo x > >(tee src/app.ts)', true],
            ['process substitution nested source write', 'cat < <(echo x > src/app.ts)', true],
            ['rm source target', 'rm -f src/app.ts', true],
            ['rm dash-prefixed source after end-of-options', 'rm -- -generated.ts', true],
            ['mv source target', 'mv src/app.ts results.txt', true],
            ['cp source destination', 'cp src/input.txt src/app.ts', true],
            ['cp target-directory source operand', 'cp -t src generated.ts', true],
            ['cp joined target-directory source path', 'cp --target-directory=src/app.ts input.txt', true],
            ['cp dynamic joined target-directory', 'cp --target-directory="$DEST" input.txt', true],
            ['install long target-directory source operand', 'install --target-directory=src generated.ts', true],
            ['install joined target-directory source path', 'install --target-directory=src/app.ts input.txt', true],
            ['install dynamic joined target-directory', 'install --target-directory="$DEST" input.txt', true],
            ['install source destination', 'install src/input.txt src/app.ts', true],
            ['touch source target', 'touch src/app.ts', true],
            ['touch dash-prefixed source after end-of-options', 'touch -- -generated.ts', true],
            ['truncate source target', 'truncate -s 0 src/app.ts', true],
            ['in-place sed source target', 'sed -i s/a/b/ src/app.ts', true],
            ['in-place sed dash-prefixed source after end-of-options', 'sed -i s/a/b/ -- -generated.ts', true],
            ['in-place sed attached backup suffix', "sed -ibak 's/a/b/' src/app.ts", true],
            ['in-place sed dotted backup suffix', "sed -i.bak 's/a/b/' src/app.ts", true],
            ['in-place sed long backup suffix', "sed --in-place=bak 's/a/b/' src/app.ts", true],
            ['in-place sed dynamic option', 'FLAGS=-i; sed "$FLAGS" s/a/b/ src/app.ts', true],
            ['BSD in-place sed option', "sed -I.bak 's/a/b/' src/app.ts", true],
            ['in-place perl source target', "perl -pi -e 's/a/b/' src/app.ts", true],
            ['redirect glob-expanded source target', 'printf x > src/*.ts', true],
            ['redirect brace-expanded source target', 'printf x > src/{a,b}.ts', true],
            ['rm glob-expanded source target', 'rm src/*.ts', true],
            ['mv brace-expanded source target', 'mv generated.ts src/{a,b}.ts', true],
            ['sed glob-expanded source target', 'sed -i s/a/b/ src/*.ts', true],
            ['tee glob-expanded source target', 'printf x | tee src/*.ts', true],
            ['cp brace-expanded source destination', 'cp generated.txt src/{a,b}.ts', true],
            ['install glob-expanded source destination', 'install generated.txt src/*.ts', true],
            ['touch brace-expanded source target', 'touch src/{a,b}.ts', true],
            ['commented heredoc marker cannot hide following mutation', ': # <<EOF\nrm src/app.ts', true],
        ])('warns: %s', (_label, command, expectedWarning) => {
            expect(hasDelegationNotice(runPreToolUseHook(command))).toBe(expectedWarning);
        });
        it.each(['cp', 'install'])('warns when %s writes a source basename into an existing directory', command => {
            const project = mkdtempSync(join(tmpdir(), `omc-${command}-directory-`));
            mkdirSync(join(project, 'build'), { recursive: true });
            try {
                expect(hasDelegationNotice(runPreToolUseHook(`${command} src/input.ts build/`, project))).toBe(true);
            }
            finally {
                rmSync(project, { recursive: true, force: true });
            }
        });
    });
});
//# sourceMappingURL=pre-tool-use-template-source-ext.test.js.map