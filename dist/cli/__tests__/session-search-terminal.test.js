import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionSearchCommand } from '../commands/session-search.js';
import { encodeProjectPath } from '../../utils/encode-project-path.js';
let root;
let project;
let previousColorLevel;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omc-search-terminal-'));
    project = process.cwd();
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
    vi.stubEnv('OMC_STATE_DIR', join(root, 'omc-state'));
    previousColorLevel = chalk.level;
    chalk.level = 1;
});
afterEach(() => {
    chalk.level = previousColorLevel;
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
});
function transcript(text) {
    const directory = join(root, 'claude', 'projects', encodeProjectPath(project));
    mkdirSync(directory, { recursive: true });
    const filename = process.platform === 'win32' ? 'session.jsonl' : 'session-\x1b[2J.jsonl';
    writeFileSync(join(directory, filename), JSON.stringify({
        sessionId: 'session\x1b[2J', agentId: 'agent\x07', cwd: `${project}/name\x1b]52;c;unsafe\x07`,
        timestamp: 'invalid-time\x1b[?25l', type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
    }) + '\n');
}
function withoutFormatterColors(value) {
    return value.replace(/\x1b\[[0-9;]*m/g, '');
}
describe('session search terminal display boundary', () => {
    it('escapes persisted transcript controls in human output while retaining report and JSON data', async () => {
        transcript('visible-needle \x1b[2J \x1b]52;c;unsafe\x07');
        const logger = { log: vi.fn() };
        const report = await sessionSearchCommand('visible-needle', { workingDirectory: project }, logger);
        expect(report.totalMatches).toBe(1);
        expect(report.results[0].excerpt).toContain('\x1b');
        expect(report.results[0].timestamp).toContain('\x1b');
        const rendered = String(logger.log.mock.calls[0][0]);
        expect(rendered).toContain('\x1b[34m');
        expect(withoutFormatterColors(rendered)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
        expect(rendered).toContain('visible-needle');
        expect(rendered).toContain('\\x1b');
        expect(rendered).toContain('\\x07');
        const jsonLogger = { log: vi.fn() };
        await sessionSearchCommand('visible-needle', { workingDirectory: project, json: true }, jsonLogger);
        expect(JSON.parse(String(jsonLogger.log.mock.calls[0][0])).results).toEqual(report.results);
    });
    it('serializes C1 and DEL bytes as JSON escapes while preserving parsed report values', async () => {
        transcript('json-needle\x9b2J \x9d52;c;unsafe\x9c \x7f');
        const logger = { log: vi.fn() };
        const report = await sessionSearchCommand('json-needle', { workingDirectory: project, json: true }, logger);
        expect(report.results[0].excerpt).toContain('\x9b');
        const serialized = String(logger.log.mock.calls[0][0]);
        expect(serialized).not.toMatch(/[\x7f-\x9f]/);
        expect(serialized).toContain('\\u009b');
        expect(serialized).toContain('\\u007f');
        expect(JSON.parse(serialized)).toEqual(report);
    });
    it('escapes a C1 query in the no-results display branch', async () => {
        const logger = { log: vi.fn() };
        const query = 'missing-needle\x9b';
        const report = await sessionSearchCommand(query, { workingDirectory: project }, logger);
        expect(report.totalMatches).toBe(0);
        expect(report.query).toBe(query);
        const rendered = String(logger.log.mock.calls[0][0]);
        expect(withoutFormatterColors(rendered)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
        expect(rendered).toContain('\\x9b');
    });
    it('escapes C1 query and excerpt bytes without changing their structured values', async () => {
        const query = 'c1-needle\x9b';
        transcript(`${query}2J`);
        const logger = { log: vi.fn() };
        const report = await sessionSearchCommand(query, { workingDirectory: project }, logger);
        expect(report.query).toBe(query);
        expect(report.results[0].excerpt).toContain('\x9b');
        const rendered = String(logger.log.mock.calls[0][0]);
        expect(withoutFormatterColors(rendered)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
        expect(rendered).toContain('\\x9b');
    });
});
//# sourceMappingURL=session-search-terminal.test.js.map