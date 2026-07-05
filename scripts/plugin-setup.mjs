#!/usr/bin/env node
/**
 * Plugin Post-Install Setup
 *
 * Configures HUD statusline when plugin is installed.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, copyFileSync, realpathSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { buildHudWrapper } from './lib/hud-wrapper-template.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLAUDE_DIR = getClaudeConfigDir();
const HUD_DIR = join(CLAUDE_DIR, 'hud');
const HUD_LIB_DIR = join(HUD_DIR, 'lib');
const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');
const EPHEMERAL_NODE_PATH_MARKERS = ['hostedtoolcache', '/runner/', '\\runner\\'];

function isKnownEphemeralNodePath(nodePath) {
  return EPHEMERAL_NODE_PATH_MARKERS.some((marker) => nodePath.includes(marker));
}

function pickLatestVersion(versions) {
  return versions
    .filter((version) => /^v?\d/.test(version))
    .sort((a, b) => {
      const left = a.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
      const right = b.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const diff = (right[index] ?? 0) - (left[index] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    })[0];
}

function resolveNodeBinary() {
  try {
    const cmd = process.platform === 'win32' ? 'where node' : 'which node';
    const result = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' })
      .trim()
      .split('\n')[0]
      .trim();
    if (result && existsSync(result)) {
      return result;
    }
  } catch {
    // node is not on PATH; continue through non-interactive shell fallbacks.
  }

  if (process.execPath && existsSync(process.execPath) && !isKnownEphemeralNodePath(process.execPath)) {
    return process.execPath;
  }

  if (process.platform === 'win32') {
    return 'node';
  }

  const home = homedir();
  const nvmBase = join(home, '.nvm', 'versions', 'node');
  if (existsSync(nvmBase)) {
    try {
      const latest = pickLatestVersion(readdirSync(nvmBase));
      if (latest) {
        const nodePath = join(nvmBase, latest, 'bin', 'node');
        if (existsSync(nodePath)) return nodePath;
      }
    } catch {
      // ignore unreadable version directories
    }
  }

  const fnmBases = [
    join(home, '.fnm', 'node-versions'),
    join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
    join(home, '.local', 'share', 'fnm', 'node-versions'),
  ];
  for (const fnmBase of fnmBases) {
    if (!existsSync(fnmBase)) continue;
    try {
      const latest = pickLatestVersion(readdirSync(fnmBase));
      if (latest) {
        const nodePath = join(fnmBase, latest, 'installation', 'bin', 'node');
        if (existsSync(nodePath)) return nodePath;
      }
    } catch {
      // ignore unreadable version directories
    }
  }

  for (const nodePath of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (existsSync(nodePath)) return nodePath;
  }

  return 'node';
}

// Use the resolver shared by the TypeScript installer path: prefer PATH's
// stable node symlink, then fall back to process.execPath and manager paths.
const nodeBin = resolveNodeBinary();

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

function quoteCommandPath(value) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function patchInstalledPluginHookCommands(packageDir) {
  const rawPackageDir = resolve(packageDir);
  const resolvedPackageDir = existsSync(rawPackageDir) ? realpathSync(rawPackageDir) : rawPackageDir;
  if (existsSync(join(resolvedPackageDir, 'src'))) {
    return;
  }

  const hooksJsonPath = join(resolvedPackageDir, 'hooks', 'hooks.json');
  if (!existsSync(hooksJsonPath)) {
    return;
  }

  const parsed = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
  let patched = false;
  for (const groups of Object.values(parsed.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      for (const hook of group.hooks) {
        if (typeof hook?.command !== 'string') continue;
        if (!hook.command.startsWith('node ')) continue;
        hook.command = `${quoteCommandPath(nodeBin)} ${hook.command.slice('node '.length)}`;
        patched = true;
      }
    }
  }

  if (patched) {
    writeFileSync(hooksJsonPath, `${JSON.stringify(parsed, null, 2)}\n`);
    console.log('[OMC] Patched plugin hook commands to current Node executable');
  }
}

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

try {
  patchInstalledPluginHookCommands(join(__dirname, '..'));
} catch (e) {
  console.log('[OMC] Warning: Could not patch plugin hook commands (non-fatal):', e.message);
}

// 4. Ensure runtime dependencies are installed in the plugin cache directory.
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
