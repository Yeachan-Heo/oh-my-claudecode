// src/team/multiplexer/cmux-driver.ts
//
// Native cmux driver for OMC team worker spawning.
// Instead of falling back to a detached tmux session, this driver creates
// cmux surfaces (vertical tabs) or splits directly in the user's cmux window.

import { execFile as execFileCb } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CmuxLayout = 'tab' | 'split-right' | 'split-down' | 'split-left' | 'split-up';

export interface CmuxIdentity {
  workspaceRef: string;
  paneRef: string;
  surfaceRef: string;
  tabRef: string;
  windowRef: string;
}

export interface CmuxLeaderHandle {
  kind: 'cmux';
  identity: CmuxIdentity;
  layout: CmuxLayout;
}

export interface CmuxWorkerHandle {
  kind: 'cmux';
  surfaceRef: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CmuxUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CmuxUnsupportedError';
  }
}

export class CmuxCliNotFoundError extends CmuxUnsupportedError {
  constructor() {
    super(
      'cmux CLI not found. Ensure cmux.app is installed and shell integration is active.',
    );
    this.name = 'CmuxCliNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// CLI resolution
// ---------------------------------------------------------------------------

const CMUX_CLI_CANDIDATES = [
  // Shell integration adds this to PATH inside cmux surfaces
  'cmux',
];

function cmuxFallbackPaths(): string[] {
  const paths: string[] = [];
  const ghosttyBinDir = process.env.GHOSTTY_BIN_DIR;
  if (ghosttyBinDir) {
    const resourcesBin = ghosttyBinDir.replace(/\/MacOS\/?$/, '/Resources/bin/cmux');
    paths.push(resourcesBin);
  }
  paths.push('/Applications/cmux.app/Contents/Resources/bin/cmux');
  return paths;
}

let resolvedCmuxPath: string | null = null;

/**
 * Locate the cmux CLI binary. Caches the result for the process lifetime.
 * Returns the path or throws CmuxCliNotFoundError.
 */
export function resolveCmuxBinary(): string {
  if (resolvedCmuxPath !== null) return resolvedCmuxPath;

  // Try PATH-accessible 'cmux' first
  for (const candidate of CMUX_CLI_CANDIDATES) {
    try {
      // execFileSync with 'which' to probe PATH
      const { execFileSync } = require('child_process') as typeof import('child_process');
      const whichResult = execFileSync('which', [candidate], {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: 'pipe',
      }).trim();
      if (whichResult) {
        resolvedCmuxPath = whichResult;
        return resolvedCmuxPath;
      }
    } catch {
      // not on PATH
    }
  }

  // Try hardcoded fallback paths
  for (const fallback of cmuxFallbackPaths()) {
    if (existsSync(fallback)) {
      resolvedCmuxPath = fallback;
      return resolvedCmuxPath;
    }
  }

  throw new CmuxCliNotFoundError();
}

/** Reset cached binary path (for testing). */
export function _resetCmuxBinaryCache(): void {
  resolvedCmuxPath = null;
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

interface CmuxExecResult {
  stdout: string;
  stderr: string;
}

async function cmuxExec(args: string[]): Promise<CmuxExecResult> {
  const bin = resolveCmuxBinary();
  return execFileAsync(bin, args, {
    timeout: 10_000,
    encoding: 'utf-8',
    env: { ...process.env, CMUX_CLI_SENTRY_DISABLED: '1' },
  });
}

async function cmuxJson<T>(args: string[]): Promise<T> {
  const result = await cmuxExec(['--json', ...args]);
  return JSON.parse(result.stdout) as T;
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

const MIN_CMUX_VERSION = [0, 61, 0] as const;

function parseVersion(versionLine: string): [number, number, number] | null {
  const match = versionLine.match(/cmux\s+(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(
  current: [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (current[i]! > minimum[i]!) return true;
    if (current[i]! < minimum[i]!) return false;
  }
  return true; // equal
}

/**
 * Verify the cmux CLI is present and meets the minimum version requirement.
 * Throws CmuxUnsupportedError or CmuxCliNotFoundError on failure.
 */
export async function detectCmux(): Promise<void> {
  resolveCmuxBinary(); // throws CmuxCliNotFoundError

  const result = await cmuxExec(['version']);
  const version = parseVersion(result.stdout);
  if (!version) {
    throw new CmuxUnsupportedError(
      `Could not parse cmux version from: ${result.stdout.trim()}`,
    );
  }
  if (!versionAtLeast(version, MIN_CMUX_VERSION)) {
    throw new CmuxUnsupportedError(
      `cmux ${version.join('.')} is too old; OMC requires ${MIN_CMUX_VERSION.join('.')} or later`,
    );
  }
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

const LAYOUT_ALIASES: Record<string, CmuxLayout> = {
  tab: 'tab',
  tabs: 'tab',
  'split-right': 'split-right',
  'split-down': 'split-down',
  'split-left': 'split-left',
  'split-up': 'split-up',
  right: 'split-right',
  down: 'split-down',
  left: 'split-left',
  up: 'split-up',
};

export function resolveLayout(envValue?: string): CmuxLayout {
  if (!envValue) return 'tab';
  const normalized = envValue.trim().toLowerCase();
  const layout = LAYOUT_ALIASES[normalized];
  if (!layout) {
    console.warn(
      `[cmux-driver] Unknown OMC_CMUX_LAYOUT value "${envValue}", defaulting to "tab"`,
    );
    return 'tab';
  }
  return layout;
}

function splitDirection(layout: CmuxLayout): string {
  switch (layout) {
    case 'split-right': return 'right';
    case 'split-down': return 'down';
    case 'split-left': return 'left';
    case 'split-up': return 'up';
    default: return 'right'; // shouldn't reach
  }
}

// ---------------------------------------------------------------------------
// Driver operations
// ---------------------------------------------------------------------------

/**
 * Identify the caller's current cmux surface/pane/workspace.
 */
export async function identify(): Promise<CmuxIdentity> {
  interface IdentifyResponse {
    caller: {
      workspace_ref: string;
      pane_ref: string;
      surface_ref: string;
      tab_ref: string;
      window_ref: string;
    };
  }
  const data = await cmuxJson<IdentifyResponse>(['identify']);
  return {
    workspaceRef: data.caller.workspace_ref,
    paneRef: data.caller.pane_ref,
    surfaceRef: data.caller.surface_ref,
    tabRef: data.caller.tab_ref,
    windowRef: data.caller.window_ref,
  };
}

/**
 * Resolve the leader handle from the current cmux context.
 */
export async function resolveLeader(): Promise<CmuxLeaderHandle> {
  const identity = await identify();
  const layout = resolveLayout(process.env.OMC_CMUX_LAYOUT);
  return { kind: 'cmux', identity, layout };
}

/**
 * Parse a surface ref from cmux CLI output.
 * Tries JSON first (--json flag on the command), then falls back to
 * scanning lines for a 'surface:N' pattern.
 */
function parseSurfaceRef(stdout: string): string | null {
  // Try JSON parse
  try {
    const data = JSON.parse(stdout);
    if (data.surface_ref) return data.surface_ref as string;
    if (data.ref) return data.ref as string;
  } catch {
    // not JSON
  }
  // Scan for surface:N pattern
  const match = stdout.match(/surface:\d+/);
  return match ? match[0] : null;
}

/**
 * Spawn a worker surface in cmux. Returns a handle to the new surface.
 */
export async function spawnWorker(
  leader: CmuxLeaderHandle,
  label: string,
): Promise<CmuxWorkerHandle> {
  let result: CmuxExecResult;

  if (leader.layout === 'tab') {
    // Add a new surface (vertical tab) to the leader's pane
    result = await cmuxExec([
      '--json', 'new-surface',
      '--type', 'terminal',
      '--pane', leader.identity.paneRef,
    ]);
  } else {
    // Split the leader's surface in the requested direction
    const direction = splitDirection(leader.layout);
    result = await cmuxExec([
      '--json', 'new-split', direction,
      '--surface', leader.identity.surfaceRef,
    ]);
  }

  const surfaceRef = parseSurfaceRef(result.stdout);
  if (!surfaceRef) {
    throw new Error(
      `Failed to parse surface ref from cmux output: ${result.stdout.trim()}`,
    );
  }

  // Label the tab for the sidebar
  try {
    await cmuxExec(['rename-tab', '--surface', surfaceRef, label]);
  } catch {
    // Non-fatal: tab rename failure doesn't affect worker functionality
  }

  return { kind: 'cmux', surfaceRef, label };
}

/**
 * Send a command string to a cmux surface and press Return.
 */
export async function sendCommand(
  worker: CmuxWorkerHandle,
  command: string,
): Promise<void> {
  await cmuxExec(['send', '--surface', worker.surfaceRef, command]);
  await cmuxExec(['send-key', '--surface', worker.surfaceRef, 'Return']);
}

/**
 * Capture the terminal output of a cmux surface.
 */
export async function captureSurface(
  surfaceRef: string,
  lines: number = 80,
): Promise<string> {
  try {
    const result = await cmuxExec([
      'capture-pane', '--surface', surfaceRef, '--lines', String(lines),
    ]);
    return result.stdout;
  } catch {
    return '';
  }
}

/**
 * Focus the leader's pane (bring it to the front in the sidebar).
 */
export async function focusLeader(leader: CmuxLeaderHandle): Promise<void> {
  try {
    await cmuxExec([
      'tab-action', '--action', 'select',
      '--surface', leader.identity.surfaceRef,
    ]);
  } catch {
    // Non-fatal
  }
}

/**
 * Get a session name string for a cmux-based team session.
 * Used as the `sessionName` field in TeamSession for callers that
 * need a stable identifier.
 */
export function sessionName(leader: CmuxLeaderHandle): string {
  return `cmux:${leader.identity.workspaceRef}`;
}
