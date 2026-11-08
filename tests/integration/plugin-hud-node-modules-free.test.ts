import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function getPluginDistEntrypoints(pluginRoot: string): string[] {
  const hookManifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "hooks", "hooks.json"), "utf8"),
  );
  const hookScripts = new Set<string>();
  for (const groups of Object.values(hookManifest.hooks ?? {})) {
    for (const group of groups as Array<{
      hooks?: Array<{ command?: string }>;
    }>) {
      for (const hook of group.hooks ?? []) {
        if (typeof hook.command !== "string") continue;
        for (const match of hook.command.matchAll(
          /scripts\/[A-Za-z0-9_./-]+\.(?:mjs|cjs)/g,
        )) {
          hookScripts.add(match[0]);
        }
      }
    }
  }

  const distEntrypoints = new Set([
    join(pluginRoot, "dist", "hud", "index.js"),
  ]);
  for (const hookScript of hookScripts) {
    const source = readFileSync(join(REPO_ROOT, hookScript), "utf8");
    for (const match of source.matchAll(
      /(['"])(\.\.\/dist\/[^'"]+\.(?:js|mjs|cjs))\1/g,
    )) {
      distEntrypoints.add(resolve(pluginRoot, "scripts", match[2]));
    }
  }
  return [...distEntrypoints];
}

describe("plugin runtime dependencies", () => {
  it("loads plugin HUD and hook dist modules from a cache without node_modules", () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), "omc-plugin-hud-"));
    const configDir = join(pluginRoot, ".claude");

    try {
      writeFileSync(join(pluginRoot, "package.json"), '{"type":"module"}\n');
      cpSync(join(REPO_ROOT, "dist"), join(pluginRoot, "dist"), {
        recursive: true,
      });
      cpSync(join(REPO_ROOT, "scripts"), join(pluginRoot, "scripts"), {
        recursive: true,
      });
      expect(existsSync(join(pluginRoot, "node_modules"))).toBe(false);

      const env = {
        ...process.env,
        HOME: pluginRoot,
        CLAUDE_CONFIG_DIR: configDir,
      };
      delete env.NODE_PATH;
      const result = spawnSync(
        process.execPath,
        [join(pluginRoot, "dist", "hud", "index.js")],
        {
          cwd: pluginRoot,
          env,
          encoding: "utf8",
          input: "{}\n",
          timeout: 10_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");

      const entrypoints = getPluginDistEntrypoints(pluginRoot);
      const importEntrypoints = `
        import { pathToFileURL } from 'node:url';
        for (const path of JSON.parse(process.env.OMC_PLUGIN_DIST_ENTRYPOINTS)) {
          await import(pathToFileURL(path).href);
        }
      `;
      const importResult = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", importEntrypoints],
        {
          cwd: pluginRoot,
          env: {
            ...env,
            OMC_PLUGIN_DIST_ENTRYPOINTS: JSON.stringify(entrypoints),
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );

      expect(importResult.error).toBeUndefined();
      expect(importResult.status, importResult.stderr).toBe(0);
      expect(importResult.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });
});
