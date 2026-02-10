// src/team/bridge-entry.ts
//
// Entry point for the bridge daemon, invoked from tmux:
//   node dist/team/bridge-entry.js --config /path/to/config.json
//
// Config via temp file, not inline JSON argument.

import { readFileSync, statSync, realpathSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import type { BridgeConfig } from './types.js';
import { runBridge } from './mcp-team-bridge.js';
import { deleteHeartbeat } from './heartbeat.js';
import { unregisterMcpWorker } from './team-registration.js';
import { getWorktreeRoot } from '../lib/worktree-paths.js';
import { sanitizeName } from './tmux-session.js';

/**
 * Validate that a config path is under the user's home directory
 * and contains a trusted subpath (/.claude/ or /.omc/).
 * Resolves the path first to defeat traversal attacks like ~/foo/.claude/../../evil.json.
 */
export function validateConfigPath(configPath: string, homeDir: string): boolean {
  // Resolve to canonical absolute path to defeat ".." traversal
  const resolved = resolve(configPath);

  const isUnderHome = resolved.startsWith(homeDir + '/') || resolved === homeDir;
  const isTrustedSubpath = resolved.includes('/.claude/') || resolved.includes('/.omc/');
  if (!isUnderHome || !isTrustedSubpath) return false;

  // Additionally verify via realpathSync on the parent directory (if it exists)
  // to defeat symlink attacks where the parent is a symlink outside home
  try {
    const parentDir = resolve(resolved, '..');
    const realParent = realpathSync(parentDir);
    if (!realParent.startsWith(homeDir + '/') && realParent !== homeDir) {
      return false;
    }
  } catch {
    // Parent directory doesn't exist yet — allow (file may be about to be created)
  }

  return true;
}

/**
 * Validate the bridge working directory is safe:
 * - Must exist and be a directory
 * - Must resolve (via realpathSync) to a path under the user's home directory
 * - Must be inside a git worktree
 */
function validateBridgeWorkingDirectory(workingDirectory: string): void {
  // Check exists and is directory
  let stat;
  try {
    stat = statSync(workingDirectory);
  } catch {
    throw new Error(`workingDirectory does not exist: ${workingDirectory}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`workingDirectory is not a directory: ${workingDirectory}`);
  }

  // Resolve symlinks and verify under homedir
  const resolved = realpathSync(workingDirectory);
  const home = homedir();
  if (!resolved.startsWith(home + '/') && resolved !== home) {
    throw new Error(`workingDirectory is outside home directory: ${resolved}`);
  }

  // Must be inside a git worktree
  const root = getWorktreeRoot(workingDirectory);
  if (!root) {
    throw new Error(`workingDirectory is not inside a git worktree: ${workingDirectory}`);
  }
}

function main(): void {
  // Parse --config flag
  const configIdx = process.argv.indexOf('--config');
  if (configIdx === -1 || !process.argv[configIdx + 1]) {
    console.error('Usage: node bridge-entry.js --config <path-to-config.json>');
    process.exit(1);
  }

  const configPath = resolve(process.argv[configIdx + 1]);

  // Validate config path is from a trusted location
  const home = homedir();
  if (!validateConfigPath(configPath, home)) {
    console.error(`Config path must be under ~/ with .claude/ or .omc/ subpath: ${configPath}`);
    process.exit(1);
  }

  let config: BridgeConfig;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read config from ${configPath}: ${(err as Error).message}`);
    process.exit(1);
  }

  // Validate required fields
  const required: (keyof BridgeConfig)[] = ['teamName', 'workerName', 'provider', 'workingDirectory'];
  for (const field of required) {
    if (!config[field]) {
      console.error(`Missing required config field: ${field}`);
      process.exit(1);
    }
  }

  // Sanitize team and worker names (prevent tmux injection)
  config.teamName = sanitizeName(config.teamName);
  config.workerName = sanitizeName(config.workerName);

  // Validate provider
  if (config.provider !== 'codex' && config.provider !== 'gemini') {
    console.error(`Invalid provider: ${config.provider}. Must be 'codex' or 'gemini'.`);
    process.exit(1);
  }

  // Validate working directory before use
  try {
    validateBridgeWorkingDirectory(config.workingDirectory);
  } catch (err) {
    console.error(`[bridge] Invalid workingDirectory: ${(err as Error).message}`);
    process.exit(1);
  }

  // Validate permission enforcement config
  if (config.permissionEnforcement) {
    const validModes = ['off', 'audit', 'enforce'];
    if (!validModes.includes(config.permissionEnforcement)) {
      console.error(`Invalid permissionEnforcement: ${config.permissionEnforcement}. Must be 'off', 'audit', or 'enforce'.`);
      process.exit(1);
    }

    // Validate permissions shape when enforcement is active
    if (config.permissionEnforcement !== 'off' && config.permissions) {
      const p = config.permissions;
      if (p.allowedPaths && !Array.isArray(p.allowedPaths)) {
        console.error('permissions.allowedPaths must be an array of strings');
        process.exit(1);
      }
      if (p.deniedPaths && !Array.isArray(p.deniedPaths)) {
        console.error('permissions.deniedPaths must be an array of strings');
        process.exit(1);
      }
      if (p.allowedCommands && !Array.isArray(p.allowedCommands)) {
        console.error('permissions.allowedCommands must be an array of strings');
        process.exit(1);
      }

      // Reject dangerous patterns that could defeat the deny-defaults
      const dangerousPatterns = ['**', '*', '!.git/**', '!.env*', '!**/.env*'];
      for (const pattern of (p.allowedPaths || [])) {
        if (dangerousPatterns.includes(pattern)) {
          console.error(`Dangerous allowedPaths pattern rejected: "${pattern}"`);
          process.exit(1);
        }
      }
    }
  }

  // Apply defaults
  config.pollIntervalMs = config.pollIntervalMs || 3000;
  config.taskTimeoutMs = config.taskTimeoutMs || 600_000;
  config.maxConsecutiveErrors = config.maxConsecutiveErrors || 3;
  config.outboxMaxLines = config.outboxMaxLines || 500;
  config.maxRetries = config.maxRetries || 5;
  config.permissionEnforcement = config.permissionEnforcement || 'off';

  // Signal handlers for graceful cleanup on external termination
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      console.error(`[bridge] Received ${sig}, shutting down...`);
      try {
        deleteHeartbeat(config.workingDirectory, config.teamName, config.workerName);
        unregisterMcpWorker(config.teamName, config.workerName, config.workingDirectory);
      } catch { /* best-effort cleanup */ }
      process.exit(0);
    });
  }

  // Run bridge (never returns unless shutdown)
  runBridge(config).catch(err => {
    console.error(`[bridge] Fatal error: ${(err as Error).message}`);
    process.exit(1);
  });
}

// Only run main if this file is the entry point (not imported for testing).
// Note: require.main === module is correct here - this file is bundled to CJS by esbuild.
if (require.main === module) {
  main();
}
