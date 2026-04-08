#!/usr/bin/env node
/**
 * Plugin Post-Install Setup
 *
 * Configures HUD statusline when plugin is installed.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, copyFileSync, realpathSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getClaudeConfigDir } from './lib/config-dir.mjs';

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
const hudScript = `#!/usr/bin/env node
/**
 * OMC HUD - Statusline Script
 * Wrapper that imports from plugin cache or development paths
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { getClaudeConfigDir } = await import(pathToFileURL(join(__dirname, "lib", "config-dir.mjs")).href);

// Semantic version comparison: returns negative if a < b, positive if a > b, 0 if equal
function semverCompare(a, b) {
  // Use parseInt to handle pre-release suffixes (e.g. "0-beta" -> 0)
  const pa = a.replace(/^v/, "").split(".").map(s => parseInt(s, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  // If numeric parts equal, non-pre-release > pre-release
  const aHasPre = /-/.test(a);
  const bHasPre = /-/.test(b);
  if (aHasPre && !bHasPre) return -1;
  if (!aHasPre && bHasPre) return 1;
  return 0;
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean).map(candidate => resolve(candidate)))];
}

function getGlobalNodeModuleRoots() {
  const roots = [];
  const addPrefixRoots = (prefix) => {
    if (!prefix) return;
    if (process.platform === 'win32') {
      roots.push(join(prefix, 'node_modules'));
      return;
    }
    roots.push(join(prefix, 'lib', 'node_modules'));
    roots.push(join(prefix, 'node_modules'));
  };

  addPrefixRoots(process.env.npm_config_prefix);
  addPrefixRoots(process.env.PREFIX);

  const nodeBinDir = dirname(process.execPath);
  roots.push(join(nodeBinDir, 'node_modules'));
  roots.push(join(nodeBinDir, '..', 'node_modules'));
  roots.push(join(nodeBinDir, '..', 'lib', 'node_modules'));

  if (process.platform === 'win32' && process.env.APPDATA) {
    roots.push(join(process.env.APPDATA, 'npm', 'node_modules'));
  }

  try {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const npmRoot = String(execFileSync(npmCommand, ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    })).trim();
    if (npmRoot) roots.unshift(npmRoot);
  } catch { /* continue */ }

  return uniquePaths(roots);
}

async function importHudPackage(hudPackage) {
  try {
    const wrapperRequire = createRequire(import.meta.url);
    const resolvedHudPath = wrapperRequire.resolve(hudPackage);
    await import(pathToFileURL(resolvedHudPath).href);
    return true;
  } catch { /* continue */ }

  try {
    const cwdRequire = createRequire(join(process.cwd(), '__omc_hud__.cjs'));
    const resolvedHudPath = cwdRequire.resolve(hudPackage);
    await import(pathToFileURL(resolvedHudPath).href);
    return true;
  } catch { /* continue */ }

  for (const nodeModulesRoot of getGlobalNodeModuleRoots()) {
    const resolvedHudPath = join(nodeModulesRoot, hudPackage);
    if (!existsSync(resolvedHudPath)) continue;
    try {
      await import(pathToFileURL(resolvedHudPath).href);
      return true;
    } catch { /* continue */ }
  }

  return false;
}

async function main() {
  const home = homedir();
  let pluginCacheDir = null;

  // 1. Try plugin cache first (marketplace: omc, plugin: oh-my-claudecode)
  // Respect CLAUDE_CONFIG_DIR so installs under a custom config dir are found
  const configDir = getClaudeConfigDir();
  const pluginCacheBase = join(configDir, "plugins", "cache", "omc", "oh-my-claudecode");
  if (existsSync(pluginCacheBase)) {
    try {
      const versions = readdirSync(pluginCacheBase);
      if (versions.length > 0) {
        const sortedVersions = versions.sort(semverCompare).reverse();
        pluginCacheDir = join(pluginCacheBase, sortedVersions[0]);

        // Filter to only versions with built dist/hud/index.js
        const builtVersions = sortedVersions.filter(v => {
          const hudPath = join(pluginCacheBase, v, "dist/hud/index.js");
          return existsSync(hudPath);
        });
        if (builtVersions.length > 0) {
          const latestBuilt = builtVersions[0];
          pluginCacheDir = join(pluginCacheBase, latestBuilt);
          const pluginPath = join(pluginCacheBase, latestBuilt, "dist/hud/index.js");
          await import(pathToFileURL(pluginPath).href);
          return;
        }
      }
    } catch { /* continue */ }
  }

  // 2. Development paths
  const devPaths = [
    join(home, "Workspace/oh-my-claudecode/dist/hud/index.js"),
    join(home, "workspace/oh-my-claudecode/dist/hud/index.js"),
  ];

  for (const devPath of devPaths) {
    if (existsSync(devPath)) {
      try {
        await import(pathToFileURL(devPath).href);
        return;
      } catch { /* continue */ }
    }
  }

  // 3. Marketplace clone (for marketplace installs without a populated cache)
  const marketplaceHudPath = join(configDir, "plugins", "marketplaces", "omc", "dist/hud/index.js");
  if (existsSync(marketplaceHudPath)) {
    try {
      await import(pathToFileURL(marketplaceHudPath).href);
      return;
    } catch { /* continue */ }
  }

  // 4. npm package (current project, global install, or branded fallback)
  const npmHudPackages = [
    "oh-my-claude-sisyphus/dist/hud/index.js",
    "oh-my-claudecode/dist/hud/index.js",
  ];
  for (const hudPackage of npmHudPackages) {
    if (await importHudPackage(hudPackage)) {
      return;
    }
  }

  // 5. Fallback: provide targeted repair guidance
  if (pluginCacheDir && existsSync(pluginCacheDir)) {
    const distDir = join(pluginCacheDir, "dist");
    if (!existsSync(distDir)) {
      console.log(\`[OMC HUD] Plugin installed but not built. Run: cd "\${pluginCacheDir}" && npm install && npm run build\`);
    } else {
      console.log(\`[OMC HUD] Plugin HUD load failed. Run: cd "\${pluginCacheDir}" && npm install && npm run build\`);
    }
  } else if (existsSync(pluginCacheBase)) {
    console.log("[OMC HUD] Plugin cache found but no versions installed. Run: /oh-my-claudecode:omc-setup");
  } else {
    console.log("[OMC HUD] Plugin not installed. Run: /oh-my-claudecode:omc-setup");
  }
}

main();
`;

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
// IMPORTANT: We must NEVER write to the package source `<packageRoot>/hooks/hooks.json`.
// Doing so causes the CI runner's absolute node path (e.g.
// `/opt/hostedtoolcache/node/20.20.2/x64/bin/node`) to be baked into the source
// during test runs and shipped to every user via `npm publish`. See #2348.
//
// Patching targets are limited to installed plugin cache copies under
// ~/.claude/plugins/cache/omc/oh-my-claudecode/<version>/hooks/hooks.json. The
// source file in the package directory is left untouched.
//
// Two patterns are handled:
//  1. New format  – node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ... (all platforms)
//  2. Old format  – sh  "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" ... (Windows
//     backward-compat: migrates old installs to the new run.cjs chain)
//
// Self-heal: also rewrites any pre-existing absolute node path that does not
// exist on disk (e.g. CI runner paths shipped via 4.11.1) back to the local
// process.execPath. See issue #2348.
//
// Fixes issues #909, #899, #892, #869, #2348.
function patchHookCommandsInPlace(data, nodeBinForRewrite) {
  let patched = false;
  const findNodePattern =
    /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/find-node\.sh" "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([^"]+)"(.*)$/;
  // Matches a quoted absolute node path leading a run.cjs invocation
  // e.g. "/opt/hostedtoolcache/node/20.20.2/x64/bin/node" "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ...
  const absoluteNodePattern = /^"([^"]+)"\s+("?\$(?:\{)?CLAUDE_PLUGIN_ROOT.*scripts\/run\.cjs\b.*)$/;

  for (const groups of Object.values(data.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of (group.hooks ?? [])) {
        if (typeof hook.command !== 'string') continue;

        // New run.cjs format — replace bare `node` with absolute path (all platforms)
        if (hook.command.startsWith('node ') && hook.command.includes('/scripts/run.cjs')) {
          hook.command = hook.command.replace(/^node\b/, `"${nodeBinForRewrite}"`);
          patched = true;
          continue;
        }

        // Self-heal: existing absolute node path that does not point at a real binary
        // (the CI runner path baked in by #2348, or a stale dev path) — rewrite to
        // the local process.execPath. We never touch a path that does exist on disk.
        const absMatch = hook.command.match(absoluteNodePattern);
        if (absMatch) {
          const existingNode = absMatch[1];
          const tail = absMatch[2];
          if (existingNode !== nodeBinForRewrite && !existsSync(existingNode)) {
            hook.command = `"${nodeBinForRewrite}" ${tail}`;
            patched = true;
            continue;
          }
        }

        // Old find-node.sh format — migrate to run.cjs + absolute path (Windows only)
        if (process.platform === 'win32') {
          const m2 = hook.command.match(findNodePattern);
          if (m2) {
            hook.command = `"${nodeBinForRewrite}" "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/${m2[1]}${m2[2]}`;
            patched = true;
          }
        }
      }
    }
  }

  return patched;
}

function getOmcPluginCacheRoots() {
  const roots = [];
  try {
    const cacheBase = join(CLAUDE_DIR, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    if (!existsSync(cacheBase)) return roots;
    for (const entry of readdirSync(cacheBase, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const root = join(cacheBase, entry.name);
      const hooksPath = join(root, 'hooks', 'hooks.json');
      if (existsSync(hooksPath)) {
        roots.push(root);
      }
    }
  } catch {
    // Best-effort discovery
  }
  return roots;
}

const PACKAGE_ROOT_ABS = resolve(join(__dirname, '..'));

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const PACKAGE_ROOT_REAL = safeRealpath(PACKAGE_ROOT_ABS);

function isInsidePackageSource(targetPath) {
  // Resolve to canonical absolute path AND follow symlinks on both sides so
  // a `~/.claude/plugins/cache/.../oh-my-claudecode/<v>` symlink that points
  // back into the dev repo cannot bypass the source-mutation guard. The pure
  // string-based `resolve()` form is symlink-blind and would let the write
  // through. See #2348 architect review.
  try {
    const sep = process.platform === 'win32' ? '\\' : '/';
    // Resolve the target's directory via realpath (the file itself may not
    // exist yet). Then re-attach the basename so we compare on the same path
    // shape as PACKAGE_ROOT_REAL.
    const targetAbs = resolve(targetPath);
    const parent = safeRealpath(join(targetAbs, '..'));
    const targetReal = join(parent, basename(targetAbs));

    for (const root of [PACKAGE_ROOT_ABS, PACKAGE_ROOT_REAL]) {
      const rootWithSep = root.endsWith(sep) ? root : root + sep;
      if (targetReal === root || targetReal.startsWith(rootWithSep)) {
        return true;
      }
      if (targetAbs === root || targetAbs.startsWith(rootWithSep)) {
        return true;
      }
    }
    return false;
  } catch {
    // On any error, fail closed: refuse to write rather than risk corrupting
    // the source.
    return true;
  }
}

try {
  // Discover every installed plugin cache copy and patch it. Never touch the
  // package source — see #2348 for the regression we are guarding against.
  const targets = [];
  for (const pluginRoot of getOmcPluginCacheRoots()) {
    const candidate = join(pluginRoot, 'hooks', 'hooks.json');
    if (isInsidePackageSource(candidate)) {
      // Defensive: refuse to patch any path that resolves into the package source.
      continue;
    }
    targets.push(candidate);
  }

  for (const hooksJsonPath of targets) {
    try {
      const data = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
      const patched = patchHookCommandsInPlace(data, nodeBin);
      if (patched) {
        writeFileSync(hooksJsonPath, JSON.stringify(data, null, 2) + '\n');
        console.log(`[OMC] Patched plugin cache hooks.json (${hooksJsonPath}) with absolute node path (${nodeBin})`);
      }
    } catch (e) {
      console.log(`[OMC] Warning: Could not patch ${hooksJsonPath}: ${e.message}`);
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
