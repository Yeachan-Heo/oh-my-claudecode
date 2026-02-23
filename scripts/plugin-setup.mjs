#!/usr/bin/env node
/**
 * Plugin Post-Install Setup
 *
 * Configures HUD statusline when plugin is installed.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const HUD_DIR = join(CLAUDE_DIR, 'hud');
const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');

console.log('[OMC] Running post-install setup...');

// 1. Create HUD directory
if (!existsSync(HUD_DIR)) {
  mkdirSync(HUD_DIR, { recursive: true });
}

// 2. Create HUD wrapper script
const hudScriptPath = join(HUD_DIR, 'omc-hud.mjs').replace(/\\/g, '/');
const hudScript = `#!/usr/bin/env node
/**
 * OMC HUD - Statusline Script
 * Wrapper that imports from plugin cache or development paths
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

async function main() {
  const home = homedir();

  // 1. Try plugin cache first (marketplace: omc, plugin: oh-my-claudecode)
  // Respect CLAUDE_CONFIG_DIR so installs under a custom config dir are found
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const pluginCacheBase = join(configDir, "plugins", "cache", "omc", "oh-my-claudecode");
  if (existsSync(pluginCacheBase)) {
    try {
      const versions = readdirSync(pluginCacheBase);
      if (versions.length > 0) {
        // Filter to only versions with built dist/hud/index.js
        const builtVersions = versions.filter(v => {
          const hudPath = join(pluginCacheBase, v, "dist/hud/index.js");
          return existsSync(hudPath);
        });
        if (builtVersions.length > 0) {
          const latestBuilt = builtVersions.sort(semverCompare).reverse()[0];
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

  // 3. Fallback
  console.log("[OMC] run /omc-setup to install properly");
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

  // Use the absolute node binary path so nvm/fnm users don't get
  // "node not found" errors in non-interactive shells (issue #892).
  const nodeBin = process.execPath || 'node';
  settings.statusLine = {
    type: 'command',
    command: `${nodeBin} ${hudScriptPath.replace(/\\/g, "/")}`
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

// On Windows (MSYS2 / Git Bash), the sh->find-node.sh->node chain introduced
// in v4.3.4 triggers Claude Code UI bug #17088, which mislabels every
// successful hook as an error.  Patch hooks.json to use direct node invocation
// instead.  find-node.sh is only needed on Unix for nvm/fnm PATH discovery.
if (process.platform === 'win32') {
  try {
    const hooksJsonPath = join(__dirname, '..', 'hooks', 'hooks.json');
    if (existsSync(hooksJsonPath)) {
      const data = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
      // Matches: sh "${CLAUDE_PLUGIN_ROOT}/scripts/find-node.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/X.mjs" [args]
      const pattern =
        /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/find-node\.sh" "(\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[^"]+)"(.*)$/;
      let patched = false;
      for (const groups of Object.values(data.hooks ?? {})) {
        for (const group of groups) {
          for (const hook of (group.hooks ?? [])) {
            if (typeof hook.command === 'string') {
              const m = hook.command.match(pattern);
              if (m) {
                hook.command = `node "${m[1]}"${m[2]}`;
                patched = true;
              }
            }
          }
        }
      }
      if (patched) {
        writeFileSync(hooksJsonPath, JSON.stringify(data, null, 2) + '\n');
        console.log('[OMC] Patched hooks.json for Windows (direct node invocation, fixes issue #899)');
      }
    }
  } catch (e) {
    console.log('[OMC] Warning: Could not patch hooks.json for Windows:', e.message);
  }
}

console.log('[OMC] Setup complete! Restart Claude Code to activate HUD.');
