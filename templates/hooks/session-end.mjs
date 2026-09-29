#!/usr/bin/env node
// OMC SessionEnd Hook — chain enqueuer forwarder (standalone installs)
// Forwards the SessionEnd payload to the OMC bridge (--hook=session-end), the
// only entry point that runs processSessionEnd → planChainEnqueue (software
// factory chain ledger, .omc/state/factory/chain-<sessionId>.json).
//
// Plugin installs register hooks/hooks.json → scripts/session-end.mjs instead;
// this file is copied to ~/.claude/hooks/ by ensureStandaloneHookScripts and
// referenced from settings.json (HOOKS_SETTINGS_CONFIG_NODE).
//
// Best-effort by design: any delegation failure exits 0 so a broken forward
// can never block Claude Code shutdown.

import { existsSync, readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
const { resolveOmcStateRoot } = await import(pathToFileURL(join(__dirname, 'lib', 'state-root.mjs')).href);

/**
 * Check if any factory chain ledger exists in the project.
 * Fast no-op for non-factory sessions (the common case). Resolves the state
 * root the same way the enqueuer does (getOmcRoot / OMC_STATE_DIR).
 */
async function hasFactoryChainLedger(cwd) {
  try {
    const factoryDir = join(await resolveOmcStateRoot(cwd), 'state', 'factory');
    if (!existsSync(factoryDir)) return false;
    const files = readdirSync(factoryDir);
    return files.some((f) => f.startsWith('chain-') && f.endsWith('.json'));
  } catch {
    return false;
  }
}

/**
 * Resolve the bridge invocation.
 * Precedence:
 *   1. CLAUDE_PLUGIN_ROOT/bridge/cli.cjs (plugin/dev context)
 *   2. omc-cli on PATH (npm global standalone installs — the bin IS the bridge)
 */
function resolveBridgeInvocation() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    const bridgePath = join(pluginRoot, 'bridge', 'cli.cjs');
    if (existsSync(bridgePath)) {
      // Direct execPath spawn: no shell, so install paths containing spaces
      // survive on Windows (shell:true would split "D:\Program Files\...").
      return { command: process.execPath, args: [bridgePath, '--hook=session-end'], shell: false };
    }
  }
  // omc-cli resolves through .cmd shims on Windows; cmd needs shell:true
  return { command: 'omc-cli', args: ['--hook=session-end'], shell: process.platform === 'win32' };
}

try {
  const stdin = await readStdin();
  let cwd = process.cwd();
  try {
    const payload = JSON.parse(stdin.toString('utf8'));
    if (payload && typeof payload.cwd === 'string') {
      cwd = payload.cwd;
    }
  } catch {
    // use default cwd
  }
  // Fast no-op for non-factory sessions (no chain ledger exists)
  if (!(await hasFactoryChainLedger(cwd))) {
    process.exit(0);
  }
  const bridge = resolveBridgeInvocation();
  const result = spawnSync(bridge.command, bridge.args, {
    input: stdin,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: bridge.shell,
    timeout: 10000,
    windowsHide: true,
  });
  // B5: a failed forward must never be silent. The forward stays best-effort
  // (exit 0, never block shutdown), but the lost chain enqueue is reported
  // loudly on stderr so resolution problems are diagnosable.
  const failure = result.error
    ?? (result.status !== 0 || result.signal !== null
      ? `exit status ${result.status}${result.signal ? ` (signal ${result.signal})` : ''}`
      : null);
  if (failure) {
    console.error(
      `[omc session-end] bridge forward FAILED (${failure}); chain enqueue was NOT performed.`
      + ` command: ${bridge.command} ${bridge.args.join(' ')}`,
    );
  }
} catch {
  // best-effort: chain enqueue is lost for this session, never block shutdown
}
process.exit(0);
