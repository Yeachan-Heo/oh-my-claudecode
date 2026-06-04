#!/usr/bin/env node
/**
 * Plugin Post-Install Setup
 *
 * Configures HUD statusline when plugin is installed.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, copyFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { buildHudWrapper } from './lib/hud-wrapper-template.mjs';
import { hookPrefixForPlatform, normalizeHooksDataForPlatform } from './lib/hook-command-normalizer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLAUDE_DIR = getClaudeConfigDir();
const HUD_DIR = join(CLAUDE_DIR, 'hud');
const HUD_LIB_DIR = join(HUD_DIR, 'lib');
const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');
// Store the absolute node binary path so find-node.sh can resolve Node for
// nvm/fnm users whose non-interactive hook shells do not include node on PATH
// (issue #892).
const nodeBin = process.execPath || 'node';
const isPublishedPluginCache = !existsSync(join(__dirname, '..', '.git'));


console.log('[OMC] Running post-install setup...');

function checkRalphRubyDependency() {
  try {
    execFileSync('ruby', ['--version'], { stdio: 'ignore', timeout: 5000 });
    console.log('[OMC] Ruby detected for Ralph workflows');
  } catch {
    console.log('[OMC] Warning: Ruby was not found on PATH. Ralph workflows require Ruby and may fail until it is installed.');
    console.log('[OMC] Ubuntu/Debian: sudo apt update && sudo apt install ruby-full');
    console.log('[OMC] macOS: brew install ruby');
    console.log('[OMC] After installing Ruby, restart Claude Code and rerun /oh-my-claudecode:omc-setup if needed.');
  }
}

checkRalphRubyDependency();

// 1. Create HUD directory
if (!existsSync(HUD_DIR)) {
  mkdirSync(HUD_DIR, { recursive: true });
}

if (!existsSync(HUD_LIB_DIR)) {
  mkdirSync(HUD_LIB_DIR, { recursive: true });
}
copyFileSync(join(__dirname, 'lib', 'config-dir.mjs'), join(HUD_LIB_DIR, 'config-dir.mjs'));
copyFileSync(join(__dirname, 'lib', 'config-dir.sh'), join(HUD_LIB_DIR, 'config-dir.sh'));
copyFileSync(join(__dirname, 'find-node.sh'), join(HUD_DIR, 'find-node.sh'));
copyFileSync(join(__dirname, 'lib', 'hud-cache-wrapper.sh'), join(HUD_DIR, 'omc-hud-cache.sh'));
try { chmodSync(join(HUD_DIR, 'find-node.sh'), 0o755); } catch { /* Windows doesn't need this */ }
try { chmodSync(join(HUD_DIR, 'omc-hud-cache.sh'), 0o755); } catch { /* Windows doesn't need this */ }

// 2. Create HUD wrapper script
const hudScriptPath = join(HUD_DIR, 'omc-hud.mjs').replace(/\\/g, '/');
const hudScript = buildHudWrapper();

writeFileSync(hudScriptPath, hudScript);
try {
  chmodSync(hudScriptPath, 0o755);
} catch { /* Windows doesn't need this */ }
console.log('[OMC] Installed HUD wrapper script');

// 3. Configure settings.json
try {
  let settings = {};
  if (existsSync(SETTINGS_FILE)) {
    settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
  }

  const statusLineCommand = process.platform === 'win32'
    ? `"${nodeBin}" "${hudScriptPath.replace(/\\/g, "/")}"`
    : `sh "${join(HUD_DIR, 'omc-hud-cache.sh').replace(/\\/g, "/")}" "${hudScriptPath.replace(/\\/g, "/")}"`;

  settings.statusLine = {
    type: 'command',
    command: statusLineCommand
  };
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  console.log('[OMC] Configured HUD statusLine in settings.json');

  // Persist the node binary path to .omc-config.json for use by find-node.sh
  try {
    const configPath = join(CLAUDE_DIR, '.omc-config.json');
    let omcConfig = {};
    if (existsSync(configPath)) {
      omcConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
    if (nodeBin !== 'node') {
      omcConfig.nodeBinary = nodeBin;
      writeFileSync(configPath, JSON.stringify(omcConfig, null, 2));
      console.log(`[OMC] Saved node binary path: ${nodeBin}`);
    }
  } catch (e) {
    console.log('[OMC] Warning: Could not save node binary path (non-fatal):', e.message);
  }
} catch (e) {
  console.log('[OMC] Warning: Could not configure settings.json:', e.message);
}

// Patch packaged plugin-cache hooks.json to keep plugin-provided hook commands
// safe for the platform that is installing the plugin cache. Claude Code's
// plugin loader reads hooks/hooks.json directly, so the source manifest remains
// native Windows-spawnable (direct node -> run.cjs, no sh/find-node). During
// setup from a published plugin cache on Unix/macOS, repair the cached manifest
// back to the find-node.sh bootstrap so nvm/fnm users whose non-interactive hook
// PATH lacks node keep working.
//
// Keep stale cache self-healing for older manifests that used sh/find-node, an
// accidentally baked absolute node path, or the Windows-safe direct node form.
//
// Patterns handled:
//  1. Current find-node.sh format – sh "$CLAUDE_PLUGIN_ROOT"/scripts/find-node.sh ...
//  2. Legacy find-node.sh format – sh "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" ...
//  3. Direct run.cjs format from the Windows-safe shipped manifest
//  4. Absolute run.cjs format from older setup patches/publish mistakes
//
// Fixes issues #909, #899, #892, #869, #3121.
try {
  const hooksJsonPath = isPublishedPluginCache ? join(__dirname, '..', 'hooks', 'hooks.json') : null;
  if (hooksJsonPath && existsSync(hooksJsonPath)) {
    const data = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    const patched = normalizeHooksDataForPlatform(data);

    if (patched) {
      writeFileSync(hooksJsonPath, JSON.stringify(data, null, 2) + '\n');
      const platformLabel = hookPrefixForPlatform().startsWith('node ') ? 'direct node run.cjs' : 'find-node.sh run.cjs';
      console.log(`[OMC] Patched hooks.json to use ${platformLabel} hook commands`);
    }
  }
} catch (e) {
  console.log('[OMC] Warning: Could not patch hooks.json:', e.message);
}

// 5. Ensure runtime dependencies are installed in the plugin cache directory.
//    The npm-published tarball includes only the files listed in "files" (package.json),
//    which does NOT include node_modules.  When Claude Code extracts the plugin into its
//    cache the dependencies are therefore missing, causing ERR_MODULE_NOT_FOUND at runtime.
//    We detect this by probing for a known production dependency (commander) and running a
//    production-only install when it is absent.  --ignore-scripts avoids re-triggering this
//    very setup script (and any other lifecycle hooks).  Fixes #1113.
const packageDir = join(__dirname, '..');
const commanderCheck = join(packageDir, 'node_modules', 'commander');
if (!existsSync(commanderCheck)) {
  console.log('[OMC] Installing runtime dependencies...');
  try {
    execSync('npm install --omit=dev --ignore-scripts', {
      cwd: packageDir,
      stdio: 'pipe',
      timeout: 60000,
    });
    console.log('[OMC] Runtime dependencies installed successfully');
  } catch (e) {
    console.log('[OMC] Warning: Could not install dependencies:', e.message);
  }
} else {
  console.log('[OMC] Runtime dependencies already present');
}

console.log('[OMC] Setup complete! Restart Claude Code to activate HUD.');
