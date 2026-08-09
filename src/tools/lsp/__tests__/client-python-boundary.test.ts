import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../servers.js', async importOriginal => {
  const original = await importOriginal<typeof import('../servers.js')>();
  return {
    ...original,
    commandExists: vi.fn(() => false)
  };
});

import { LspClient } from '../client.js';
import { getServerForFile } from '../servers.js';

const inheritedPythonLsp = process.env.OMC_PYTHON_LSP;

beforeEach(() => {
  delete process.env.OMC_PYTHON_LSP;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  if (inheritedPythonLsp === undefined) {
    delete process.env.OMC_PYTHON_LSP;
  } else {
    process.env.OMC_PYTHON_LSP = inheritedPythonLsp;
  }
});

describe('selected Python LSP connection boundary', () => {
  it('reports a missing basedpyright server without falling back to ty', async () => {
    vi.stubEnv('OMC_PYTHON_LSP', 'basedpyright');
    const config = getServerForFile('app.py');

    expect(config).toMatchObject({
      command: 'basedpyright-langserver',
      args: ['--stdio'],
      installHint: 'uv tool install basedpyright'
    });

    const client = new LspClient(process.cwd(), config!);
    const error = await client.connect().then(
      () => null,
      reason => reason as Error
    );

    expect(error?.message).toBe(
      "Language server 'basedpyright-langserver' not found.\nInstall with: uv tool install basedpyright"
    );
    expect(error?.message).not.toContain("Language server 'ty'");
  });
});
