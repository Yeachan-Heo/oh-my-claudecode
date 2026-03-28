import { describe, it, expect } from 'vitest';
import {
  MODE_NAMES,
  DEPRECATED_MODE_NAMES,
  ALL_MODE_NAMES,
  MODE_STATE_FILE_MAP,
  SESSION_END_MODE_STATE_FILES,
  SESSION_METRICS_MODE_FILES,
} from '../mode-names.js';

describe('MODE_NAMES', () => {
  it('contains all expected mode identifiers', () => {
    expect(MODE_NAMES.AUTOPILOT).toBe('autopilot');
    expect(MODE_NAMES.TEAM).toBe('team');
    expect(MODE_NAMES.RALPH).toBe('ralph');
    expect(MODE_NAMES.ULTRAWORK).toBe('ultrawork');
    expect(MODE_NAMES.ULTRAQA).toBe('ultraqa');
  });

  it('has exactly 5 modes', () => {
    expect(Object.keys(MODE_NAMES)).toHaveLength(5);
  });
});

describe('DEPRECATED_MODE_NAMES', () => {
  it('contains deprecated mode identifiers', () => {
    expect(DEPRECATED_MODE_NAMES.ULTRAPILOT).toBe('ultrapilot');
    expect(DEPRECATED_MODE_NAMES.SWARM).toBe('swarm');
    expect(DEPRECATED_MODE_NAMES.PIPELINE).toBe('pipeline');
  });

  it('does not overlap with active MODE_NAMES', () => {
    const activeValues = new Set(Object.values(MODE_NAMES));
    for (const deprecated of Object.values(DEPRECATED_MODE_NAMES)) {
      expect(activeValues.has(deprecated as any)).toBe(false);
    }
  });
});

describe('ALL_MODE_NAMES', () => {
  it('contains all MODE_NAMES values', () => {
    for (const mode of Object.values(MODE_NAMES)) {
      expect(ALL_MODE_NAMES).toContain(mode);
    }
  });

  it('has the same length as MODE_NAMES keys', () => {
    expect(ALL_MODE_NAMES).toHaveLength(Object.keys(MODE_NAMES).length);
  });

  it('is readonly (frozen-like array)', () => {
    // TypeScript enforces readonly at compile time; at runtime verify it is an array
    expect(Array.isArray(ALL_MODE_NAMES)).toBe(true);
  });
});

describe('MODE_STATE_FILE_MAP', () => {
  it('has an entry for every mode in MODE_NAMES', () => {
    for (const mode of Object.values(MODE_NAMES)) {
      expect(MODE_STATE_FILE_MAP[mode]).toBeDefined();
    }
  });

  it('maps each mode to a -state.json filename', () => {
    for (const [mode, filename] of Object.entries(MODE_STATE_FILE_MAP)) {
      expect(filename).toMatch(/^.+-state\.json$/);
      expect(filename).toContain(mode);
    }
  });

  it('produces unique filenames', () => {
    const filenames = Object.values(MODE_STATE_FILE_MAP);
    expect(new Set(filenames).size).toBe(filenames.length);
  });
});

describe('SESSION_END_MODE_STATE_FILES', () => {
  it('contains entries for all standard modes', () => {
    const modes = SESSION_END_MODE_STATE_FILES.map((e) => e.mode);
    for (const mode of Object.values(MODE_NAMES)) {
      expect(modes).toContain(mode);
    }
  });

  it('includes skill-active entry', () => {
    const modes = SESSION_END_MODE_STATE_FILES.map((e) => e.mode);
    expect(modes).toContain('skill-active');
  });

  it('has valid file fields', () => {
    for (const entry of SESSION_END_MODE_STATE_FILES) {
      expect(entry.file).toBeTruthy();
      expect(entry.mode).toBeTruthy();
    }
  });
});

describe('SESSION_METRICS_MODE_FILES', () => {
  it('is a subset of SESSION_END_MODE_STATE_FILES modes', () => {
    const endModes = new Set(SESSION_END_MODE_STATE_FILES.map((e) => e.mode));
    for (const entry of SESSION_METRICS_MODE_FILES) {
      expect(endModes.has(entry.mode)).toBe(true);
    }
  });

  it('contains autopilot, ralph, and ultrawork', () => {
    const modes = SESSION_METRICS_MODE_FILES.map((e) => e.mode);
    expect(modes).toContain(MODE_NAMES.AUTOPILOT);
    expect(modes).toContain(MODE_NAMES.RALPH);
    expect(modes).toContain(MODE_NAMES.ULTRAWORK);
  });
});
