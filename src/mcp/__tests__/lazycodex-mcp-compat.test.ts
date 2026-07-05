import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NativeBridgeServerSchema,
  LazyCodexMcpServerNames,
  getAdvertisedStagedLazyCodexMcpServerNames,
  parseOmcMcpConfig,
} from '../lazycodex-mcp-compat.js';

function readMcpConfig(): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), '.mcp.json'), 'utf8'));
}

function smokeBridgeStartup(): Promise<string> {
  return new Promise((resolveSmoke, rejectSmoke) => {
    const child = spawn(process.execPath, ['bridge/mcp-server.cjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OMC_DISABLE_TOOLS: 'lsp,python,ast,state,notepad,memory,trace',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';

    const cleanup = (): void => {
      child.kill('SIGTERM');
    };

    const timer = setTimeout(() => {
      cleanup();
      rejectSmoke(
        new Error(`bridge startup smoke timed out; stderr=${stderr}; stdout=${stdout}`),
      );
    }, 2_000);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.includes('OMC Tools MCP Server running on stdio')) {
        clearTimeout(timer);
        cleanup();
        resolveSmoke(stderr);
      }
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      rejectSmoke(error);
    });

    child.on('exit', (code, signal) => {
      if (stderr.includes('OMC Tools MCP Server running on stdio')) {
        return;
      }

      clearTimeout(timer);
      rejectSmoke(
        new Error(`bridge exited before startup; code=${code}; signal=${signal}; stderr=${stderr}; stdout=${stdout}`),
      );
    });
  });
}

describe('LazyCodex MCP compatibility staging', () => {
  it('characterizes the current OMC bridge config as plugin-root relative', () => {
    // Given
    const config = z.object({
      mcpServers: z.object({
        t: NativeBridgeServerSchema,
      }),
    }).parse(readMcpConfig());

    // When
    const bridgeArgs = config.mcpServers.t.args;

    // Then
    expect(config.mcpServers.t.command).toBe('node');
    expect(bridgeArgs).toEqual(['${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs']);
  });

  it('exposes supported or staged status for every LazyCodex MCP server', () => {
    // Given
    const config = parseOmcMcpConfig(readMcpConfig());

    // When
    const statuses = config.lazyccCompatibility.lazycodexSource.mcpParity.servers;

    // Then
    for (const name of LazyCodexMcpServerNames) {
      const status = statuses[name];
      expect(status.supported || status.stagedReason.length > 0).toBe(true);
    }
  });

  it('does not advertise staged LazyCodex servers as fully supported MCP entries', () => {
    // Given
    const config = parseOmcMcpConfig(readMcpConfig());

    // Then
    expect(getAdvertisedStagedLazyCodexMcpServerNames(config)).toEqual([]);
  });

  it('rejects malformed LazyCodex MCP status records instead of coercing support', () => {
    // Given
    const validConfig = parseOmcMcpConfig(readMcpConfig());
    const malformedConfig = {
      ...validConfig,
      lazyccCompatibility: {
        ...validConfig.lazyccCompatibility,
        lazycodexSource: {
          ...validConfig.lazyccCompatibility.lazycodexSource,
          mcpParity: {
            ...validConfig.lazyccCompatibility.lazycodexSource.mcpParity,
            servers: {
              ...validConfig.lazyccCompatibility.lazycodexSource.mcpParity.servers,
              grep_app: {
                ...validConfig.lazyccCompatibility.lazycodexSource.mcpParity.servers.grep_app,
                supported: 'yes',
              },
            },
          },
        },
      },
    };

    // When
    const parseMalformedConfig = (): void => {
      parseOmcMcpConfig(malformedConfig);
    };

    // Then
    expect(parseMalformedConfig).toThrow(z.ZodError);
  });

  it('rejects legacy top-level LazyCodex compatibility metadata in public MCP config', () => {
    // Given
    const validConfig = parseOmcMcpConfig(readMcpConfig());
    const staleConfig = {
      ...validConfig,
      lazycodexCompatibility: {
        mcpParity: validConfig.lazyccCompatibility.lazycodexSource.mcpParity,
      },
    };

    // When
    const parseStaleConfig = (): void => {
      parseOmcMcpConfig(staleConfig);
    };

    // Then
    expect(parseStaleConfig).toThrow(z.ZodError);
  });

  it('keeps staged MCP config free of machine-local absolute paths', () => {
    // Given
    const rawConfig = readFileSync(resolve(process.cwd(), '.mcp.json'), 'utf8');
    const macHomePrefix = ['', 'Users', ''].join('/');
    const windowsHomePrefix = ['\\', 'Users', '\\'].join('');

    // Then
    expect(rawConfig).not.toContain(macHomePrefix);
    expect(rawConfig).not.toContain(windowsHomePrefix);
  });

  it('loads the native bridge long enough to emit the stdio startup line', async () => {
    // When
    const stderr = await smokeBridgeStartup();

    // Then
    expect(stderr).toContain('OMC Tools MCP Server running on stdio');
  });
});
