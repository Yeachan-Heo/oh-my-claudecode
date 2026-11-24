/**
 * Wave B2: self-improve session isolation test.
 *
 * Asserts that two concurrent self-improve runs sharing the same topic slug
 * but different sessionIds resolve to distinct artifact directories and do not
 * share state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const RESOLVER = join(process.cwd(), 'skills', 'self-improve', 'scripts', 'resolve-paths.mjs');
const ISOLATED_ENV_KEYS = [
    'HOME',
    'USERPROFILE',
    'OMC_STATE_DIR',
    'CLAUDE_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    'CLAUDE_PLUGIN_ROOT',
    'OMC_SESSION_ID',
    'OMC_DISABLE_MULTIREPO',
    'NODE_ENV',
];
let fixtureEnv;
function restoreFixtureEnv() {
    for (const key of ISOLATED_ENV_KEYS) {
        const value = fixtureEnv[key];
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value;
    }
}
function readJson(command, args, env = {}) {
    return JSON.parse(execFileSync(command, args, {
        encoding: 'utf-8',
        env: {
            ...process.env,
            NODE_ENV: 'test',
            OMC_STATE_DIR: '',
            CLAUDE_PLUGIN_ROOT: '',
            ...env,
        },
    }));
}
describe('self-improve session isolation (Wave B2)', () => {
    let root;
    let environmentRoot;
    beforeEach(() => {
        fixtureEnv = Object.fromEntries(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
        root = mkdtempSync(join(tmpdir(), 'omc-si-session-isolation-'));
        environmentRoot = mkdtempSync(join(tmpdir(), 'omc-si-session-isolation-env-'));
        const home = join(environmentRoot, 'home');
        const claudeConfigDir = join(home, '.claude');
        mkdirSync(claudeConfigDir, { recursive: true });
        mkdirSync(join(home, '.config'), { recursive: true });
        execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        process.env.OMC_STATE_DIR = '';
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
        process.env.XDG_CONFIG_HOME = join(home, '.config');
        process.env.CLAUDE_PLUGIN_ROOT = '';
        process.env.OMC_SESSION_ID = '';
        process.env.OMC_DISABLE_MULTIREPO = '';
        process.env.NODE_ENV = 'test';
    });
    afterEach(() => {
        restoreFixtureEnv();
        rmSync(root, { recursive: true, force: true });
        rmSync(environmentRoot, { recursive: true, force: true });
    });
    it('two runs with same topic slug but different session IDs resolve to distinct dirs', () => {
        const slug = 'perf-track';
        const sidA = 'session-alpha';
        const sidB = 'session-beta';
        const pathsA = readJson('node', [RESOLVER, '--project-root', root, '--slug', slug, '--session-id', sidA]);
        const pathsB = readJson('node', [RESOLVER, '--project-root', root, '--slug', slug, '--session-id', sidB]);
        expect(pathsA.root).not.toBe(pathsB.root);
        expect(pathsA.root).toContain(sidA);
        expect(pathsB.root).toContain(sidB);
        expect(pathsA.scope_mode).toBe('session-scoped');
        expect(pathsB.scope_mode).toBe('session-scoped');
    });
    it('session-scoped root is nested under topics/<slug>/sessions/<sid>/', () => {
        const slug = 'code-quality';
        const sid = 'abc123';
        const paths = readJson('node', [RESOLVER, '--project-root', root, '--slug', slug, '--session-id', sid]);
        const expectedRoot = join(realpathSync(root), '.omc', 'self-improve', 'topics', slug, 'sessions', sid);
        expect(paths.root).toBe(expectedRoot);
    });
    it('without session-id, two runs with same slug share the same topic root', () => {
        const slug = 'shared-topic';
        const pathsA = readJson('node', [RESOLVER, '--project-root', root, '--slug', slug]);
        const pathsB = readJson('node', [RESOLVER, '--project-root', root, '--slug', slug]);
        expect(pathsA.root).toBe(pathsB.root);
        expect(pathsA.scope_mode).toBe('topic-scoped');
    });
    it('writes from session A do not affect session B state dirs', () => {
        const slug = 'isolation-test';
        const sidA = 'run-001';
        const sidB = 'run-002';
        const pathsA = readJson('node', [RESOLVER, '--project-root', root, '--slug', slug, '--session-id', sidA, '--ensure-dirs']);
        const pathsB = readJson('node', [RESOLVER, '--project-root', root, '--slug', slug, '--session-id', sidB, '--ensure-dirs']);
        // Write a file into session A's state dir
        writeFileSync(join(pathsA.state_dir, 'iteration_state.json'), JSON.stringify({ active: true, session: sidA }));
        // Session B's state dir should not contain that file
        expect(existsSync(join(pathsB.state_dir, 'iteration_state.json'))).toBe(false);
    });
    it('session_id is returned in the paths object', () => {
        const slug = 'with-session';
        const sid = 'my-session-id';
        const paths = readJson('node', [RESOLVER, '--project-root', root, '--slug', slug, '--session-id', sid]);
        expect(paths.session_id).toBe(sid);
    });
    it('session_id is null when not provided', () => {
        const slug = 'no-session';
        const paths = readJson('node', [RESOLVER, '--project-root', root, '--slug', slug]);
        expect(paths.session_id).toBeNull();
    });
    it('OMC_SESSION_ID env var is used as fallback when --session-id not passed', () => {
        const slug = 'env-session';
        const sid = 'env-session-123';
        // Call without --session-id but with env var
        const result = JSON.parse(execFileSync('node', [RESOLVER, '--project-root', root, '--slug', slug], {
            encoding: 'utf-8',
            env: { ...process.env, OMC_SESSION_ID: sid },
        }));
        expect(result.scope_mode).toBe('session-scoped');
        expect(result.root).toContain(sid);
        expect(result.session_id).toBe(sid);
    });
});
//# sourceMappingURL=session-isolation.test.js.map