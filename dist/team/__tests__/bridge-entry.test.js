import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateConfigPath } from '../bridge-entry.js';
describe('bridge-entry security', () => {
    const source = readFileSync(join(__dirname, '..', 'bridge-entry.ts'), 'utf-8');
    it('does NOT use process.cwd()', () => {
        expect(source).not.toContain('process.cwd()');
    });
    it('has validateBridgeWorkingDirectory function', () => {
        expect(source).toContain('validateBridgeWorkingDirectory');
    });
    it('validates config path is under ~/.claude/ or .omc/', () => {
        expect(source).toContain('.claude/');
        expect(source).toContain('.omc/');
    });
    it('sanitizes team and worker names', () => {
        expect(source).toContain('sanitizeName(config.teamName)');
        expect(source).toContain('sanitizeName(config.workerName)');
    });
    it('uses realpathSync for symlink resolution', () => {
        expect(source).toContain('realpathSync');
    });
    it('checks path is under homedir', () => {
        expect(source).toContain("home + '/'");
    });
    it('verifies git worktree', () => {
        expect(source).toContain('getWorktreeRoot');
    });
    it('validates working directory exists and is a directory', () => {
        expect(source).toContain('statSync(workingDirectory)');
        expect(source).toContain('isDirectory()');
    });
    it('validates provider is codex or gemini', () => {
        expect(source).toContain("config.provider !== 'codex'");
        expect(source).toContain("config.provider !== 'gemini'");
    });
    it('has signal handlers for graceful cleanup', () => {
        expect(source).toContain('SIGINT');
        expect(source).toContain('SIGTERM');
        expect(source).toContain('deleteHeartbeat');
        expect(source).toContain('unregisterMcpWorker');
    });
    it('validates required config fields', () => {
        expect(source).toContain('teamName');
        expect(source).toContain('workerName');
        expect(source).toContain('provider');
        expect(source).toContain('workingDirectory');
        expect(source).toContain('Missing required config field');
    });
    it('applies default configuration values', () => {
        expect(source).toContain('pollIntervalMs');
        expect(source).toContain('taskTimeoutMs');
        expect(source).toContain('maxConsecutiveErrors');
        expect(source).toContain('outboxMaxLines');
        expect(source).toContain('maxRetries');
    });
});
describe('validateConfigPath', () => {
    const home = '/home/user';
    const claudeConfigDir = '/home/user/.claude';
    it('should reject paths outside home directory', () => {
        expect(validateConfigPath('/tmp/.omc/config.json', home, claudeConfigDir)).toBe(false);
    });
    it('should reject paths without trusted subpath', () => {
        expect(validateConfigPath('/home/user/project/config.json', home, claudeConfigDir)).toBe(false);
    });
    it('should accept paths under ~/.claude/', () => {
        expect(validateConfigPath('/home/user/.claude/teams/foo/config.json', home, claudeConfigDir)).toBe(true);
    });
    it('should accept paths under project/.omc/', () => {
        expect(validateConfigPath('/home/user/project/.omc/state/config.json', home, claudeConfigDir)).toBe(true);
    });
    it('should reject path that matches subpath but not home', () => {
        expect(validateConfigPath('/other/.claude/config.json', home, claudeConfigDir)).toBe(false);
    });
    it('should reject path traversal via ../ that escapes trusted subpath', () => {
        // ~/foo/.claude/../../evil.json resolves to ~/evil.json (no trusted subpath)
        expect(validateConfigPath('/home/user/foo/.claude/../../evil.json', home, claudeConfigDir)).toBe(false);
    });
});
//# sourceMappingURL=bridge-entry.test.js.map