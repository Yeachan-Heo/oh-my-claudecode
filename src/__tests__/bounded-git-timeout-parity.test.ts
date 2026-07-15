import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptsModule = '../../scripts/lib/bounded-git-timeout.mjs';
const templateModule = '../../templates/hooks/lib/bounded-git-timeout.mjs';
const scriptsFile = join(process.cwd(), 'scripts', 'lib', 'bounded-git-timeout.mjs');
const templateFile = join(process.cwd(), 'templates', 'hooks', 'lib', 'bounded-git-timeout.mjs');

describe('bounded git timeout installation parity', () => {
  it('keeps installed and source timeout modules byte-identical', async () => {
    const [scripts, template] = await Promise.all([import(scriptsModule), import(templateModule)]);

    expect(scripts.BOUNDED_GIT_TIMEOUT_MS).toBe(2000);
    expect(template.BOUNDED_GIT_TIMEOUT_MS).toBe(2000);
    expect(template.BOUNDED_GIT_TIMEOUT_MS).toBe(scripts.BOUNDED_GIT_TIMEOUT_MS);
    expect(readFileSync(templateFile)).toEqual(readFileSync(scriptsFile));
  });
});
