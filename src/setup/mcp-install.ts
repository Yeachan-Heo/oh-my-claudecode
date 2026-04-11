/**
 * MCP server installer — wraps `claude mcp add` for the setup flow.
 *
 * Plan reference: /Users/peter/.claude-personal/plans/replicated-mixing-wren.md
 *   — "MCP install port (`src/setup/mcp-install.ts`)"
 *   — "Pre-implementation blockers" (MCP empty-env and --scope findings)
 *
 * Critical invariants (verified by unit tests):
 *   1. **ALWAYS** pass `--scope <value>` (default `user`). Omitting it falls
 *      back to the `local` scope which is project-specific and mostly not
 *      what the user wants during an interactive setup.
 *   2. **NEVER** install with empty env values (`-e KEY=`). The Commander-based
 *      arg parser inside `claude mcp add` mis-identifies the empty value as
 *      the server name and rejects the call. Missing credentials must be
 *      skipped (default) or raised as `McpCredentialMissingError`.
 *   3. Credentials resolved interactively via `prompter.askSecret` — a blank
 *      response is equivalent to "skip this server".
 */

import { execFileSync } from 'child_process';
import type { McpCustomSpec, McpServerEntry, SetupOptions } from './options.js';
import type { Prompter } from './prompts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpInstallResult {
  installed: string[];
  skippedDueToMissingCreds: string[];
  /**
   * Servers installed WITHOUT credentials under `install-without-auth`
   * mode. They are visible in `claude mcp list` but will fail at runtime
   * until credentials are added. A subset of `installed`.
   */
  installedWithoutAuth: string[];
  failed: Array<{ name: string; error: string }>;
}

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options?: { stdio?: 'inherit' | 'pipe' | 'ignore'; encoding?: 'utf-8' },
) => Buffer | string;

export interface McpInstallOptions {
  interactive: boolean;
  /**
   * Policy when a credentialed MCP server has no credential available:
   *   - 'skip'                : leave it out of config entirely.
   *   - 'error'               : throw McpCredentialMissingError.
   *   - 'install-without-auth': install the server WITHOUT the `-e` flag
   *       so it's visible-but-broken in `claude mcp list`. For servers that
   *       need no credentials (context7, filesystem), this is equivalent to
   *       normal install.
   */
  onMissingCredentials: 'skip' | 'error' | 'install-without-auth';
  scope: 'local' | 'user' | 'project';
  prompter?: Prompter;
  execFile?: ExecFileFn;
  logger?: (msg: string) => void;
  /** Passed when the caller wants to opt into GitHub HTTP transport fallback. */
  githubHttpTransport?: boolean;
}

export class McpCredentialMissingError extends Error {
  constructor(
    public readonly server: string,
    public readonly envVar: string,
  ) {
    super(
      `MCP server "${server}" requires credential ${envVar} but none was provided. `
      + 'Set it via env var, preset, or enable interactive mode.',
    );
    this.name = 'McpCredentialMissingError';
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function installMcpServers(
  servers: SetupOptions['mcp']['servers'],
  creds: SetupOptions['mcp']['credentials'],
  opts: McpInstallOptions,
): Promise<McpInstallResult> {
  const result: McpInstallResult = {
    installed: [],
    skippedDueToMissingCreds: [],
    installedWithoutAuth: [],
    failed: [],
  };

  const runExec: ExecFileFn = opts.execFile ?? execFileSync;
  const log = opts.logger ?? ((msg: string) => { console.log(msg); });
  const scope = opts.scope ?? 'user';

  // Track what we've already added so the same entry listed twice (or once
  // as string + once as a full custom spec with the same name) only runs
  // through `claude mcp add` a single time.
  const seen = new Set<string>();

  for (const entry of servers) {
    const entryName = entryToName(entry);
    if (seen.has(entryName)) continue;
    seen.add(entryName);

    try {
      const action = await planInstall(entry, creds, opts, log);
      if (action.kind === 'skip') {
        result.skippedDueToMissingCreds.push(entryName);
        log(`[mcp] skipping ${entryName}: ${action.reason}`);
        continue;
      }
      runClaudeMcpAdd(runExec, action.args, scope);
      result.installed.push(entryName);
      if (action.withoutAuth) {
        result.installedWithoutAuth.push(entryName);
        log(
          `[mcp] installed ${entryName} WITHOUT credentials — visible in `
          + '`claude mcp list` but will fail at runtime until credentials are configured',
        );
      } else {
        log(`[mcp] installed ${entryName}`);
      }
    } catch (err) {
      if (err instanceof McpCredentialMissingError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ name: entryName, error: message });
      log(`[mcp] failed ${entryName}: ${message}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Planning: entry → args
// ---------------------------------------------------------------------------

interface PlanInstall {
  kind: 'install';
  /** Args after `claude mcp add` and before the scope flag. */
  args: string[];
  /**
   * True when the plan was produced for `install-without-auth` mode on a
   * credentialed server whose credential was missing. The `-e` flag is
   * omitted so `claude mcp add` doesn't reject an empty env value.
   */
  withoutAuth?: boolean;
}
interface PlanSkip {
  kind: 'skip';
  reason: string;
}
type Plan = PlanInstall | PlanSkip;

async function planInstall(
  entry: McpServerEntry,
  creds: SetupOptions['mcp']['credentials'],
  opts: McpInstallOptions,
  log: (msg: string) => void,
): Promise<Plan> {
  if (entry === 'context7') {
    return {
      kind: 'install',
      args: ['context7', '--', 'npx', '-y', '@upstash/context7-mcp'],
    };
  }

  if (entry === 'exa') {
    const key = await resolveSecret(
      'EXA_API_KEY',
      creds.exa,
      'Enter EXA_API_KEY (blank to skip): ',
      'exa',
      opts,
    );
    if (!key) {
      if (opts.onMissingCredentials === 'install-without-auth') {
        return {
          kind: 'install',
          withoutAuth: true,
          args: [
            'exa',
            '--',
            'npx',
            '-y',
            'exa-mcp-server',
          ],
        };
      }
      return { kind: 'skip', reason: 'EXA_API_KEY not provided' };
    }
    return {
      kind: 'install',
      args: [
        '-e',
        `EXA_API_KEY=${key}`,
        'exa',
        '--',
        'npx',
        '-y',
        'exa-mcp-server',
      ],
    };
  }

  if (entry === 'filesystem') {
    const dirs = creds.filesystem && creds.filesystem.length > 0
      ? creds.filesystem
      : [process.cwd()];
    return {
      kind: 'install',
      args: [
        'filesystem',
        '--',
        'npx',
        '-y',
        '@modelcontextprotocol/server-filesystem',
        ...dirs,
      ],
    };
  }

  if (entry === 'github') {
    const token = await resolveSecret(
      'GITHUB_TOKEN',
      creds.github,
      'Enter GITHUB_PERSONAL_ACCESS_TOKEN (blank to skip): ',
      'github',
      opts,
    );
    if (token) {
      return {
        kind: 'install',
        args: [
          '-e',
          `GITHUB_PERSONAL_ACCESS_TOKEN=${token}`,
          'github',
          '--',
          'docker',
          'run',
          '-i',
          '--rm',
          '-e',
          'GITHUB_PERSONAL_ACCESS_TOKEN',
          'ghcr.io/github/github-mcp-server',
        ],
      };
    }
    if (opts.githubHttpTransport) {
      log('[mcp] github: falling back to HTTP transport (no token required)');
      return {
        kind: 'install',
        args: [
          '--transport',
          'http',
          'github',
          'https://api.githubcopilot.com/mcp/',
        ],
      };
    }
    if (opts.onMissingCredentials === 'install-without-auth') {
      return {
        kind: 'install',
        withoutAuth: true,
        args: [
          'github',
          '--',
          'docker',
          'run',
          '-i',
          '--rm',
          '-e',
          'GITHUB_PERSONAL_ACCESS_TOKEN',
          'ghcr.io/github/github-mcp-server',
        ],
      };
    }
    return { kind: 'skip', reason: 'GitHub token not provided' };
  }

  // Custom server spec
  return planCustom(entry, opts);
}

function planCustom(
  entry: { name: string; spec: McpCustomSpec },
  opts: McpInstallOptions,
): Plan {
  const spec = entry.spec;
  const args: string[] = [];
  let withoutAuth = false;

  // Env vars. Reject empty values per blocker finding — UNLESS
  // `install-without-auth` mode is active, in which case we omit the empty
  // pair entirely so `claude mcp add` receives a valid argv and the server
  // appears in `claude mcp list` but fails at runtime.
  if (spec.env) {
    for (const [k, v] of Object.entries(spec.env)) {
      if (v === undefined || v === null || v === '') {
        if (opts.onMissingCredentials === 'install-without-auth') {
          withoutAuth = true;
          continue;
        }
        return {
          kind: 'skip',
          reason: `env var ${k} is empty — refusing to pass -e ${k}= to claude mcp add`,
        };
      }
      args.push('-e', `${k}=${v}`);
    }
  }

  // Headers (for http transport).
  if (spec.headers) {
    for (const [k, v] of Object.entries(spec.headers)) {
      if (v === undefined || v === null || v === '') {
        return {
          kind: 'skip',
          reason: `header ${k} is empty — refusing to pass -H ${k}= to claude mcp add`,
        };
      }
      args.push('-H', `${k}: ${v}`);
    }
  }

  if (spec.transport === 'http') {
    args.push('--transport', 'http');
    args.push(spec.name);
    if (!spec.url) {
      return { kind: 'skip', reason: `custom HTTP server "${spec.name}" missing url` };
    }
    args.push(spec.url);
    return { kind: 'install', args, withoutAuth };
  }

  // stdio (default)
  args.push(spec.name);
  if (!spec.command) {
    return { kind: 'skip', reason: `custom stdio server "${spec.name}" missing command` };
  }
  args.push('--', spec.command, ...(spec.args ?? []));
  return { kind: 'install', args, withoutAuth };
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

async function resolveSecret(
  envVar: string,
  fromCreds: string | undefined,
  promptMessage: string,
  serverName: string,
  opts: McpInstallOptions,
): Promise<string | null> {
  if (fromCreds && fromCreds.length > 0) return fromCreds;
  if (opts.interactive && opts.prompter) {
    const answer = await opts.prompter.askSecret(promptMessage);
    const trimmed = answer.trim();
    if (trimmed.length === 0) return null;
    return trimmed;
  }
  if (opts.onMissingCredentials === 'error') {
    throw new McpCredentialMissingError(serverName, envVar);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

function runClaudeMcpAdd(
  execFile: ExecFileFn,
  addArgs: string[],
  scope: 'local' | 'user' | 'project',
): void {
  // Prepend `mcp add --scope <scope>` so the caller only has to worry about
  // the server-specific tail.
  const fullArgs = ['mcp', 'add', '--scope', scope, ...addArgs];
  execFile('claude', fullArgs, { stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entryToName(entry: McpServerEntry): string {
  if (typeof entry === 'string') return entry;
  return entry.name;
}
