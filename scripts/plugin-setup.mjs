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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLAUDE_DIR = getClaudeConfigDir();
const HUD_DIR = join(CLAUDE_DIR, 'hud');
const HUD_LIB_DIR = join(HUD_DIR, 'lib');
const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');
// Use the absolute node binary path so nvm/fnm users don't get
// "node not found" errors in non-interactive shells (issue #892).
const nodeBin = process.execPath || 'node';

console.log('[OMC] Running post-install setup...');

// 1. Create HUD directory
if (!existsSync(HUD_DIR)) {
  mkdirSync(HUD_DIR, { recursive: true });
}

if (!existsSync(HUD_LIB_DIR)) {
  mkdirSync(HUD_LIB_DIR, { recursive: true });
}
copyFileSync(join(__dirname, 'lib', 'config-dir.mjs'), join(HUD_LIB_DIR, 'config-dir.mjs'));

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

  settings.statusLine = {
    type: 'command',
    command: `"${nodeBin}" "${hudScriptPath.replace(/\\/g, "/")}"`
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

// Patch hooks.json to use the absolute node binary path so hooks work on all
// platforms: Windows (no `sh`), nvm/fnm users (node not on PATH in hooks), etc.
//
// The source hooks.json uses shell-expanded `$CLAUDE_PLUGIN_ROOT` path segments
// so bash preserves spaces in Windows profile paths; this step only substitutes
// the real process.execPath so Claude Code always invokes the same Node binary
// that ran this setup script.
//
// Two patterns are handled:
//  1. New format  – node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ... (all platforms)
//  2. Old format  – sh  "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" ... (Windows
//     backward-compat: migrates old installs to the new run.cjs chain)
//
// Fixes issues #909, #899, #892, #869.
try {
  const hooksJsonPath = join(__dirname, '..', 'hooks', 'hooks.json');
  if (existsSync(hooksJsonPath)) {
    const data = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    let patched = false;

    // Pattern 2 (old, Windows backward-compat): sh find-node.sh <target> [args]
    const findNodePattern =
      /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/find-node\.sh" "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([^"]+)"(.*)$/;

    for (const groups of Object.values(data.hooks ?? {})) {
      for (const group of groups) {
        for (const hook of (group.hooks ?? [])) {
          if (typeof hook.command !== 'string') continue;

          // New run.cjs format — replace bare `node` with absolute path (all platforms)
          if (hook.command.startsWith('node ') && hook.command.includes('/scripts/run.cjs')) {
            hook.command = hook.command.replace(/^node\b/, `"${nodeBin}"`);
            patched = true;
            continue;
          }

          // Self-healing: if hooks.json already contains an absolute node path
          // from a previous patch (possibly on a different machine, e.g. the
          // GitHub Actions runner at publish time — see issue #2348), and that
          // path is either missing on this machine or differs from the current
          // node binary, rewrite it to the current `nodeBin`.  Without this
          // users who install a tarball that was accidentally published with a
          // stale absolute path (e.g. /opt/hostedtoolcache/node/.../bin/node)
          // can never self-heal, because the bare-`node` branch above no longer
          // matches.
          const absNodeMatch = hook.command.match(
            /^"([^"]*\/node|[A-Za-z]:\\[^"]*\\node(?:\.exe)?)"\s+.*\/scripts\/run\.cjs/,
          );
          if (absNodeMatch) {
            const currentBin = absNodeMatch[1];
            if (currentBin !== nodeBin && (!existsSync(currentBin) || currentBin.includes('/hostedtoolcache/'))) {
              hook.command = hook.command.replace(
                /^"[^"]*"/,
                `"${nodeBin}"`,
              );
              patched = true;
            }
            continue;
          }

          // Old find-node.sh format — migrate to run.cjs + absolute path (Windows only)
          if (process.platform === 'win32') {
            const m2 = hook.command.match(findNodePattern);
            if (m2) {
              hook.command = `"${nodeBin}" "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/${m2[1]}${m2[2]}`;
              patched = true;
            }
          }
        }
      }
    }

    if (patched) {
      writeFileSync(hooksJsonPath, JSON.stringify(data, null, 2) + '\n');
      console.log(`[OMC] Patched hooks.json with absolute node path (${nodeBin}), fixes issues #909, #899, #892`);
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
