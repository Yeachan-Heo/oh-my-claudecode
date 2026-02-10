import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { canStartMode, createModeMarker, removeModeMarker, isModeActive, readModeMarker } from '../../mode-registry/index.js';
describe('Mode Registry Integration', () => {
    let testDir;
    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'mode-registry-test-'));
    });
    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });
    describe('canStartMode', () => {
        it('should allow mode when no conflicts exist', () => {
            const result = canStartMode('swarm', testDir);
            expect(result.allowed).toBe(true);
            expect(result.blockedBy).toBeUndefined();
            expect(result.message).toBeUndefined();
        });
        it('should block when exclusive mode is active', () => {
            // Create autopilot state to simulate active mode
            const stateDir = join(testDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            const autopilotStatePath = join(stateDir, 'autopilot-state.json');
            writeFileSync(autopilotStatePath, JSON.stringify({
                active: true,
                phase: 'execution',
                originalIdea: 'test',
                created_at: Date.now()
            }));
            const result = canStartMode('swarm', testDir);
            expect(result.allowed).toBe(false);
            expect(result.blockedBy).toBe('autopilot');
            expect(result.message).toContain('Cannot start Swarm');
            expect(result.message).toContain('Autopilot is active');
        });
        it('should block when ultrapilot is active', () => {
            // Create ultrapilot state
            const stateDir = join(testDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            const ultrapilotStatePath = join(stateDir, 'ultrapilot-state.json');
            writeFileSync(ultrapilotStatePath, JSON.stringify({
                active: true,
                created_at: Date.now()
            }));
            const result = canStartMode('swarm', testDir);
            expect(result.allowed).toBe(false);
            expect(result.blockedBy).toBe('ultrapilot');
        });
        it('should allow non-exclusive modes when swarm is active', () => {
            // Create swarm marker
            const stateDir = join(testDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            createModeMarker('swarm', testDir, { agentCount: 3 });
            // Ralph is not exclusive, so it should be allowed
            const result = canStartMode('ralph', testDir);
            expect(result.allowed).toBe(true);
        });
    });
    describe('createModeMarker', () => {
        it('should create marker file with metadata', () => {
            const markerPath = join(testDir, '.omc', 'state', 'swarm-active.marker');
            const success = createModeMarker('swarm', testDir, {
                agentCount: 5,
                taskCount: 10
            });
            expect(success).toBe(true);
            expect(existsSync(markerPath)).toBe(true);
            const marker = readModeMarker('swarm', testDir);
            expect(marker).not.toBeNull();
            expect(marker?.mode).toBe('swarm');
            expect(marker?.agentCount).toBe(5);
            expect(marker?.taskCount).toBe(10);
            expect(marker?.startedAt).toBeDefined();
        });
        it('should create directory if it does not exist', () => {
            const markerPath = join(testDir, '.omc', 'state', 'swarm-active.marker');
            // Ensure directory doesn't exist
            expect(existsSync(join(testDir, '.omc'))).toBe(false);
            const success = createModeMarker('swarm', testDir, {});
            expect(success).toBe(true);
            expect(existsSync(markerPath)).toBe(true);
        });
        it('should fail for modes without marker file', () => {
            // autopilot uses JSON state file, not marker
            const success = createModeMarker('autopilot', testDir, {});
            expect(success).toBe(false);
        });
    });
    describe('removeModeMarker', () => {
        it('should delete marker file', () => {
            const markerPath = join(testDir, '.omc', 'state', 'swarm-active.marker');
            createModeMarker('swarm', testDir, {});
            expect(existsSync(markerPath)).toBe(true);
            const success = removeModeMarker('swarm', testDir);
            expect(success).toBe(true);
            expect(existsSync(markerPath)).toBe(false);
        });
        it('should succeed if marker does not exist', () => {
            const success = removeModeMarker('swarm', testDir);
            expect(success).toBe(true);
        });
        it('should succeed for modes without marker file', () => {
            const success = removeModeMarker('autopilot', testDir);
            expect(success).toBe(true);
        });
    });
    describe('isModeActive', () => {
        it('should detect active marker-based mode', () => {
            createModeMarker('swarm', testDir, {});
            expect(isModeActive('swarm', testDir)).toBe(true);
        });
        it('should detect active JSON-based mode', () => {
            const stateDir = join(testDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(join(stateDir, 'autopilot-state.json'), JSON.stringify({
                active: true,
                phase: 'execution',
                originalIdea: 'test',
                created_at: Date.now()
            }));
            expect(isModeActive('autopilot', testDir)).toBe(true);
        });
        it('should return false when mode is not active', () => {
            expect(isModeActive('swarm', testDir)).toBe(false);
            expect(isModeActive('autopilot', testDir)).toBe(false);
        });
        it('should return false when JSON mode is inactive', () => {
            const stateDir = join(testDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(join(stateDir, 'autopilot-state.json'), JSON.stringify({
                active: false,
                phase: 'complete',
                originalIdea: 'test',
                created_at: Date.now(),
                completed_at: Date.now()
            }));
            expect(isModeActive('autopilot', testDir)).toBe(false);
        });
    });
    describe('Stale marker detection', () => {
        it('should auto-remove stale markers older than 1 hour', () => {
            // Create marker with old timestamp (simulating stale marker)
            const stateDir = join(testDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            const markerPath = join(stateDir, 'swarm-active.marker');
            // Create marker with timestamp from 2 hours ago (exceeds 1-hour threshold)
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
            writeFileSync(markerPath, JSON.stringify({
                mode: 'swarm',
                startedAt: twoHoursAgo,
                agentCount: 3
            }));
            // Verify marker file exists
            expect(existsSync(markerPath)).toBe(true);
            // isModeActive should detect stale marker and auto-remove it
            expect(isModeActive('swarm', testDir)).toBe(false);
            // Marker should be deleted after staleness check
            expect(existsSync(markerPath)).toBe(false);
        });
        it('should handle marker files without timestamp', () => {
            const stateDir = join(testDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            const markerPath = join(stateDir, 'swarm-active.marker');
            // Create marker without startedAt
            writeFileSync(markerPath, JSON.stringify({
                mode: 'swarm',
                agentCount: 3
            }));
            expect(isModeActive('swarm', testDir)).toBe(true);
            const marker = readModeMarker('swarm', testDir);
            expect(marker?.startedAt).toBeUndefined();
        });
    });
});
//# sourceMappingURL=mode-registry.test.js.map