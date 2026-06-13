/**
 * Tests for Wiki Session Hooks
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { ensureWikiDir } from '../storage.js';
import { onSessionEnd, onSessionStart } from '../session-hooks.js';
import { getWikiDir, readPage } from '../storage.js';
describe('Wiki Session Hooks', () => {
    let tempDir;
    let configDir;
    let originalClaudeConfigDir;
    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-session-hooks-'));
        configDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-session-config-'));
        originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = configDir;
    });
    afterEach(async () => {
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
        await fsp.rm(tempDir, { recursive: true, force: true });
        await fsp.rm(configDir, { recursive: true, force: true });
    });
    it('respects autoCapture=false from the active CLAUDE_CONFIG_DIR', () => {
        fs.writeFileSync(path.join(configDir, '.omc-config.json'), JSON.stringify({ wiki: { autoCapture: false } }));
        const wikiDir = ensureWikiDir(tempDir);
        expect(onSessionEnd({ cwd: tempDir, session_id: 'session-12345678' })).toEqual({ continue: true });
        const wikiEntries = fs.readdirSync(wikiDir);
        expect(wikiEntries.filter(entry => entry.startsWith('session-log-'))).toHaveLength(0);
        expect(fs.existsSync(path.join(wikiDir, 'log.md'))).toBe(false);
    });
});
describe('feedProjectMemory (environment.md)', () => {
    let tempDir;
    let configDir;
    let originalClaudeConfigDir;
    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-pm-'));
        configDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-pm-config-'));
        originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = configDir;
    });
    afterEach(async () => {
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
        await fsp.rm(tempDir, { recursive: true, force: true });
        await fsp.rm(configDir, { recursive: true, force: true });
    });
    function writeProjectMemory(memory) {
        const omcRoot = path.dirname(getWikiDir(tempDir));
        fs.writeFileSync(path.join(omcRoot, 'project-memory.json'), JSON.stringify(memory));
    }
    it('creates environment.md from project-memory.json on session start', () => {
        ensureWikiDir(tempDir);
        writeProjectMemory({
            lastScanned: '2026-01-01T00:00:00.000Z',
            techStack: {
                languages: [{ name: 'Java' }, { name: 'Kotlin' }],
                frameworks: ['Spring'],
                packageManager: 'gradle',
            },
        });
        onSessionStart({ cwd: tempDir });
        const env = readPage(tempDir, 'environment.md');
        expect(env).not.toBeNull();
        expect(env.content).toContain('**Languages:** Java, Kotlin');
        expect(env.content).not.toContain('[object Object]');
    });
    it('renders plain-string languages too', () => {
        ensureWikiDir(tempDir);
        writeProjectMemory({
            lastScanned: '2026-01-01T00:00:00.000Z',
            techStack: { languages: ['TypeScript', 'Go'] },
        });
        onSessionStart({ cwd: tempDir });
        const env = readPage(tempDir, 'environment.md');
        expect(env.content).toContain('**Languages:** TypeScript, Go');
    });
    it('updates environment.md when project-memory is newer', () => {
        ensureWikiDir(tempDir);
        writeProjectMemory({
            lastScanned: '2026-01-01T00:00:00.000Z',
            techStack: { languages: [{ name: 'Java' }] },
        });
        onSessionStart({ cwd: tempDir });
        const first = readPage(tempDir, 'environment.md');
        expect(first.content).toContain('Java');
        writeProjectMemory({
            lastScanned: '2030-01-01T00:00:00.000Z',
            techStack: { languages: [{ name: 'Rust' }] },
        });
        onSessionStart({ cwd: tempDir });
        const second = readPage(tempDir, 'environment.md');
        expect(second.content).toContain('Rust');
        expect(second.frontmatter.created).toBe(first.frontmatter.created);
    });
});
//# sourceMappingURL=session-hooks.test.js.map