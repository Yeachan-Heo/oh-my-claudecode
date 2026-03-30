import { describe, it, expect } from 'vitest';
import { MODE_NAMES, ALL_MODE_NAMES, MODE_STATE_FILE_MAP, SESSION_END_MODE_STATE_FILES, SESSION_METRICS_MODE_FILES, } from '../lib/mode-names.js';
describe('mode-names ralplan', () => {
    it('MODE_NAMES should include RALPLAN', () => {
        // BUG FIX: MODE_NAMES was documented as 'single source of truth' but was
        // missing RALPLAN which exists in src/constants/names.ts.
        expect(MODE_NAMES.RALPLAN).toBe('ralplan');
    });
    it('ALL_MODE_NAMES should include ralplan', () => {
        expect(ALL_MODE_NAMES).toContain('ralplan');
    });
    it('MODE_STATE_FILE_MAP should have ralplan entry', () => {
        expect(MODE_STATE_FILE_MAP['ralplan']).toBe('ralplan-state.json');
    });
    it('SESSION_END_MODE_STATE_FILES should include ralplan', () => {
        const ralplanEntry = SESSION_END_MODE_STATE_FILES.find(entry => entry.mode === 'ralplan');
        expect(ralplanEntry).toBeDefined();
        expect(ralplanEntry.file).toBe('ralplan-state.json');
    });
    it('SESSION_METRICS_MODE_FILES should include ralplan', () => {
        const ralplanEntry = SESSION_METRICS_MODE_FILES.find(entry => entry.mode === 'ralplan');
        expect(ralplanEntry).toBeDefined();
        expect(ralplanEntry.file).toBe('ralplan-state.json');
    });
    it('total mode count should be consistent', () => {
        const modeCount = Object.keys(MODE_NAMES).length;
        expect(ALL_MODE_NAMES.length).toBe(modeCount);
        expect(Object.keys(MODE_STATE_FILE_MAP).length).toBe(modeCount);
    });
});
//# sourceMappingURL=mode-names-ralplan.test.js.map