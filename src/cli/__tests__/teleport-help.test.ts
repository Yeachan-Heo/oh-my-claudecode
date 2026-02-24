import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const cliIndexSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'),
  'utf-8'
);

describe('teleport help text (issue #968)', () => {
  it('uses quoted #N references in teleport invocation examples', () => {
    expect(cliIndexSource).toContain("omc teleport '#123'");
    expect(cliIndexSource).toContain("omc teleport '#42'");
    expect(cliIndexSource).not.toMatch(/omc teleport #\d+/);
  });

  it('documents shell comment behavior in both help surfaces', () => {
    const matches = cliIndexSource.match(/In many shells, # starts a comment/g) ?? [];
    expect(matches).toHaveLength(2);
  });
});
