import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { recordTaskCompletionUsage } from '../mcp-team-bridge.js';
describe('mcp-team-bridge usage recording', () => {
    it('records usage on task completion', () => {
        const workingDirectory = mkdtempSync(join(tmpdir(), 'omc-team-usage-'));
        const promptFile = join(workingDirectory, 'prompt.md');
        const outputFile = join(workingDirectory, 'output.md');
        writeFileSync(promptFile, 'prompt content', 'utf-8');
        writeFileSync(outputFile, 'output content', 'utf-8');
        const config = {
            teamName: 'usage-team',
            workerName: 'worker-1',
            provider: 'codex',
            model: 'gpt-test',
            workingDirectory,
            pollIntervalMs: 1000,
            taskTimeoutMs: 5000,
            maxConsecutiveErrors: 3,
            outboxMaxLines: 100,
            maxRetries: 2,
            permissionEnforcement: 'off',
        };
        recordTaskCompletionUsage({
            config,
            taskId: '1',
            promptFile,
            outputFile,
            provider: 'codex',
            startedAt: Date.now() - 200,
            startedAtIso: new Date(Date.now() - 200).toISOString(),
        });
        const logPath = join(workingDirectory, '.omc', 'logs', 'team-usage-usage-team.jsonl');
        const content = readFileSync(logPath, 'utf-8').trim();
        const record = JSON.parse(content);
        expect(record.taskId).toBe('1');
        expect(record.workerName).toBe('worker-1');
        expect(record.promptChars).toBeGreaterThan(0);
        expect(record.responseChars).toBeGreaterThan(0);
        rmSync(workingDirectory, { recursive: true, force: true });
    });
    it('uses writeTaskFailure return value for retry attempt checks', () => {
        const source = readFileSync(join(__dirname, '..', 'mcp-team-bridge.ts'), 'utf-8');
        expect(source).toContain("const failure = writeTaskFailure(teamName, task.id, errorMsg, { cwd: workingDirectory });");
        expect(source).toContain('const attempt = failure.retryCount;');
        expect(source).toContain('if (attempt >= (config.maxRetries ?? 5))');
    });
});
//# sourceMappingURL=mcp-team-bridge.usage.test.js.map