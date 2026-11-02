#!/usr/bin/env node
// Canonical path / env-var constants live in src/lib/env-vars.ts and src/lib/paths.ts — keep in sync (see src/__tests__/paths-consistency.test.ts).
/**
 * OMC HUD - Statusline Script
 * Wrapper that imports from OMC_PLUGIN_ROOT, plugin cache, marketplace, or global npm package.
 * Generated from scripts/lib/hud-wrapper-template.txt — do not edit by hand.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { getClaudeConfigDir } = await import(pathToFileURL(join(__dirname, "lib", "config-dir.mjs")).href);

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean).map((candidate) => resolve(candidate)))];
}

function shortHudLoadError(error) {
  const message = typeof error?.message === "string" ? error.message : String(error);
  const compactMessage = message.replace(/\s+/g, " ").trim();
  if (!compactMessage) return "unknown error";
  return compactMessage.length > 100 ? `${compactMessage.slice(0, 97)}...` : compactMessage;
}

function logHudLoadFailure(error, target) {
  if (!error) return;
  const detail = typeof error?.message === "string" ? error.message : String(error);
  const targetDetail = target ? ` from ${target}` : "";
  console.log(`[OMC HUD] HUD import failed${targetDetail}: ${detail}`);
}

function getGlobalNodeModuleRoots() {
  const roots = [];
  const addPrefixRoots = (prefix) => {
    if (!prefix || !isAbsolute(prefix)) return;
    if (process.platform === "win32") {
      roots.push(join(prefix, "node_modules"));
      return;
    }
    roots.push(join(prefix, "lib", "node_modules"));
    roots.push(join(prefix, "node_modules"));
  };

  addPrefixRoots(process.env.PREFIX);

  // The Node install prefix is a global npm prefix for nvm/fnm users whose hook PATH lacks npm.
  if (process.platform !== "win32") {
    roots.push(join(dirname(process.execPath), "..", "lib", "node_modules"));
  }

  if (process.platform === "win32" && process.env.APPDATA && isAbsolute(process.env.APPDATA)) {
    roots.push(join(process.env.APPDATA, "npm", "node_modules"));
  }

  try {
    // npm scripts export project .npmrc values as npm_config_*; keep them out of global-root discovery.
    const npmEnv = { ...process.env };
    for (const key of Object.keys(npmEnv)) {
      if (key.toLowerCase().startsWith("npm_config_")) delete npmEnv[key];
    }

    const isWin = process.platform === "win32";
    const npmCommand = isWin ? "npm.cmd" : "npm";
    const npmRoot = String(execFileSync(npmCommand, ["root", "-g"], {
      encoding: "utf8",
      env: npmEnv,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
      cwd: homedir(),
      // Node 20.12+ rejects direct .cmd/.bat spawns without a shell on Windows.
      // Keep non-Windows behavior unchanged by only enabling shell there.
      shell: isWin,
    })).trim();
    if (isAbsolute(npmRoot)) roots.unshift(npmRoot);
  } catch { /* continue */ }

  return uniquePaths(roots);
}

async function importHudPackage(hudPackage) {
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
  let pluginCacheVersion = null;
  let pluginCacheDir = null;
  let lastHudLoadError = null;
  let lastHudLoadTarget = null;

  // 1. OMC_PLUGIN_ROOT — highest priority (set by `omc --plugin-dir <path>`)
  try {
    const pluginRootEnv = process.env.OMC_PLUGIN_ROOT;
    if (pluginRootEnv && pluginRootEnv.trim().length > 0) {
      const envHudPath = join(pluginRootEnv, "dist/hud/index.js");
      if (existsSync(envHudPath)) {
        try {
          await import(pathToFileURL(envHudPath).href);
          return;
        } catch (error) {
          lastHudLoadError = error;
          lastHudLoadTarget = envHudPath;
        }
      }
    }
  } catch { /* fall through to next resolution step */ }

  // 2. Plugin cache (for production installs)
  // Respect CLAUDE_CONFIG_DIR so installs under a custom config dir are found
  const configDir = getClaudeConfigDir();
  const pluginCacheBase = join(configDir, "plugins", "cache", "omc", "oh-my-claudecode");
  if (existsSync(pluginCacheBase)) {
    try {
      // Filter to strict semver dir names only — guards against accidental
      // siblings like `4.14.1.backup`, `4.14.1.bak`, `_old`, etc. that the
      // semver comparator below would otherwise rank ABOVE the real install
      // (extra dotted segment counted as a higher version).
      const SEMVER_DIR_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
      const versions = readdirSync(pluginCacheBase).filter((name) => SEMVER_DIR_RE.test(name));
      if (versions.length > 0) {
        // Semver-aware descending sort. Stable (no prerelease tag) ranks above any
        // prerelease with the same [major.minor.patch] so `1.0.1` beats `1.0.1-alpha`.
        // Falls back to localeCompare(numeric) when a segment is not numeric.
        const parseSemver = (v) => {
          const [core, pre = ""] = String(v).split("-", 2);
          const parts = core.split(".").map((p) => {
            const n = Number(p);
            return Number.isFinite(n) ? n : p;
          });
          return { parts, pre };
        };
        const compareSemverDesc = (a, b) => {
          const pa = parseSemver(a);
          const pb = parseSemver(b);
          const len = Math.max(pa.parts.length, pb.parts.length);
          for (let i = 0; i < len; i++) {
            const ai = pa.parts[i];
            const bi = pb.parts[i];
            if (ai === bi) continue;
            if (ai === undefined) return 1;
            if (bi === undefined) return -1;
            if (typeof ai === "number" && typeof bi === "number") return bi - ai;
            return String(bi).localeCompare(String(ai), undefined, { numeric: true });
          }
          // Same [M.m.p]: stable (empty pre) wins over any prerelease.
          if (pa.pre === pb.pre) return 0;
          if (pa.pre === "") return -1;
          if (pb.pre === "") return 1;
          // numeric: true so `rc.10` sorts above `rc.2`.
          return pb.pre.localeCompare(pa.pre, undefined, { numeric: true });
        };
        const sortedVersions = [...versions].sort(compareSemverDesc);
        const latestInstalledVersion = sortedVersions[0];
        pluginCacheVersion = latestInstalledVersion;
        pluginCacheDir = join(pluginCacheBase, latestInstalledVersion);

        // Filter to only versions with built dist/hud/index.js
        // This prevents picking an unbuilt new version after plugin update
        const builtVersions = sortedVersions.filter(version => {
          const pluginPath = join(pluginCacheBase, version, "dist/hud/index.js");
          return existsSync(pluginPath);
        });

        if (builtVersions.length > 0) {
          const attemptedTargets = new Set();
          for (const version of builtVersions) {
            pluginCacheVersion = version;
            pluginCacheDir = join(pluginCacheBase, version);
            const pluginPath = join(pluginCacheDir, "dist/hud/index.js");
            let dedupeKey = resolve(pluginPath);
            try {
              dedupeKey = realpathSync(pluginPath);
            } catch { /* continue with resolved path fallback */ }

            if (attemptedTargets.has(dedupeKey)) continue;
            attemptedTargets.add(dedupeKey);

            try {
              await import(pathToFileURL(pluginPath).href);
              return;
            } catch (error) {
              lastHudLoadError = error;
              lastHudLoadTarget = pluginPath;
              // Older HUDs can misreport this installed version as an update.
              console.log(`[OMC HUD] ${version} failed to load: ${shortHudLoadError(error)}`);
              return;
            }
          }
        }
      }
    } catch { /* continue */ }
  }

  // 3. Marketplace clone (for marketplace installs without a populated cache)
  const marketplaceHudPath = join(configDir, "plugins", "marketplaces", "omc", "dist/hud/index.js");
  if (existsSync(marketplaceHudPath)) {
    try {
      await import(pathToFileURL(marketplaceHudPath).href);
      return;
    } catch (error) {
      lastHudLoadError = error;
      lastHudLoadTarget = marketplaceHudPath;
      /* continue */
    }
  }

  // 4. npm package (current project, global install, or branded fallback)
  // Tests can disable this fallback to avoid host-global package nondeterminism.
  if (process.env.OMC_HUD_DISABLE_NPM_FALLBACK !== "1") {
    const npmHudPackages = [
      "oh-my-claude-sisyphus/dist/hud/index.js",
      "oh-my-claudecode/dist/hud/index.js",
    ];
    for (const hudPackage of npmHudPackages) {
      if (await importHudPackage(hudPackage)) {
        logHudLoadFailure(lastHudLoadError, lastHudLoadTarget);
        return;
      }
    }
  }

  // 5. Fallback: provide detailed error message with fix instructions
  logHudLoadFailure(lastHudLoadError, lastHudLoadTarget);

  if (pluginCacheDir && existsSync(pluginCacheDir)) {
    const distDir = join(pluginCacheDir, "dist");
    if (!existsSync(distDir)) {
      console.log(`[OMC HUD] Plugin installed but not built. Run: cd "${pluginCacheDir}" && npm install && npm run build`);
    } else {
      const detail = lastHudLoadError && typeof lastHudLoadError.message === "string"
        ? ` (${lastHudLoadError.message})`
        : "";
      console.log(`[OMC HUD] Plugin HUD load failed${detail}. Run: cd "${pluginCacheDir}" && npm install && npm run build`);
    }
  } else if (existsSync(pluginCacheBase)) {
    console.log(`[OMC HUD] Plugin cache found but no versions installed. Run: /oh-my-claudecode:omc-setup`);
  } else {
    console.log("[OMC HUD] Plugin not installed. Run: /oh-my-claudecode:omc-setup");
  }
}

main();
