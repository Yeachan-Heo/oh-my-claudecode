/**
 * Anti-drift guard for the legacy pre-marker template corpus (blocker 5).
 *
 * These checks are history-independent: they compare the shipped code constant
 * against the checked-in provenance manifest and the fixtures, so an accidental
 * edit to the signatures (or a normalization change) fails CI without needing a
 * git checkout. `scripts/generate-legacy-template-manifest.mjs --check`
 * additionally validates the manifest against git history in CI.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { LEGACY_TEMPLATE_SIGNATURES, normalizeTemplateLines } from '../index.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface ManifestEntry {
  blob: string;
  lineCount: number;
  sha256: string;
  heading: string;
  markerAbsence: boolean;
}

const manifest: ManifestEntry[] = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'legacy-template-manifest.json'), 'utf-8'),
);

const KNOWN_HEADINGS = new Set([
  '# oh-my-claudecode - Intelligent Multi-Agent Orchestration',
  '# OMC Multi-Agent System',
  '# Sisyphus Multi-Agent System',
]);

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');
const key = (entry: { lineCount: number; sha256: string }): string => `${entry.lineCount}:${entry.sha256}`;

describe('legacy template manifest ↔ code constant', () => {
  it('the code constant matches the checked-in manifest exactly', () => {
    const codeKeys = LEGACY_TEMPLATE_SIGNATURES.map(key).sort();
    const manifestKeys = manifest.map(key).sort();
    expect(codeKeys).toEqual(manifestKeys);
    expect(LEGACY_TEMPLATE_SIGNATURES).toHaveLength(manifest.length);
  });

  it('every manifest entry is a markerless template with a known heading and valid sha', () => {
    for (const entry of manifest) {
      expect(entry.markerAbsence).toBe(true);
      expect(KNOWN_HEADINGS.has(entry.heading)).toBe(true);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.lineCount).toBeGreaterThan(0);
    }
  });

  it('has no duplicate signatures', () => {
    const keys = manifest.map(key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the shipped fixtures normalize to signatures present in the manifest', () => {
    for (const [name, lineCount] of [
      ['legacy-guide-292.md', 292],
      ['legacy-guide-583.md', 583],
    ] as const) {
      const lines = normalizeTemplateLines(readFileSync(join(FIXTURES_DIR, name), 'utf-8'));
      expect(lines).toHaveLength(lineCount);
      const sha256 = sha256Hex(lines.join('\n'));
      expect(manifest.some(entry => entry.sha256 === sha256 && entry.lineCount === lineCount)).toBe(true);
      expect(LEGACY_TEMPLATE_SIGNATURES.some(sig => sig.sha256 === sha256)).toBe(true);
    }
  });
});
