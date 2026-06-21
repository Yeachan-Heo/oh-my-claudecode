import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('.omc gitignore state contract', () => {
  it('ignores runtime .omc state while allowing project skills to be committed intentionally', () => {
    const gitignore = readFileSync(resolve(process.cwd(), '.gitignore'), 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(gitignore).toEqual(expect.arrayContaining([
      '!.omc/',
      '.omc/*',
      '!.omc/skills/',
      '!.omc/skills/**',
    ]));

    expect(gitignore.indexOf('!.omc/')).toBeLessThan(gitignore.indexOf('.omc/*'));
    expect(gitignore.indexOf('.omc/*')).toBeLessThan(gitignore.indexOf('!.omc/skills/'));
    expect(gitignore.indexOf('!.omc/skills/')).toBeLessThan(gitignore.indexOf('!.omc/skills/**'));
  });
});
