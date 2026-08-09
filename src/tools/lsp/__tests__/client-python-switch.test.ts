import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LspClient, LspClientManager } from '../client.js';

const inheritedPythonLsp = process.env.OMC_PYTHON_LSP;

beforeEach(() => {
  delete process.env.OMC_PYTHON_LSP;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(() => {
  if (inheritedPythonLsp === undefined) {
    delete process.env.OMC_PYTHON_LSP;
  } else {
    process.env.OMC_PYTHON_LSP = inheritedPythonLsp;
  }
});

describe('Python LSP client selection cache', () => {
  it('uses separate command-keyed clients and reuses ty after switching back', async () => {
    vi.spyOn(LspClient.prototype, 'connect').mockResolvedValue();
    vi.spyOn(LspClient.prototype, 'disconnect').mockResolvedValue();
    const manager = new LspClientManager();

    try {
      delete process.env.OMC_PYTHON_LSP;
      const tyClient = await manager.getClientForFile('app.py');
      expect(manager.clientCount).toBe(1);

      vi.stubEnv('OMC_PYTHON_LSP', 'basedpyright');
      const basedpyrightClient = await manager.getClientForFile('app.py');
      expect(manager.clientCount).toBe(2);
      expect(basedpyrightClient).not.toBe(tyClient);

      vi.stubEnv('OMC_PYTHON_LSP', 'ty');
      const reusedTyClient = await manager.getClientForFile('app.py');
      expect(manager.clientCount).toBe(2);
      expect(reusedTyClient).toBe(tyClient);
    } finally {
      await manager.disconnectAll();
    }
  });
});
