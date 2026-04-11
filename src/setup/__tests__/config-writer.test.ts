/**
 * Tests for src/setup/config-writer.ts — atomic JSON writers.
 *
 * Covers the three invariants that the bash → TS port depends on:
 *   1. Shallow merges preserve unknown top-level keys (user customizations).
 *   2. Nested sets create intermediates and preserve siblings at every level.
 *   3. Atomic writes are interrupt-safe — if the temp file is created but the
 *      rename fails, the original target file must be unchanged.
 *
 * All file IO happens under `mkdtempSync(os.tmpdir())` so the tests are
 * hermetic and safe to run in parallel.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  atomicWriteFile,
  mergeJsonShallow,
  mergeOmcConfig,
  mergeSettingsJson,
  readJsonSafe,
  setNestedJson,
  writeJsonAtomic,
} from '../config-writer.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'omc-config-writer-test-'));
});

afterEach(() => {
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ---------------------------------------------------------------------------
// readJsonSafe
// ---------------------------------------------------------------------------

describe('readJsonSafe', () => {
  it('returns null when the file does not exist', () => {
    const result = readJsonSafe<Record<string, unknown>>(
      join(workdir, 'missing.json'),
    );
    expect(result).toBeNull();
  });

  it('returns null for empty files', () => {
    const path = join(workdir, 'empty.json');
    writeFileSync(path, '');
    expect(readJsonSafe(path)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const path = join(workdir, 'broken.json');
    writeFileSync(path, '{ not: json }');
    expect(readJsonSafe(path)).toBeNull();
  });

  it('parses valid JSON', () => {
    const path = join(workdir, 'good.json');
    writeFileSync(path, '{"alpha": 1, "beta": [true, false]}');
    const result = readJsonSafe<{ alpha: number; beta: boolean[] }>(path);
    expect(result).toEqual({ alpha: 1, beta: [true, false] });
  });
});

// ---------------------------------------------------------------------------
// atomicWriteFile / writeJsonAtomic
// ---------------------------------------------------------------------------

describe('atomicWriteFile', () => {
  it('creates a file with the given content', () => {
    const path = join(workdir, 'out.txt');
    atomicWriteFile(path, 'hello world');
    expect(readFileSync(path, 'utf-8')).toBe('hello world');
  });

  it('creates missing parent directories', () => {
    const path = join(workdir, 'nested', 'deep', 'file.txt');
    atomicWriteFile(path, 'x');
    expect(readFileSync(path, 'utf-8')).toBe('x');
  });

  it('leaves no temp files behind on success', () => {
    const path = join(workdir, 'a.json');
    atomicWriteFile(path, '{"ok": true}');
    const entries = readdirSync(workdir);
    expect(entries).toEqual(['a.json']);
  });

  it('overwrites an existing file atomically (no partial write visible)', () => {
    const path = join(workdir, 'settings.json');
    writeFileSync(path, '{"original": "content"}');
    atomicWriteFile(path, '{"replaced": "content"}');
    expect(readFileSync(path, 'utf-8')).toBe('{"replaced": "content"}');
  });
});

describe('writeJsonAtomic', () => {
  it('serializes with 2-space indent and trailing newline', () => {
    const path = join(workdir, 'out.json');
    writeJsonAtomic(path, { a: 1, b: { c: 2 } });
    expect(readFileSync(path, 'utf-8')).toBe(
      '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}\n',
    );
  });
});

// ---------------------------------------------------------------------------
// mergeJsonShallow
// ---------------------------------------------------------------------------

describe('mergeJsonShallow', () => {
  it('starts from {} when the file is missing', () => {
    const path = join(workdir, 'new.json');
    mergeJsonShallow(path, { introduced: true });
    expect(readJsonSafe(path)).toEqual({ introduced: true });
  });

  it('starts from {} when the file is corrupted', () => {
    const path = join(workdir, 'broken.json');
    writeFileSync(path, 'not actually json');
    mergeJsonShallow(path, { added: 1 });
    expect(readJsonSafe(path)).toEqual({ added: 1 });
  });

  it('preserves unknown user-added top-level keys (the jq . + {...} contract)', () => {
    const path = join(workdir, 'settings.json');
    writeFileSync(
      path,
      JSON.stringify({
        userFavoriteColor: 'blue',
        importantUserKey: { nested: true },
        theme: 'dark',
      }),
    );
    mergeJsonShallow(path, { theme: 'light', newFeature: 42 });
    expect(readJsonSafe(path)).toEqual({
      userFavoriteColor: 'blue',
      importantUserKey: { nested: true },
      theme: 'light',
      newFeature: 42,
    });
  });

  it('patch keys overwrite existing keys of the same name', () => {
    const path = join(workdir, 'x.json');
    writeFileSync(path, JSON.stringify({ a: 1, b: 2 }));
    mergeJsonShallow(path, { a: 99 });
    expect(readJsonSafe(path)).toEqual({ a: 99, b: 2 });
  });

  it('resets to {} when the existing content is a non-object (e.g. array)', () => {
    const path = join(workdir, 'arr.json');
    writeFileSync(path, '[1, 2, 3]');
    mergeJsonShallow(path, { kind: 'object' });
    expect(readJsonSafe(path)).toEqual({ kind: 'object' });
  });
});

// ---------------------------------------------------------------------------
// setNestedJson
// ---------------------------------------------------------------------------

describe('setNestedJson', () => {
  it('creates intermediate objects when the path is absent', () => {
    const path = join(workdir, 'n.json');
    setNestedJson(path, ['env', 'API_KEY'], 'abc');
    expect(readJsonSafe(path)).toEqual({ env: { API_KEY: 'abc' } });
  });

  it('preserves sibling keys at the leaf level', () => {
    const path = join(workdir, 'n.json');
    writeFileSync(path, JSON.stringify({ env: { EXISTING: 'keep', OTHER: 1 } }));
    setNestedJson(path, ['env', 'NEW_KEY'], 'added');
    expect(readJsonSafe(path)).toEqual({
      env: { EXISTING: 'keep', OTHER: 1, NEW_KEY: 'added' },
    });
  });

  it('preserves sibling keys at intermediate levels', () => {
    const path = join(workdir, 'n.json');
    writeFileSync(
      path,
      JSON.stringify({
        existingRoot: 'stays',
        env: { OLD: 'stays' },
      }),
    );
    setNestedJson(path, ['teams', 'enabled'], true);
    expect(readJsonSafe(path)).toEqual({
      existingRoot: 'stays',
      env: { OLD: 'stays' },
      teams: { enabled: true },
    });
  });

  it('replaces non-object intermediates with a fresh object', () => {
    const path = join(workdir, 'n.json');
    writeFileSync(path, JSON.stringify({ env: 'was-a-string' }));
    setNestedJson(path, ['env', 'NEW'], 'fresh');
    expect(readJsonSafe(path)).toEqual({ env: { NEW: 'fresh' } });
  });

  it('throws when keyPath is empty', () => {
    const path = join(workdir, 'n.json');
    expect(() => setNestedJson(path, [], 'value')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// mergeOmcConfig / mergeSettingsJson
// ---------------------------------------------------------------------------

describe('mergeOmcConfig', () => {
  it('writes to <configDir>/.omc-config.json and preserves existing keys', () => {
    writeFileSync(join(workdir, '.omc-config.json'), JSON.stringify({ userKey: 1 }));
    mergeOmcConfig({ newKey: 'value' }, { configDir: workdir });
    expect(readJsonSafe(join(workdir, '.omc-config.json'))).toEqual({
      userKey: 1,
      newKey: 'value',
    });
  });

  it('re-reads the file on every call (no caching)', () => {
    const path = join(workdir, '.omc-config.json');
    mergeOmcConfig({ first: true }, { configDir: workdir });
    mergeOmcConfig({ second: true }, { configDir: workdir });
    expect(readJsonSafe(path)).toEqual({ first: true, second: true });
  });
});

describe('mergeSettingsJson', () => {
  it('writes to <configDir>/settings.json and preserves user keys', () => {
    writeFileSync(
      join(workdir, 'settings.json'),
      JSON.stringify({ theme: 'dark', userCustomKey: 'keep' }),
    );
    mergeSettingsJson({ theme: 'light' }, { configDir: workdir });
    expect(readJsonSafe(join(workdir, 'settings.json'))).toEqual({
      theme: 'light',
      userCustomKey: 'keep',
    });
  });
});

// ---------------------------------------------------------------------------
// Interrupt-safety simulation
// ---------------------------------------------------------------------------

describe('atomic write interrupt safety', () => {
  it('leaves the original file untouched when writeJsonAtomic cannot serialize', () => {
    const path = join(workdir, 'settings.json');
    const original = JSON.stringify({ userFavoriteColor: 'blue' });
    writeFileSync(path, original);

    // Unserializable value (circular reference) — triggers an error BEFORE
    // any fs mutation happens. Original must survive unchanged.
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    expect(() => writeJsonAtomic(path, circular)).toThrow();
    expect(readFileSync(path, 'utf-8')).toBe(original);
    // And no tmp files leaked.
    const leaks = readdirSync(workdir).filter((f) => f.includes('.tmp-'));
    expect(leaks).toEqual([]);
  });

  it('cleans up the temp file when atomicWriteFile fails on rename', () => {
    // Target "directory" exists as a file → rename will error. The tmp file
    // must be removed so repeated runs don't accumulate `.tmp-*` leftovers.
    const badPath = join(workdir, 'is-a-dir', 'file.json');
    writeFileSync(join(workdir, 'is-a-dir'), 'not actually a dir');
    expect(() => atomicWriteFile(badPath, 'hello')).toThrow();
    const leaks = readdirSync(workdir).filter((f) => f.includes('.tmp-'));
    expect(leaks).toEqual([]);
    // Guard: make sure we didn't accidentally clobber the existing file-
    // shaped-as-directory.
    expect(existsSync(join(workdir, 'is-a-dir'))).toBe(true);
  });
});
