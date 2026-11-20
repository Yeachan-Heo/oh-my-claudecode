// A claude worker starting during a scale-up may read the hook settings while
// the team rewrites them. This writes the file in two steps, as a slow disk
// could, and reads the settings path between them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const probe = vi.hoisted(() => ({ path: '', seen: [] as string[] }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile = (async (file: Parameters<typeof actual.writeFile>[0], data: unknown) => {
    const text = String(data);
    await actual.writeFile(file, text.slice(0, text.length / 2));
    probe.seen.push(await actual.readFile(probe.path, 'utf8').catch(() => '<absent>'));
    await actual.appendFile(file, text.slice(text.length / 2));
  }) as typeof actual.writeFile;
  return { ...actual, writeFile, default: { ...actual, writeFile } };
});

import { providerEventSettingsPath, writeProviderEventSettings } from '../provider-events.js';

describe('writeProviderEventSettings while a reader looks', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'provider-events-settings-write-'));
    probe.path = providerEventSettingsPath(root);
    probe.seen = [];
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('never shows a reader half a settings file, on the first write or a rewrite', async () => {
    await writeProviderEventSettings(root);
    await writeProviderEventSettings(root);
    expect(probe.seen).toHaveLength(2);
    expect(probe.seen[0]).toBe('<absent>');
    expect(() => JSON.parse(probe.seen[1]!)).not.toThrow();
    expect(Object.keys(JSON.parse(readFileSync(probe.path, 'utf8')).hooks)).toHaveLength(4);
  });
});
