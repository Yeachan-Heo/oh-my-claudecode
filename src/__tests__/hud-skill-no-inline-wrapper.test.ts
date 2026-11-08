import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..', '..');

const SKILL_PATH = join(root, 'skills', 'hud', 'SKILL.md');

describe('HUD skill — no inline wrapper', () => {
  const content = readFileSync(SKILL_PATH, 'utf8');

  it('does not embed an inline HUD wrapper script', () => {
    // The canonical wrapper lives in scripts/lib/hud-wrapper-template.txt.
    // The skill must copy from there, not embed its own version.
    // Match signatures unique to the wrapper body that should never appear inline.
    expect(content).not.toMatch(/async function main\(\)\s*\{/);
    expect(content).not.toMatch(/OMC_DEV.*===.*"1"/);
    expect(content).not.toMatch(/import.*from\s*["']node:fs["']/);
  });

  it('references the canonical template for installation', () => {
    expect(content).toMatch(/hud-wrapper-template\.txt/);
  });

  it('copies config-dir.mjs dependency', () => {
    expect(content).toMatch(/config-dir\.mjs/);
  });
});
