/**
 * Tests for src/setup/mcp-install.ts — claude mcp add wrapper.
 *
 * Strategy: we inject a fake `execFile` into `installMcpServers` so no real
 * `claude` process is spawned. All assertions are made against the captured
 * argv arrays. The invariants under test:
 *
 *   1. `--scope <value>` is ALWAYS present (default `user`).
 *   2. `-e KEY=` (empty env value) is NEVER passed — enforced for custom
 *      McpCustomSpec entries and implied by the skip-with-warning policy for
 *      context7/exa/github when credentials are missing.
 *   3. Missing credentials default to skip; `onMissingCredentials: 'error'`
 *      raises `McpCredentialMissingError`.
 *   4. Interactive blank response is treated as skip.
 *   5. Idempotence: the same server name listed twice only runs once.
 *   6. Custom McpCustomSpec entries produce the expected stdio/http args.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  installMcpServers,
  McpCredentialMissingError,
  type ExecFileFn,
  type McpInstallOptions,
} from '../mcp-install.js';
import type { McpCustomSpec, McpServerEntry, SetupOptions } from '../options.js';
import type { Prompter } from '../prompts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Recorder {
  calls: string[][];
  execFile: ExecFileFn;
}

function recorder(): Recorder {
  const calls: string[][] = [];
  const execFile: ExecFileFn = (file, args) => {
    calls.push([file, ...args]);
    return Buffer.from('');
  };
  return { calls, execFile };
}

function opts(partial: Partial<McpInstallOptions> = {}): McpInstallOptions {
  return {
    interactive: false,
    onMissingCredentials: 'skip',
    scope: 'user',
    logger: () => {},
    ...partial,
  };
}

function scriptedPrompter(secrets: Record<string, string>): Prompter {
  return {
    askSelect: async () => {
      throw new Error('not expected');
    },
    askConfirm: async () => {
      throw new Error('not expected');
    },
    askText: async () => {
      throw new Error('not expected');
    },
    askSecret: async (question: string) => {
      for (const [key, value] of Object.entries(secrets)) {
        if (question.includes(key)) return value;
      }
      return '';
    },
    close: () => {},
  };
}

// ---------------------------------------------------------------------------
// Scope invariant
// ---------------------------------------------------------------------------

describe('installMcpServers — --scope invariant', () => {
  it('always passes --scope user by default', async () => {
    const rec = recorder();
    const result = await installMcpServers(
      ['context7'],
      {},
      opts({ execFile: rec.execFile }),
    );
    expect(result.installed).toEqual(['context7']);
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0]!;
    expect(call[0]).toBe('claude');
    expect(call[1]).toBe('mcp');
    expect(call[2]).toBe('add');
    expect(call[3]).toBe('--scope');
    expect(call[4]).toBe('user');
  });

  it('honours an explicit opts.scope override', async () => {
    const rec = recorder();
    await installMcpServers(
      ['context7'],
      {},
      opts({ execFile: rec.execFile, scope: 'project' }),
    );
    expect(rec.calls[0]).toContain('--scope');
    expect(rec.calls[0]).toContain('project');
  });

  it('every installed server carries the scope flag', async () => {
    const rec = recorder();
    const servers: McpServerEntry[] = [
      'context7',
      'filesystem',
      { name: 'custom', spec: { name: 'custom', command: 'echo', args: ['hi'] } },
    ];
    await installMcpServers(servers, {}, opts({ execFile: rec.execFile }));
    for (const call of rec.calls) {
      const scopeIdx = call.indexOf('--scope');
      expect(scopeIdx).toBeGreaterThan(-1);
      expect(call[scopeIdx + 1]).toBe('user');
    }
  });
});

// ---------------------------------------------------------------------------
// Server-specific args
// ---------------------------------------------------------------------------

describe('installMcpServers — context7', () => {
  it('installs with no credentials', async () => {
    const rec = recorder();
    const result = await installMcpServers(
      ['context7'],
      {},
      opts({ execFile: rec.execFile }),
    );
    expect(result.installed).toEqual(['context7']);
    const call = rec.calls[0]!;
    expect(call).toEqual([
      'claude',
      'mcp',
      'add',
      '--scope',
      'user',
      'context7',
      '--',
      'npx',
      '-y',
      '@upstash/context7-mcp',
    ]);
  });
});

describe('installMcpServers — exa', () => {
  it('passes -e EXA_API_KEY=<value> when credentials are provided', async () => {
    const rec = recorder();
    const result = await installMcpServers(
      ['exa'],
      { exa: 'secret-key' },
      opts({ execFile: rec.execFile }),
    );
    expect(result.installed).toEqual(['exa']);
    const call = rec.calls[0]!;
    expect(call).toContain('-e');
    expect(call).toContain('EXA_API_KEY=secret-key');
    expect(call).toContain('exa');
    expect(call).toContain('exa-mcp-server');
    // CRITICAL: never `-e EXA_API_KEY=` (empty value).
    expect(call.some((a) => a === 'EXA_API_KEY=')).toBe(false);
  });

  it('skip-with-warning when credentials missing and mode=skip', async () => {
    const rec = recorder();
    const warnings: string[] = [];
    const result = await installMcpServers(
      ['exa'],
      {},
      opts({
        execFile: rec.execFile,
        onMissingCredentials: 'skip',
        logger: (m) => warnings.push(m),
      }),
    );
    expect(result.installed).toEqual([]);
    expect(result.skippedDueToMissingCreds).toEqual(['exa']);
    expect(rec.calls).toEqual([]);
    expect(warnings.join('\n')).toContain('skipping exa');
    // CRITICAL: the warning path must never have produced an argv.
    expect(rec.calls).toHaveLength(0);
  });

  it('throws McpCredentialMissingError when mode=error', async () => {
    const rec = recorder();
    await expect(
      installMcpServers(
        ['exa'],
        {},
        opts({ execFile: rec.execFile, onMissingCredentials: 'error' }),
      ),
    ).rejects.toBeInstanceOf(McpCredentialMissingError);
    expect(rec.calls).toEqual([]);
  });

  it('resolves missing creds via interactive prompter', async () => {
    const rec = recorder();
    const result = await installMcpServers(
      ['exa'],
      {},
      opts({
        execFile: rec.execFile,
        interactive: true,
        prompter: scriptedPrompter({ EXA_API_KEY: 'from-prompt' }),
      }),
    );
    expect(result.installed).toEqual(['exa']);
    expect(rec.calls[0]).toContain('EXA_API_KEY=from-prompt');
  });

  it('interactive blank response is treated as skip (no argv)', async () => {
    const rec = recorder();
    const result = await installMcpServers(
      ['exa'],
      {},
      opts({
        execFile: rec.execFile,
        interactive: true,
        prompter: scriptedPrompter({}), // askSecret returns ''
      }),
    );
    expect(result.installed).toEqual([]);
    expect(result.skippedDueToMissingCreds).toEqual(['exa']);
    expect(rec.calls).toEqual([]);
  });
});

describe('installMcpServers — filesystem', () => {
  it('uses creds.filesystem dirs when provided', async () => {
    const rec = recorder();
    const creds: SetupOptions['mcp']['credentials'] = {
      filesystem: ['/home/me', '/tmp/scratch'],
    };
    const result = await installMcpServers(
      ['filesystem'],
      creds,
      opts({ execFile: rec.execFile }),
    );
    expect(result.installed).toEqual(['filesystem']);
    const call = rec.calls[0]!;
    expect(call).toContain('/home/me');
    expect(call).toContain('/tmp/scratch');
    expect(call).toContain('@modelcontextprotocol/server-filesystem');
  });

  it('falls back to process.cwd() when no dirs are configured', async () => {
    const rec = recorder();
    await installMcpServers(
      ['filesystem'],
      {},
      opts({ execFile: rec.execFile }),
    );
    expect(rec.calls[0]).toContain(process.cwd());
  });
});

describe('installMcpServers — github', () => {
  it('passes -e GITHUB_PERSONAL_ACCESS_TOKEN=<token> when provided', async () => {
    const rec = recorder();
    const result = await installMcpServers(
      ['github'],
      { github: 'ghp_123' },
      opts({ execFile: rec.execFile }),
    );
    expect(result.installed).toEqual(['github']);
    const call = rec.calls[0]!;
    expect(call).toContain('-e');
    expect(call).toContain('GITHUB_PERSONAL_ACCESS_TOKEN=ghp_123');
    expect(call).toContain('docker');
  });

  it('falls back to HTTP transport when githubHttpTransport is set and token missing', async () => {
    const rec = recorder();
    const result = await installMcpServers(
      ['github'],
      {},
      opts({
        execFile: rec.execFile,
        githubHttpTransport: true,
      }),
    );
    expect(result.installed).toEqual(['github']);
    const call = rec.calls[0]!;
    expect(call).toContain('--transport');
    expect(call).toContain('http');
    expect(call).toContain('https://api.githubcopilot.com/mcp/');
    // Still has scope flag.
    expect(call).toContain('--scope');
    expect(call).toContain('user');
  });

  it('skips when no token and no HTTP fallback requested', async () => {
    const rec = recorder();
    const result = await installMcpServers(
      ['github'],
      {},
      opts({ execFile: rec.execFile }),
    );
    expect(result.installed).toEqual([]);
    expect(result.skippedDueToMissingCreds).toEqual(['github']);
  });
});

// ---------------------------------------------------------------------------
// Custom specs
// ---------------------------------------------------------------------------

describe('installMcpServers — custom McpCustomSpec', () => {
  it('constructs stdio args from command/args/env', async () => {
    const rec = recorder();
    const spec: McpCustomSpec = {
      name: 'myserver',
      command: 'node',
      args: ['server.js', '--port', '9000'],
      env: { DEBUG: '1', TOKEN: 'abc' },
    };
    const result = await installMcpServers(
      [{ name: 'myserver', spec }],
      {},
      opts({ execFile: rec.execFile }),
    );
    expect(result.installed).toEqual(['myserver']);
    const call = rec.calls[0]!;
    // Expected shape: claude mcp add --scope user -e DEBUG=1 -e TOKEN=abc myserver -- node server.js --port 9000
    expect(call).toContain('-e');
    expect(call).toContain('DEBUG=1');
    expect(call).toContain('TOKEN=abc');
    const idxName = call.indexOf('myserver');
    const idxSep = call.indexOf('--', idxName);
    expect(idxSep).toBeGreaterThan(idxName);
    expect(call.slice(idxSep + 1)).toEqual(['node', 'server.js', '--port', '9000']);
  });

  it('constructs http args from url/transport/headers', async () => {
    const rec = recorder();
    const spec: McpCustomSpec = {
      name: 'httpsrv',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer xyz' },
    };
    const result = await installMcpServers(
      [{ name: 'httpsrv', spec }],
      {},
      opts({ execFile: rec.execFile }),
    );
    expect(result.installed).toEqual(['httpsrv']);
    const call = rec.calls[0]!;
    expect(call).toContain('--transport');
    expect(call).toContain('http');
    expect(call).toContain('httpsrv');
    expect(call).toContain('https://example.com/mcp');
    expect(call).toContain('-H');
    expect(call).toContain('Authorization: Bearer xyz');
  });

  it('rejects empty env values — skip, never call claude with -e KEY=', async () => {
    const rec = recorder();
    const spec: McpCustomSpec = {
      name: 'bad',
      command: 'cmd',
      env: { KEY: '' },
    };
    const result = await installMcpServers(
      [{ name: 'bad', spec }],
      {},
      opts({ execFile: rec.execFile }),
    );
    expect(result.installed).toEqual([]);
    expect(result.skippedDueToMissingCreds).toEqual(['bad']);
    expect(rec.calls).toEqual([]);
  });

  it('skips http spec that is missing a url', async () => {
    const rec = recorder();
    const spec: McpCustomSpec = { name: 'incomplete', transport: 'http' };
    const result = await installMcpServers(
      [{ name: 'incomplete', spec }],
      {},
      opts({ execFile: rec.execFile }),
    );
    expect(result.installed).toEqual([]);
    expect(result.skippedDueToMissingCreds).toEqual(['incomplete']);
    expect(rec.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Idempotence & failures
// ---------------------------------------------------------------------------

describe('installMcpServers — idempotence & failure isolation', () => {
  it('does not double-install the same server name', async () => {
    const rec = recorder();
    const result = await installMcpServers(
      ['context7', 'context7'],
      {},
      opts({ execFile: rec.execFile }),
    );
    expect(result.installed).toEqual(['context7']);
    expect(rec.calls).toHaveLength(1);
  });

  it('captures execFile errors in the failed[] list without short-circuiting', async () => {
    const calls: string[][] = [];
    const execFile: ExecFileFn = (file, args) => {
      calls.push([file, ...args]);
      if (args.includes('context7')) {
        throw new Error('claude binary missing');
      }
      return Buffer.from('');
    };
    const result = await installMcpServers(
      ['context7', 'filesystem'],
      {},
      opts({ execFile }),
    );
    expect(result.installed).toEqual(['filesystem']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.name).toBe('context7');
    expect(result.failed[0]?.error).toContain('claude binary missing');
  });
});

// ---------------------------------------------------------------------------
// Logger contract
// ---------------------------------------------------------------------------

describe('installMcpServers — logger', () => {
  it('skips log as info, not error (warnings stay out of stderr)', async () => {
    const logged: string[] = [];
    const logger = vi.fn((m: string) => {
      logged.push(m);
    });
    await installMcpServers(
      ['exa'],
      {},
      opts({
        execFile: recorder().execFile,
        logger,
      }),
    );
    expect(logger).toHaveBeenCalled();
    expect(logged.some((l) => l.includes('skipping exa'))).toBe(true);
  });
});
