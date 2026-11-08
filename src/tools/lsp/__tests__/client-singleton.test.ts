import { afterEach, describe, expect, it, vi } from 'vitest';

describe('lspClientManager singleton', () => {
  afterEach(async () => {
    const mod = await import('../client.js');
    await mod.disconnectAll();
    vi.resetModules();
  });

  it('reuses the same manager across module reloads in one process', async () => {
    vi.resetModules();
    const firstImport = await import('../client.js');
    const firstManager = firstImport.lspClientManager;

    vi.resetModules();
    const secondImport = await import('../client.js');

    expect(secondImport.lspClientManager).toBe(firstManager);
  });
});
