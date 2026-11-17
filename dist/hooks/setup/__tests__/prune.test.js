import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pruneOldStateFiles } from '../index.js';
describe('pruneOldStateFiles', () => {
    let testDir;
    let stateDir;
    let previousHome;
    let previousUserProfile;
    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'prune-test-'));
        previousHome = process.env.HOME;
        previousUserProfile = process.env.USERPROFILE;
        process.env.HOME = testDir;
        process.env.USERPROFILE = testDir;
        stateDir = join(testDir, '.omc', 'state');
        mkdirSync(stateDir, { recursive: true });
    });
    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousUserProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = previousUserProfile;
    });
    function writeStateFile(name, content, ageDays = 0) {
        const filePath = join(stateDir, name);
        writeFileSync(filePath, JSON.stringify(content, null, 2));
        if (ageDays > 0) {
            const pastTime = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000 - 1000);
            utimesSync(filePath, pastTime, pastTime);
        }
        return filePath;
    }
    it('should prune old non-mode state files', () => {
        writeStateFile('some-other-state.json', { data: true }, 10);
        const deleted = pruneOldStateFiles(testDir, 7);
        expect(deleted).toBe(1);
        expect(existsSync(join(stateDir, 'some-other-state.json'))).toBe(false);
    });
    it('should NOT prune fresh state files', () => {
        writeStateFile('autopilot-state.json', { active: false, phase: 'expansion' }, 0);
        const deleted = pruneOldStateFiles(testDir, 7);
        expect(deleted).toBe(0);
        expect(existsSync(join(stateDir, 'autopilot-state.json'))).toBe(true);
    });
    it('should prune old inactive autopilot-state.json (issue #609)', () => {
        writeStateFile('autopilot-state.json', { active: false, phase: 'planning' }, 10);
        const deleted = pruneOldStateFiles(testDir, 7);
        expect(deleted).toBe(1);
        expect(existsSync(join(stateDir, 'autopilot-state.json'))).toBe(false);
    });
    it('should NOT prune old active autopilot-state.json', () => {
        writeStateFile('autopilot-state.json', { active: true, phase: 'execution' }, 10);
        const deleted = pruneOldStateFiles(testDir, 7);
        expect(deleted).toBe(0);
        expect(existsSync(join(stateDir, 'autopilot-state.json'))).toBe(true);
    });
    it('should prune old inactive ralph-state.json', () => {
        writeStateFile('ralph-state.json', { active: false }, 10);
        const deleted = pruneOldStateFiles(testDir, 7);
        expect(deleted).toBe(1);
        expect(existsSync(join(stateDir, 'ralph-state.json'))).toBe(false);
    });
    it('should NOT prune old active ralph-state.json', () => {
        writeStateFile('ralph-state.json', { active: true }, 10);
        const deleted = pruneOldStateFiles(testDir, 7);
        expect(deleted).toBe(0);
        expect(existsSync(join(stateDir, 'ralph-state.json'))).toBe(true);
    });
    it('should prune old inactive ultrawork-state.json', () => {
        writeStateFile('ultrawork-state.json', { active: false }, 10);
        const deleted = pruneOldStateFiles(testDir, 7);
        expect(deleted).toBe(1);
        expect(existsSync(join(stateDir, 'ultrawork-state.json'))).toBe(false);
    });
    it('should prune malformed mode state files that cannot be parsed', () => {
        const filePath = join(stateDir, 'autopilot-state.json');
        writeFileSync(filePath, 'not valid json');
        const pastTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
        utimesSync(filePath, pastTime, pastTime);
        const deleted = pruneOldStateFiles(testDir, 7);
        expect(deleted).toBe(1);
        expect(existsSync(filePath)).toBe(false);
    });
    it('should handle mixed active and inactive old mode state files', () => {
        writeStateFile('autopilot-state.json', { active: false, phase: 'planning' }, 10);
        writeStateFile('ralph-state.json', { active: true }, 10);
        writeStateFile('ultrawork-state.json', { active: false }, 10);
        const deleted = pruneOldStateFiles(testDir, 7);
        // autopilot (inactive) and ultrawork (inactive) should be pruned; ralph (active) should stay
        expect(deleted).toBe(2);
        expect(existsSync(join(stateDir, 'autopilot-state.json'))).toBe(false);
        expect(existsSync(join(stateDir, 'ralph-state.json'))).toBe(true);
        expect(existsSync(join(stateDir, 'ultrawork-state.json'))).toBe(false);
    });
    it('should return 0 when state directory does not exist', () => {
        rmSync(stateDir, { recursive: true, force: true });
        const deleted = pruneOldStateFiles(testDir, 7);
        expect(deleted).toBe(0);
    });
});
//# sourceMappingURL=prune.test.js.map