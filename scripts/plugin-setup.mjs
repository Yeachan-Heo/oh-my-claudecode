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
// Store the absolute node binary path so find-node.sh can resolve Node for
// nvm/fnm users whose non-interactive hook shells do not include node on PATH
// (issue #892).
const nodeBin = process.execPath || 'node';

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

// Patch hooks.json to keep plugin-provided hook commands portable across
// machines. Hooks must not bake the installer's local Node path into package
// metadata, but they must also not depend on `node` being on hook PATH. The
// portable Unix bootstrap is sh + find-node.sh + run.cjs; setup still
// persists an absolute Node path to .omc-config.json for find-node.sh.
//
// The source hooks.json uses shell-expanded `$CLAUDE_PLUGIN_ROOT` path segments
// so bash preserves spaces in Windows profile paths.
const runCjsHookPrefix = process.platform === 'win32'
  ? 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs '
  : 'sh "$CLAUDE_PLUGIN_ROOT"/scripts/find-node.sh "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ';
//
// Three patterns are handled:
//  1. Bare run.cjs format – node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ...
//  2. Absolute run.cjs format from older setup patches
//  3. Old find-node.sh format – sh "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" ...
//
// Fixes issues #909, #899, #892, #869.
try {
  const hooksJsonPath = join(__dirname, '..', 'hooks', 'hooks.json');
  if (existsSync(hooksJsonPath)) {
    const data = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    let patched = false;

    // Pattern 3 (old, Windows backward-compat): sh find-node.sh <target> [args]
    const findNodePattern =
      /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/find-node\.sh" "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([^"]+)"(.*)$/;
    const currentFindNodePattern =
      /^(?:"\/bin\/sh"|sh) "\$CLAUDE_PLUGIN_ROOT"\/scripts\/find-node\.sh "\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs "\$CLAUDE_PLUGIN_ROOT"\/scripts\/([^\s]+)(.*)$/;

    for (const groups of Object.values(data.hooks ?? {})) {
      for (const group of groups) {
        for (const hook of (group.hooks ?? [])) {
          if (typeof hook.command !== 'string') continue;

          // Bare run.cjs format depends on node being on PATH; route through
          // find-node.sh instead while preserving the run.cjs Windows-safe
          // process.execPath handoff once Node is found.
          if (hook.command.startsWith('node ') && hook.command.includes('/scripts/run.cjs')) {
            hook.command = hook.command.replace(
              /^node\s+"\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs\s+/,
              runCjsHookPrefix,
            );
            patched = true;
            continue;
          }

          // Self-healing: if hooks.json already contains an absolute node path
          // from a previous patch (possibly on a different machine, e.g. the
          // GitHub Actions runner at publish time — see issue #2348), rewrite it
          // to the portable find-node bootstrap. Without this users who install
          // a tarball accidentally published with a stale absolute path (e.g.
          // /opt/hostedtoolcache/node/.../bin/node) can never self-heal.
          const absNodeMatch = hook.command.match(
            /^"([^"]*\/node|[A-Za-z]:\\[^"]*\\node(?:\.exe)?)"\s+.*\/scripts\/run\.cjs/,
          );
          if (absNodeMatch) {
            hook.command = hook.command.replace(
              /^"[^"]*"\s+"\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs\s+/,
              runCjsHookPrefix,
            );
            patched = true;
            continue;
          }

          // Current/old find-node.sh formats — normalize to the platform prefix.
          const m2 = hook.command.match(currentFindNodePattern) ?? hook.command.match(findNodePattern);
          if (m2) {
            hook.command = `${runCjsHookPrefix}"$CLAUDE_PLUGIN_ROOT"/scripts/${m2[1]}${m2[2]}`;
            patched = true;
          }
        }
      }
    }

    if (patched) {
      writeFileSync(hooksJsonPath, JSON.stringify(data, null, 2) + '\n');
      console.log('[OMC] Patched hooks.json to use portable find-node hook commands');
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
