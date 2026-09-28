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

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);

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
      return { command: process.execPath, args: [bridgePath, '--hook=session-end'] };
    }
  }
  return { command: 'omc-cli', args: ['--hook=session-end'] };
}

try {
  const stdin = await readStdin();
  const bridge = resolveBridgeInvocation();
  spawnSync(bridge.command, bridge.args, {
    input: stdin,
    stdio: ['pipe', 'inherit', 'inherit'],
    // omc-cli resolves through .cmd shims on Windows; cmd needs shell:true
    shell: process.platform === 'win32',
    timeout: 10000,
    windowsHide: true,
  });
} catch {
  // best-effort: chain enqueue is lost for this session, never block shutdown
}
process.exit(0);
