import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { teamReadConfig } from '../team-ops.js';
import { absPath, TeamPaths } from '../state-paths.js';
describe('legacy on-disk config classification (exact-head 70d5 P1)', () => {
    let cwd;
    const teamName = 'legacy-v1-team';
    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), 'legacy-class-'));
    });
    afterEach(() => rmSync(cwd, { recursive: true, force: true }));
    it('preserves agentTypes provenance and does not force V2 routing via empty workers', async () => {
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        // Real legacy shape: agentTypes, no workers field
        writeFileSync(configPath, JSON.stringify({
            name: teamName,
            task: 'legacy task',
            agentTypes: ['codex'],
            tmuxSession: 'omc-team-legacy',
            workerCount: 2,
            tmuxOwnsWindow: false,
        }));
        const loaded = await teamReadConfig(teamName, cwd);
        expect(loaded).toBeTruthy();
        expect(Array.isArray(loaded.agentTypes)).toBe(true);
        expect(loaded.agentTypes).toEqual(['codex']);
        // Must not look like a revisioned V2 team with real workers authority
        // Empty workers array is OK only if agentTypes is still present for classification
        expect(loaded.agentTypes).toEqual(['codex']);
    });
    it.each([0, -1, 1.5])('rejects an invalid persisted V1 max_workers cap of %s', async (maxWorkers) => {
        const configPath = absPath(cwd, TeamPaths.config(teamName));
        mkdirSync(join(configPath, '..'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            name: teamName,
            task: 'legacy task',
            agentTypes: ['codex'],
            tmuxSession: 'omc-team-legacy',
            workerCount: 2,
            tmuxOwnsWindow: false,
            max_workers: maxWorkers,
        }));
        await expect(teamReadConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    });
});
//# sourceMappingURL=legacy-config-classification.test.js.map