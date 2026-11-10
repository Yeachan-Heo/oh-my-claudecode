import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A plugin install runs the committed bridge bundles from a cache directory with
// no node_modules (issue #4954), so each MCP bundle must start and answer
// `initialize` from a directory that holds nothing but the bundle itself.
const REPO_ROOT = join(__dirname, '..', '..');
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});

describe('committed MCP bridge bundles are self-contained (#4954)', () => {
  for (const bundle of ['bridge/mcp-server.cjs', 'bridge/team-mcp.cjs']) {
    it(`${bundle} answers initialize without node_modules`, () => {
      const root = mkdtempSync(join(tmpdir(), 'omc-bridge-clean-'));
      try {
        mkdirSync(join(root, 'bridge'));
        copyFileSync(join(REPO_ROOT, bundle), join(root, bundle));
        const result = spawnSync(process.execPath, [bundle], {
          cwd: root,
          input: `${INITIALIZE}\n`,
          encoding: 'utf8',
          timeout: 20000,
          env: { PATH: process.env.PATH ?? '', HOME: root, CLAUDE_PLUGIN_ROOT: root, NODE_PATH: '' },
        });
        expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
        const response = result.stdout
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line) as { id?: number; result?: { protocolVersion?: string } })
          .find((message) => message.id === 1);
        expect(response?.result?.protocolVersion).toBe('2025-06-18');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 30000);
  }
});
