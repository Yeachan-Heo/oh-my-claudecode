import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSandboxContract } from '../../autoresearch/contracts.js';
const { tmuxAvailableMock, buildTmuxShellCommandMock, wrapWithLoginShellMock } = vi.hoisted(() => ({
    tmuxAvailableMock: vi.fn(),
    buildTmuxShellCommandMock: vi.fn((cmd, args) => `${cmd} ${args.join(' ')}`),
    wrapWithLoginShellMock: vi.fn((cmd) => `wrapped:${cmd}`),
}));
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        execFileSync: vi.fn(),
    };
});
vi.mock('../tmux-utils.js', () => ({
    isTmuxAvailable: tmuxAvailableMock,
    buildTmuxShellCommand: buildTmuxShellCommandMock,
    wrapWithLoginShell: wrapWithLoginShellMock,
}));
import { checkTmuxAvailable, guidedAutoresearchSetup, initAutoresearchMission, parseInitArgs, runAutoresearchNoviceBridge, spawnAutoresearchTmux, } from '../autoresearch-guided.js';
async function initRepo() {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-autoresearch-guided-test-'));
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
    await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
    return cwd;
}
function withMockedTty(fn) {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    return fn().finally(() => {
        if (descriptor) {
            Object.defineProperty(process.stdin, 'isTTY', descriptor);
        }
        else {
            Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
        }
    });
}
function makeFakeIo(answers) {
    const queue = [...answers];
    return {
        async question() {
            return queue.shift() ?? '';
        },
        close() { },
    };
}
describe('initAutoresearchMission', () => {
    it('creates mission.md with correct content', async () => {
        const repo = await initRepo();
        try {
            const result = await initAutoresearchMission({
                topic: 'Improve test coverage for the auth module',
                evaluatorCommand: 'node scripts/eval.js',
                keepPolicy: 'score_improvement',
                slug: 'auth-coverage',
                repoRoot: repo,
            });
            expect(result.slug).toBe('auth-coverage');
            expect(result.missionDir).toBe(join(repo, 'missions', 'auth-coverage'));
            const missionContent = await readFile(join(result.missionDir, 'mission.md'), 'utf-8');
            expect(missionContent).toMatch(/# Mission/);
            expect(missionContent).toMatch(/Improve test coverage for the auth module/);
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
    it('creates sandbox.md with valid YAML frontmatter', async () => {
        const repo = await initRepo();
        try {
            const result = await initAutoresearchMission({
                topic: 'Optimize database queries',
                evaluatorCommand: 'node scripts/eval-perf.js',
                keepPolicy: 'pass_only',
                slug: 'db-perf',
                repoRoot: repo,
            });
            const sandboxContent = await readFile(join(result.missionDir, 'sandbox.md'), 'utf-8');
            expect(sandboxContent).toMatch(/^---\n/);
            expect(sandboxContent).toMatch(/evaluator:/);
            expect(sandboxContent).toMatch(/command: node scripts\/eval-perf\.js/);
            expect(sandboxContent).toMatch(/format: json/);
            expect(sandboxContent).toMatch(/keep_policy: pass_only/);
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
    it('omits keep_policy when not provided', async () => {
        const repo = await initRepo();
        try {
            const result = await initAutoresearchMission({
                topic: 'Investigate flaky tests',
                evaluatorCommand: 'npm run eval',
                slug: 'flaky-tests',
                repoRoot: repo,
            });
            const sandboxContent = await readFile(join(result.missionDir, 'sandbox.md'), 'utf-8');
            expect(sandboxContent).not.toMatch(/keep_policy:/);
            const parsed = parseSandboxContract(sandboxContent);
            expect(parsed.evaluator.keep_policy).toBeUndefined();
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
    it('generated sandbox.md passes parseSandboxContract validation', async () => {
        const repo = await initRepo();
        try {
            const result = await initAutoresearchMission({
                topic: 'Fix flaky tests',
                evaluatorCommand: 'bash run-tests.sh',
                keepPolicy: 'score_improvement',
                slug: 'flaky-tests',
                repoRoot: repo,
            });
            const sandboxContent = await readFile(join(result.missionDir, 'sandbox.md'), 'utf-8');
            const parsed = parseSandboxContract(sandboxContent);
            expect(parsed.evaluator.command).toBe('bash run-tests.sh');
            expect(parsed.evaluator.format).toBe('json');
            expect(parsed.evaluator.keep_policy).toBe('score_improvement');
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
    it('allows valid mission creation even when cwd is inside missions root', async () => {
        const repo = await initRepo();
        const originalCwd = process.cwd();
        try {
            const missionsRoot = join(repo, 'missions');
            await mkdir(missionsRoot, { recursive: true });
            process.chdir(missionsRoot);
            const result = await initAutoresearchMission({
                topic: 'Check cwd-sensitive slug guard',
                evaluatorCommand: 'npm run build',
                slug: 'cwd-guard',
                repoRoot: repo,
            });
            expect(result.missionDir).toBe(join(repo, 'missions', 'cwd-guard'));
            expect(await readFile(join(result.missionDir, 'mission.md'), 'utf-8')).toMatch(/Check cwd-sensitive slug guard/);
        }
        finally {
            process.chdir(originalCwd);
            await rm(repo, { recursive: true, force: true });
        }
    });
    it('throws if mission directory already exists', async () => {
        const repo = await initRepo();
        try {
            const missionDir = join(repo, 'missions', 'existing');
            await mkdir(missionDir, { recursive: true });
            await expect(initAutoresearchMission({
                topic: 'duplicate',
                evaluatorCommand: 'echo ok',
                keepPolicy: 'pass_only',
                slug: 'existing',
                repoRoot: repo,
            })).rejects.toThrow(/already exists/);
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
});
describe('parseInitArgs', () => {
    it('parses all flags with space-separated values', () => {
        const result = parseInitArgs([
            '--topic', 'my topic',
            '--evaluator', 'node eval.js',
            '--keep-policy', 'pass_only',
            '--slug', 'my-slug',
        ]);
        expect(result.topic).toBe('my topic');
        expect(result.evaluatorCommand).toBe('node eval.js');
        expect(result.keepPolicy).toBe('pass_only');
        expect(result.slug).toBe('my-slug');
    });
    it('parses all flags with = syntax', () => {
        const result = parseInitArgs([
            '--topic=my topic',
            '--evaluator=node eval.js',
            '--keep-policy=score_improvement',
            '--slug=my-slug',
        ]);
        expect(result.topic).toBe('my topic');
        expect(result.evaluatorCommand).toBe('node eval.js');
        expect(result.keepPolicy).toBe('score_improvement');
        expect(result.slug).toBe('my-slug');
    });
    it('returns partial result when some flags are missing', () => {
        const result = parseInitArgs(['--topic', 'my topic']);
        expect(result.topic).toBe('my topic');
        expect(result.evaluatorCommand).toBeUndefined();
        expect(result.keepPolicy).toBeUndefined();
        expect(result.slug).toBeUndefined();
    });
    it('throws on invalid keep-policy', () => {
        expect(() => parseInitArgs(['--keep-policy', 'invalid'])).toThrow(/must be one of/);
    });
    it('throws on unknown flags', () => {
        expect(() => parseInitArgs(['--unknown-flag', 'value'])).toThrow(/Unknown init flag: --unknown-flag/);
    });
    it('sanitizes slug via slugifyMissionName', () => {
        const result = parseInitArgs(['--slug', '../../etc/cron.d/omc']);
        expect(result.slug).toBeTruthy();
        expect(result.slug).not.toMatch(/\.\./);
        expect(result.slug).not.toMatch(/\//);
    });
});
describe('runAutoresearchNoviceBridge', () => {
    it('loops through refine further before launching and writes draft + mission files', async () => {
        const repo = await initRepo();
        try {
            const result = await withMockedTty(() => runAutoresearchNoviceBridge(repo, {}, makeFakeIo([
                'Improve evaluator UX',
                'Make success measurable',
                'TODO replace with evaluator command',
                'score_improvement',
                'ux-eval',
                'refine further',
                'Improve evaluator UX',
                'Passing evaluator output',
                'node scripts/eval.js',
                'pass_only',
                'ux-eval',
                'launch',
            ])));
            const draftContent = await readFile(join(repo, '.omc', 'specs', 'deep-interview-autoresearch-ux-eval.md'), 'utf-8');
            const resultContent = await readFile(join(repo, '.omc', 'specs', 'autoresearch-ux-eval', 'result.json'), 'utf-8');
            const missionContent = await readFile(join(result.missionDir, 'mission.md'), 'utf-8');
            const sandboxContent = await readFile(join(result.missionDir, 'sandbox.md'), 'utf-8');
            expect(result.slug).toBe('ux-eval');
            expect(draftContent).toMatch(/Launch-ready: yes/);
            expect(resultContent).toMatch(/"launchReady": true/);
            expect(missionContent).toMatch(/Improve evaluator UX/);
            expect(sandboxContent).toMatch(/command: node scripts\/eval\.js/);
            expect(sandboxContent).toMatch(/keep_policy: pass_only/);
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
    it('uses seeded inputs while still requiring confirmation-driven launch', async () => {
        const repo = await initRepo();
        try {
            const result = await withMockedTty(() => runAutoresearchNoviceBridge(repo, {
                topic: 'Seeded topic',
                evaluatorCommand: 'node scripts/eval.js',
                keepPolicy: 'score_improvement',
                slug: 'seeded-topic',
            }, makeFakeIo([
                '',
                '',
                '',
                '',
                '',
                'launch',
            ])));
            const draftContent = await readFile(join(repo, '.omc', 'specs', 'deep-interview-autoresearch-seeded-topic.md'), 'utf-8');
            expect(result.slug).toBe('seeded-topic');
            expect(draftContent).toMatch(/- topic: Seeded topic/);
            expect(draftContent).toMatch(/- evaluator: node scripts\/eval\.js/);
            expect(draftContent).toMatch(/Launch-ready: yes/);
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
});
describe('guidedAutoresearchSetup', () => {
    it('delegates to the novice bridge behavior', async () => {
        const repo = await initRepo();
        try {
            const result = await withMockedTty(() => guidedAutoresearchSetup(repo, { topic: 'Seeded topic', evaluatorCommand: 'node scripts/eval.js', keepPolicy: 'score_improvement', slug: 'seeded-topic' }, makeFakeIo(['', '', '', '', '', 'launch'])));
            expect(result.slug).toBe('seeded-topic');
        }
        finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
});
describe('checkTmuxAvailable', () => {
    beforeEach(() => {
        tmuxAvailableMock.mockReset();
    });
    it('delegates to tmux-utils', () => {
        tmuxAvailableMock.mockReturnValue(true);
        expect(checkTmuxAvailable()).toBe(true);
        expect(tmuxAvailableMock).toHaveBeenCalled();
    });
});
describe('spawnAutoresearchTmux', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    beforeEach(() => {
        vi.mocked(execFileSync).mockReset();
        tmuxAvailableMock.mockReset();
        buildTmuxShellCommandMock.mockClear();
        wrapWithLoginShellMock.mockClear();
        logSpy.mockClear();
    });
    afterAll(() => {
        logSpy.mockRestore();
    });
    it('throws when tmux is unavailable', () => {
        tmuxAvailableMock.mockReturnValue(false);
        expect(() => spawnAutoresearchTmux('/repo/missions/demo', 'demo')).toThrow(/detached background autoresearch execution/);
    });
    it('throws when the session already exists', () => {
        tmuxAvailableMock.mockReturnValue(true);
        vi.mocked(execFileSync).mockImplementation((cmd, args) => {
            if (cmd === 'tmux' && Array.isArray(args) && args[0] === 'has-session') {
                return Buffer.from('');
            }
            throw new Error('unexpected');
        });
        expect(() => spawnAutoresearchTmux('/repo/missions/demo', 'demo')).toThrow(/already exists/);
    });
    it('uses explicit cwd, login-shell wrapping, and verifies startup before logging success', () => {
        tmuxAvailableMock.mockReturnValue(true);
        let hasSessionCalls = 0;
        vi.mocked(execFileSync).mockImplementation((cmd, args, opts) => {
            if (cmd === 'tmux' && Array.isArray(args) && args[0] === 'has-session') {
                hasSessionCalls += 1;
                if (hasSessionCalls === 1) {
                    throw new Error('missing session');
                }
                return Buffer.from('');
            }
            if (cmd === 'git') {
                expect(args).toEqual(['rev-parse', '--show-toplevel']);
                expect(opts.cwd).toBe('/repo/missions/demo');
                return '/repo\n';
            }
            if (cmd === 'tmux' && Array.isArray(args) && args[0] === 'new-session') {
                expect(args.slice(0, 6)).toEqual(['new-session', '-d', '-s', 'omc-autoresearch-demo', '-c', '/repo']);
                expect(args[6]).toBe('wrapped:' + `${process.execPath} ${process.cwd()}/bin/omc.js autoresearch /repo/missions/demo`);
                return Buffer.from('');
            }
            throw new Error(`unexpected call: ${String(cmd)}`);
        });
        spawnAutoresearchTmux('/repo/missions/demo', 'demo');
        expect(buildTmuxShellCommandMock).toHaveBeenCalledWith(process.execPath, [expect.stringMatching(/bin\/omc\.js$/), 'autoresearch', '/repo/missions/demo']);
        expect(wrapWithLoginShellMock).toHaveBeenCalledWith(`${process.execPath} ${process.cwd()}/bin/omc.js autoresearch /repo/missions/demo`);
        expect(logSpy).toHaveBeenCalledWith('\nAutoresearch launched in background.');
        expect(logSpy).toHaveBeenCalledWith('  Attach:   tmux attach -t omc-autoresearch-demo');
    });
    it('throws if startup verification fails after creating the session', () => {
        tmuxAvailableMock.mockReturnValue(true);
        vi.mocked(execFileSync).mockImplementation((cmd, args) => {
            if (cmd === 'tmux' && Array.isArray(args) && args[0] === 'has-session') {
                throw new Error('missing session');
            }
            if (cmd === 'git') {
                return '/repo\n';
            }
            if (cmd === 'tmux' && Array.isArray(args) && args[0] === 'new-session') {
                return Buffer.from('');
            }
            throw new Error(`unexpected call: ${String(cmd)}`);
        });
        expect(() => spawnAutoresearchTmux('/repo/missions/demo', 'demo')).toThrow(/did not stay available after launch/);
        expect(logSpy).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=autoresearch-guided.test.js.map