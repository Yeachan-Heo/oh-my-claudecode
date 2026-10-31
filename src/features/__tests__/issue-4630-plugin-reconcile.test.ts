import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, relative, sep } from "path";

const instrumentation = vi.hoisted(() => ({
  cpSyncCalls: [] as Array<{
    source: string;
    destination: string;
    bytes: number;
  }>,
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  copyDelayMs: 0,
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execSync: instrumentation.execSync,
    execFileSync: instrumentation.execFileSync,
  };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    cpSync: vi.fn(
      (
        source: string,
        destination: string,
        options?: Parameters<typeof actual.cpSync>[2],
      ) => {
        const sourcePath = String(source);
        let bytes = 0;
        const collectBytes = (path: string): void => {
          const stats = actual.statSync(path);
          if (stats.isFile()) {
            bytes += stats.size;
            return;
          }
          for (const entry of actual.readdirSync(path)) {
            collectBytes(join(path, entry));
          }
        };
        collectBytes(sourcePath);
        instrumentation.cpSyncCalls.push({
          source: sourcePath,
          destination: String(destination),
          bytes,
        });
        if (instrumentation.copyDelayMs > 0) {
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            instrumentation.copyDelayMs,
          );
        }
        return actual.cpSync(source, destination, options);
      },
    ),
  };
});

const originalEnv = { ...process.env };

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("issue #4630 plugin payload reconciliation", () => {
  let tempRoot: string;
  let sourceRoot: string;
  let configDir: string;
  let activeRoot: string;

  beforeEach(() => {
    vi.resetModules();
    instrumentation.cpSyncCalls.length = 0;
    instrumentation.execSync.mockReset();
    instrumentation.execFileSync.mockReset();
    instrumentation.copyDelayMs = 0;
    tempRoot = mkdtempSync(join(tmpdir(), "omc-issue-4630-"));
    sourceRoot = join(tempRoot, "global-node-modules", "oh-my-claude-sisyphus");
    configDir = join(tempRoot, ".claude");
    const sourceVersion = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf-8"),
    ).version as string;
    activeRoot = join(
      configDir,
      "plugins",
      "cache",
      "omc",
      "oh-my-claudecode",
      sourceVersion,
    );
    process.env.CLAUDE_CONFIG_DIR = configDir;
    delete process.env.OMC_UPDATE_RECONCILE;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.OMC_PLUGIN_ROOT;
    delete process.env.OMC_UPDATE_PLUGIN_CACHE_SYNCED;

    mkdirSync(dirname(sourceRoot), { recursive: true });
    symlinkSync(
      process.cwd(),
      sourceRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const oldRoot = join(
      configDir,
      "plugins",
      "cache",
      "omc",
      "oh-my-claudecode",
      "old-version",
    );
    mkdirSync(oldRoot, { recursive: true });
    writeFile(
      join(configDir, "plugins", "installed_plugins.json"),
      JSON.stringify(
        {
          version: 2,
          plugins: {
            "oh-my-claudecode@omc": [
              { installPath: oldRoot, version: "old-version" },
            ],
          },
        },
        null,
        2,
      ),
    );
    instrumentation.execSync.mockImplementation((command: string) => {
      if (command === "npm root -g")
        return `${join(tempRoot, "global-node-modules")}\n`;
      if (command === "npm install -g oh-my-claude-sisyphus@latest") return "";
      if (command.startsWith("which omc ")) return "/usr/bin/omc\n";
      throw new Error(`Unexpected command: ${command}`);
    });
    instrumentation.execFileSync.mockImplementation(
      (command: string, args?: readonly string[]) => {
        if (command === "where.exe" && args?.[0] === "omc.cmd")
          return "C:\\omc.cmd\n";
        return "";
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: `v${sourceVersion}`,
          body: "test release",
        }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    instrumentation.copyDelayMs = 0;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("copies each payload entry once when update reconciliation follows cache sync", async () => {
    instrumentation.copyDelayMs = 2;
    const { performUpdate } = await import("../auto-update.js");
    const startedAt = performance.now();
    const result = await performUpdate({ verbose: false });
    expect(result.success, JSON.stringify(result)).toBe(true);
    const reconcileCall = instrumentation.execFileSync.mock.calls.find(
      ([, args]) =>
        (args as readonly string[] | undefined)?.[0] === "update-reconcile",
    );
    const childEnv = reconcileCall?.[2]?.env as NodeJS.ProcessEnv | undefined;
    expect(childEnv?.OMC_UPDATE_PLUGIN_CACHE_SYNCED).toBe("1");

    process.env.OMC_UPDATE_PLUGIN_CACHE_SYNCED =
      childEnv?.OMC_UPDATE_PLUGIN_CACHE_SYNCED ?? "0";
    const { reconcileUpdateRuntime } = await import("../auto-update.js");
    const reconcileResult = reconcileUpdateRuntime({ verbose: false });
    const elapsedMs = performance.now() - startedAt;
    const payloadCopies = instrumentation.cpSyncCalls.filter(
      ({ source, destination }) =>
        source.startsWith(sourceRoot) &&
        destination.startsWith(activeRoot) &&
        !destination.includes("/skill-bodies/"),
    );
    const cacheCopyCalls = instrumentation.cpSyncCalls.filter(
      ({ destination }) => destination.startsWith(`${activeRoot}${sep}`),
    );
    const payloadEntries = payloadCopies.map(
      ({ source }) => relative(sourceRoot, source).split(sep)[0] ?? "",
    );
    const skillCount = readdirSync(join(sourceRoot, "skills"), {
      withFileTypes: true,
    }).filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(sourceRoot, "skills", entry.name, "SKILL.md")),
    ).length;
    const expectedPayloadEntries = [
      "dist",
      "bridge",
      "hooks",
      "scripts",
      "skills",
      "agents",
      "commands",
      "templates",
      "docs",
      ".claude-plugin",
      ".mcp.json",
      "README.md",
      "LICENSE",
      "package.json",
    ];

    expect(reconcileResult.success).toBe(true);
    expect(payloadEntries.sort()).toEqual(expectedPayloadEntries.sort());
    expect(cacheCopyCalls).toHaveLength(
      expectedPayloadEntries.length + skillCount,
    );
    console.log(
      JSON.stringify({
        cpSyncCalls: instrumentation.cpSyncCalls.length,
        payloadCopyOperations: payloadCopies.length,
        payloadBytes: payloadCopies.reduce(
          (total, call) => total + call.bytes,
          0,
        ),
        cacheCopyOperations: cacheCopyCalls.length,
        cacheBytesCopied: cacheCopyCalls.reduce(
          (total, call) => total + call.bytes,
          0,
        ),
        elapsedMs: Number(elapsedMs.toFixed(1)),
      }),
    );
  });

  it("repairs an unmatched active cache root before reconciliation skips payload sync", async () => {
    const unmatchedRoot = join(
      configDir,
      "plugins",
      "cache",
      "omc",
      "oh-my-claudecode",
      "old-version",
    );
    writeFile(
      join(unmatchedRoot, "bridge", "claude-md-coordinator.cjs"),
      "stale\n",
    );
    writeFile(
      join(configDir, "plugins", "installed_plugins.json"),
      JSON.stringify(
        {
          version: 2,
          plugins: {
            "oh-my-claudecode@omc": [
              { installPath: unmatchedRoot, version: "old-version" },
            ],
            "oh-my-claudecode@oh-my-claudecode": [
              { installPath: unmatchedRoot, version: "old-version" },
            ],
          },
        },
        null,
        2,
      ),
    );

    const { performUpdate, reconcileUpdateRuntime, syncPluginCache } =
      await import("../auto-update.js");
    const cacheSyncResult = syncPluginCache(false);

    expect(cacheSyncResult.synced).toBe(true);
    expect(cacheSyncResult.errors).toEqual([]);
    expect(cacheSyncResult.activeRootsSynced).toBe(false);

    const updateResult = await performUpdate({ verbose: false });
    expect(updateResult.success, JSON.stringify(updateResult)).toBe(true);
    const reconcileCall = instrumentation.execFileSync.mock.calls.find(
      ([, args]) =>
        (args as readonly string[] | undefined)?.[0] === "update-reconcile",
    );
    const childEnv = reconcileCall?.[2]?.env as NodeJS.ProcessEnv | undefined;
    expect(childEnv?.OMC_UPDATE_PLUGIN_CACHE_SYNCED).toBe("0");

    process.env.OMC_UPDATE_PLUGIN_CACHE_SYNCED =
      childEnv?.OMC_UPDATE_PLUGIN_CACHE_SYNCED ?? "1";
    const reconcileResult = reconcileUpdateRuntime({ verbose: false });
    const installer = await import("../../installer/index.js");

    expect(reconcileResult.success).toBe(true);
    expect(
      readFileSync(
        join(unmatchedRoot, "bridge", "claude-md-coordinator.cjs"),
        "utf-8",
      ),
    ).toBe(
      readFileSync(
        join(sourceRoot, "bridge", "claude-md-coordinator.cjs"),
        "utf-8",
      ),
    );
    expect(instrumentation.cpSyncCalls).toContainEqual(
      expect.objectContaining({
        destination: join(unmatchedRoot, "bridge"),
      }),
    );
    expect(installer.validatePluginCachePayload(unmatchedRoot)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("repairs a damaged cache during direct reconciliation when setup skips an older package", async () => {
    writeFile(
      join(activeRoot, "bridge", "claude-md-coordinator.cjs"),
      "stale\n",
    );
    writeFile(
      join(configDir, ".omc-version.json"),
      JSON.stringify({ version: "99.0.0" }),
    );
    writeFile(
      join(configDir, "plugins", "installed_plugins.json"),
      JSON.stringify(
        {
          version: 2,
          plugins: {
            "oh-my-claudecode@omc": [
              {
                installPath: activeRoot,
                version: JSON.parse(
                  readFileSync(join(sourceRoot, "package.json"), "utf-8"),
                ).version,
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const { reconcileUpdateRuntime } = await import("../auto-update.js");
    const result = reconcileUpdateRuntime({ verbose: false });
    const installer = await import("../../installer/index.js");

    expect(result.success).toBe(true);
    expect(
      readFileSync(
        join(activeRoot, "bridge", "claude-md-coordinator.cjs"),
        "utf-8",
      ),
    ).toBe(
      readFileSync(
        join(sourceRoot, "bridge", "claude-md-coordinator.cjs"),
        "utf-8",
      ),
    );
    expect(
      instrumentation.cpSyncCalls.some(
        ({ destination }) => destination === join(activeRoot, "bridge"),
      ),
    ).toBe(true);
    expect(
      existsSync(join(activeRoot, "dist", "hooks", "skill-bridge.cjs")),
    ).toBe(true);
    expect(installer.validatePluginCachePayload(activeRoot)).toEqual({
      valid: true,
      errors: [],
    });
  });
});
