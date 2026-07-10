import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MCP_JSON_PATH,
  PACKAGE_ROOT,
  PLUGIN_JSON_PATH,
  listSourceControlledPackageFiles,
  readPluginMcpServers,
  referencesRootMcpConfig,
  referencesStandardHooksManifest,
  type PluginJson,
} from './npm-package-surface-helpers.js';

describe('npm package hook surface regression', () => {
  it('builds the coordinator for packaging without mutating ordinary test entrypoints', () => {
    const packageJson = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'),
    ) as {
      files?: string[];
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.build).toMatch(
      /npm run compose-docs && npm run build:claude-md-coordinator/,
    );
    for (const entrypoint of ['test', 'test:ui', 'test:run', 'test:coverage']) {
      expect(packageJson.scripts?.[entrypoint], entrypoint).not.toContain(
        'build:claude-md-coordinator',
      );
    }
    expect(packageJson.scripts?.prepack).toBe('npm run build');
    expect(packageJson.scripts?.prepublishOnly).toBe('npm run build');
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        '.claude-plugin',
        '.mcp.json',
        'hooks',
        'scripts',
        'templates',
      ]),
    );
  });

  it('keeps the source-controlled plugin and MCP manifests wired to exact standard entrypoints', () => {
    expect(existsSync(PLUGIN_JSON_PATH)).toBe(true);
    expect(existsSync(MCP_JSON_PATH)).toBe(true);

    const pluginJson = JSON.parse(
      readFileSync(PLUGIN_JSON_PATH, 'utf-8'),
    ) as PluginJson;
    expect(referencesStandardHooksManifest(pluginJson.hooks)).toBe(false);
    expect(referencesRootMcpConfig(pluginJson.mcpServers)).toBe(true);

    expect(Object.values(readPluginMcpServers())).toEqual([
      {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs'],
      },
    ]);
  });

  it('keeps the complete hook dependency and template payload source-controlled', () => {
    const requiredFiles = listSourceControlledPackageFiles();

    expect(requiredFiles).toContain('commands/omc-setup.md');
    expect(requiredFiles).not.toHaveLength(0);
    expect(
      requiredFiles.filter((file) => !existsSync(join(PACKAGE_ROOT, file))),
    ).toEqual([]);
  });
});
