import { describe, it, expect } from 'vitest';
import {
  MODE_NAMES,
  ALL_MODE_NAMES,
  MODE_STATE_FILE_MAP,
  SESSION_END_MODE_STATE_FILES,
  SESSION_METRICS_MODE_FILES,
} from '../lib/mode-names.js';

describe('mode-names ralplan', () => {
  it('registers Graph with its canonical durable state file', () => {
    expect(MODE_NAMES.GRAPH).toBe('graph');
    expect(ALL_MODE_NAMES).toContain('graph');
    expect(MODE_STATE_FILE_MAP.graph).toBe('graph-state.json');
  });

  it('does not register Graph for generic SessionEnd cleanup', () => {
    expect(SESSION_END_MODE_STATE_FILES.some(entry => entry.mode === 'graph')).toBe(false);
  });

  it('MODE_NAMES should include AUTORESEARCH', () => {
    expect(MODE_NAMES.AUTORESEARCH).toBe('autoresearch');
  });

  it('ALL_MODE_NAMES should include autoresearch', () => {
    expect(ALL_MODE_NAMES).toContain('autoresearch');
  });

  it('MODE_STATE_FILE_MAP should have autoresearch entry', () => {
    expect(MODE_STATE_FILE_MAP['autoresearch']).toBe('autoresearch-state.json');
  });

  it('SESSION_END_MODE_STATE_FILES should include autoresearch', () => {
    const entry = SESSION_END_MODE_STATE_FILES.find(
      item => item.mode === 'autoresearch'
    );
    expect(entry).toBeDefined();
    expect(entry!.file).toBe('autoresearch-state.json');
  });

  it('SESSION_METRICS_MODE_FILES should include autoresearch', () => {
    const entry = SESSION_METRICS_MODE_FILES.find(
      item => item.mode === 'autoresearch'
    );
    expect(entry).toBeDefined();
    expect(entry!.file).toBe('autoresearch-state.json');
  });

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
    const ralplanEntry = SESSION_END_MODE_STATE_FILES.find(
      entry => entry.mode === 'ralplan'
    );
    expect(ralplanEntry).toBeDefined();
    expect(ralplanEntry!.file).toBe('ralplan-state.json');
  });

  it('SESSION_METRICS_MODE_FILES should include ralplan', () => {
    const ralplanEntry = SESSION_METRICS_MODE_FILES.find(
      entry => entry.mode === 'ralplan'
    );
    expect(ralplanEntry).toBeDefined();
    expect(ralplanEntry!.file).toBe('ralplan-state.json');
  });

  it('total mode count should be consistent', () => {
    const modeCount = Object.keys(MODE_NAMES).length;
    expect(ALL_MODE_NAMES.length).toBe(modeCount);
    expect(Object.keys(MODE_STATE_FILE_MAP).length).toBe(modeCount);
  });
});
