import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLUGIN_JSON_PATH,
  listSourceControlledPackageFiles,
  readMcpServersFromPath,
  readPluginMcpServers,
  referencesRootMcpConfig,
  referencesStandardHooksManifest,
  type McpServerConfig,
  type PluginJson,
} from "./npm-package-surface-helpers.js";
// @ts-expect-error The shipping transaction is an ESM maintainer script without declarations.
import { collectPluginRuntimeClosure } from "../../scripts/plugin-shipping-surface.mjs";

const PACKAGE_ROOT = process.cwd();
const PACKAGE_JSON_PATH = join(PACKAGE_ROOT, "package.json");

type PackageJson = {
  bin?: Record<string, string>;
  name?: string;
  version?: string;
};

type PackedPackage = {
  extractedPackageRoot: string;
  files: Set<string>;
  packageJson: PackageJson;
  pluginJson: PluginJson;
  mcpServers: Record<string, McpServerConfig>;
  startedWithoutGeneratedBundles: boolean;
};

type PluginShippingSurface = {
  requiredPaths: string[];
};

const CLI_BIN_TARGET = "bin/oh-my-claudecode.js";
const SUPPORTED_CLI_ALIASES = ["oh-my-claudecode", "omc"] as const;
const GENERATED_BRIDGE_FILES = new Set([
  "bridge/claude-md-coordinator.cjs",
  "bridge/cli.cjs",
  "bridge/mcp-server.cjs",
  "bridge/runtime-cli.cjs",
  "bridge/team-bridge.cjs",
  "bridge/team-mcp.cjs",
  "bridge/team.js",
]);

let packedPackageCache: PackedPackage | null = null;
let packedPackageError: unknown = null;
let packedPackageInitialized = false;
let fixtureRootCache: string | null = null;
let packDirCache: string | null = null;
let packWorkspaceCache: string | null = null;
let committedSnapshotCache: string | null = null;
let tarballPathCache: string | null = null;

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as PackageJson;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createIsolatedPackWorkspace(
  workspacePath: string,
  snapshotPath: string,
): void {
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(snapshotPath, { recursive: true });
  execFileSync(
    "git",
    ["checkout-index", "--all", `--prefix=${snapshotPath}/`],
    {
      cwd: PACKAGE_ROOT,
      stdio: "pipe",
    },
  );
  cpSync(snapshotPath, workspacePath, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  rmSync(join(workspacePath, "dist"), { recursive: true, force: true });
  for (const relativePath of GENERATED_BRIDGE_FILES) {
    rmSync(join(workspacePath, relativePath), { force: true });
  }
  symlinkSync(
    join(PACKAGE_ROOT, "node_modules"),
    join(workspacePath, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

function getPackedPackage(): PackedPackage {
  if (packedPackageInitialized) {
    if (packedPackageError !== null) {
      throw packedPackageError;
    }
    if (!packedPackageCache) {
      throw new Error("npm pack fixture initialized without a result");
    }
    return packedPackageCache;
  }
  packedPackageInitialized = true;

  try {
    const packageJson = readPackageJson();
    if (!packageJson.name || !packageJson.version) {
      throw new Error("package.json must define a name and version");
    }
    fixtureRootCache = mkdtempSync(join(tmpdir(), "omc-pack-fixture-"));
    packWorkspaceCache = join(fixtureRootCache, "workspace");
    committedSnapshotCache = join(fixtureRootCache, "committed");
    packDirCache = join(fixtureRootCache, "packed");
    createIsolatedPackWorkspace(packWorkspaceCache, committedSnapshotCache);
    const startedWithoutGeneratedBundles = [...GENERATED_BRIDGE_FILES].every(
      (file) => !existsSync(join(packWorkspaceCache!, file)),
    );
    mkdirSync(packDirCache, { recursive: true });

    const stdout = execFileSync(
      "npm",
      ["pack", "--pack-destination", packDirCache, "--silent"],
      {
        cwd: packWorkspaceCache,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    const expectedTarballName = `${packageJson.name.replace(/^@/, "").replace(/\//g, "-")}-${packageJson.version}.tgz`;
    expect([
      expectedTarballName,
      `${expectedTarballName}\n`,
      `${expectedTarballName}\r\n`,
    ]).toContain(stdout);

    const tarballName = stdout.replace(/\r?\n$/, "");
    expect(tarballName).toBe(expectedTarballName);
    expect(basename(tarballName)).toBe(tarballName);
    expect(tarballName).not.toMatch(/[\\/]/);

    tarballPathCache = join(packDirCache, tarballName);
    const files = execFileSync("tar", ["-tzf", tarballPathCache], {
      encoding: "utf-8",
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((file) => file.replace(/^package\//, ""));

    execFileSync("tar", ["-xzf", tarballPathCache, "-C", packDirCache]);

    const extractedPackageRoot = join(packDirCache, "package");
    packedPackageCache = {
      extractedPackageRoot,
      files: new Set(files),
      packageJson: JSON.parse(
        readFileSync(join(extractedPackageRoot, "package.json"), "utf-8"),
      ) as PackageJson,
      pluginJson: JSON.parse(
        readFileSync(
          join(extractedPackageRoot, ".claude-plugin", "plugin.json"),
          "utf-8",
        ),
      ) as PluginJson,
      mcpServers: readMcpServersFromPath(
        join(extractedPackageRoot, ".mcp.json"),
      ),
      startedWithoutGeneratedBundles,
    };
    return packedPackageCache;
  } catch (error) {
    packedPackageError = error;
    throw error;
  }
}

afterAll(() => {
  if (fixtureRootCache) {
    rmSync(fixtureRootCache, { recursive: true, force: true });
  }
});

// Build the single lifecycle tarball during file setup so individual assertions
// retain the repository-wide 30-second test budget. Any setup failure still
// aborts this file and is cached to prevent a second pack attempt.
const packedPackageFixture = getPackedPackage();

function expectedNpmShimNames(binName: string): string[] {
  return [binName, `${binName}.cmd`, `${binName}.ps1`];
}

describe("npm package bin surface regression", () => {
  it("publishes both long and short OMC command aliases to the same CLI entrypoint", () => {
    const packageJson = readPackageJson();

    for (const alias of SUPPORTED_CLI_ALIASES) {
      expect(packageJson.bin?.[alias]).toBe(CLI_BIN_TARGET);
    }
  });

  it("packs the CLI bin target and generated runtime entrypoints", () => {
    const packedFiles = packedPackageFixture.files;

    expect(packedFiles.has(CLI_BIN_TARGET)).toBe(true);
    expect(packedFiles.has("dist/hooks/skill-bridge.cjs")).toBe(true);
    expect(packedFiles.has("bridge/cli.cjs")).toBe(true);
    expect(packedFiles.has("bridge/claude-md-coordinator.cjs")).toBe(true);
    expect(packedFiles.has("bridge/mcp-server.cjs")).toBe(true);
    expect(packedFiles.has("bridge/runtime-cli.cjs")).toBe(true);
    expect(packedFiles.has("bridge/team-bridge.cjs")).toBe(true);
    expect(packedFiles.has("bridge/team-mcp.cjs")).toBe(true);
    expect(packedFiles.has("bridge/team.js")).toBe(true);
    expect(packedFiles.has("bridge/gyoshu_bridge.py")).toBe(true);
    expect(packedFiles.has("bridge/run-mcp-server.sh")).toBe(true);
  });

  it("keeps the committed plugin runtime closure as a byte-identical npm package subset", () => {
    const surface = collectPluginRuntimeClosure(
      committedSnapshotCache!,
    ) as PluginShippingSurface;
    const extractedPackageRoot = join(packDirCache!, "package");

    for (const relativePath of surface.requiredPaths) {
      expect(packedPackageFixture.files.has(relativePath), relativePath).toBe(
        true,
      );
      expect(
        sha256(join(extractedPackageRoot, relativePath)),
        relativePath,
      ).toBe(sha256(join(committedSnapshotCache!, relativePath)));
    }
  });

  it("rebuilds recovery CLI surfaces from source without committed bundles", () => {
    expect(packedPackageFixture.startedWithoutGeneratedBundles).toBe(true);

    const packedCli = join(packDirCache!, "package", "bridge", "cli.cjs");
    const apiHelp = execFileSync(
      process.execPath,
      [packedCli, "team", "api", "--help"],
      { cwd: tmpdir(), encoding: "utf-8" },
    );

    expect(apiHelp).toContain("recover-worker");
    expect(apiHelp).toContain("write-task-checkpoint");
    expect(apiHelp).toContain("read-recovery-result");

    const resultHelp = execFileSync(
      process.execPath,
      [packedCli, "team", "api", "read-recovery-result", "--help"],
      { cwd: tmpdir(), encoding: "utf-8" },
    );
    expect(resultHelp).toContain("team_name");
    expect(resultHelp).toContain("request_id");
  });

  it("packs the fixed worktree-paths dist with hidden Windows git subprocesses", () => {
    const source = readFileSync(
      join(PACKAGE_ROOT, "src", "lib", "worktree-paths.ts"),
      "utf-8",
    );
    const packedDist = readFileSync(
      join(
        packedPackageFixture.extractedPackageRoot,
        "dist",
        "lib",
        "worktree-paths.js",
      ),
      "utf-8",
    );

    expect(
      packedPackageFixture.files.has("dist/lib/worktree-paths.js"),
    ).toBe(true);
    expect(source.match(/windowsHide/g)).toHaveLength(7);
    expect(packedDist).not.toContain("execSync(");
    expect(packedDist.match(/windowsHide: true/g)).toHaveLength(7);
  });

  it("packs the complete source-controlled plugin and hook payload", () => {
    const packedFiles = packedPackageFixture.files;
    const missing = listSourceControlledPackageFiles().filter(
      (file) => !packedFiles.has(file),
    );

    expect(missing).toEqual([]);
  });

  it("keeps packed plugin and MCP manifests wired to exact standard entrypoints", () => {
    const sourcePluginJson = JSON.parse(
      readFileSync(PLUGIN_JSON_PATH, "utf-8"),
    ) as PluginJson;

    expect(packedPackageFixture.pluginJson).toEqual(sourcePluginJson);
    expect(
      referencesStandardHooksManifest(packedPackageFixture.pluginJson.hooks),
    ).toBe(false);
    expect(
      referencesRootMcpConfig(packedPackageFixture.pluginJson.mcpServers),
    ).toBe(true);

    expect(packedPackageFixture.mcpServers).toEqual(readPluginMcpServers());
    expect(Object.values(packedPackageFixture.mcpServers)).toEqual([
      {
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs"],
      },
    ]);
  });

  it("executes the shared CLI bin wrapper", () => {
    const stdout = execFileSync(
      process.execPath,
      [CLI_BIN_TARGET, "--version"],
      {
        cwd: PACKAGE_ROOT,
        encoding: "utf-8",
      },
    ).trim();

    expect(stdout).toBe(readPackageJson().version);
  });

  it("models npm shim generation for POSIX and Windows command names without installing globally", () => {
    const packageJson = readPackageJson();
    const binNames = Object.entries(packageJson.bin ?? {})
      .filter(([, target]) => target === CLI_BIN_TARGET)
      .map(([name]) => name)
      .sort();

    expect(binNames).toEqual([...SUPPORTED_CLI_ALIASES].sort());
    expect(
      Object.fromEntries(
        binNames.map((name) => [name, expectedNpmShimNames(name)]),
      ),
    ).toEqual({
      "oh-my-claudecode": [
        "oh-my-claudecode",
        "oh-my-claudecode.cmd",
        "oh-my-claudecode.ps1",
      ],
      omc: ["omc", "omc.cmd", "omc.ps1"],
    });
  });

  it("keeps the packed package metadata aligned with the source bin aliases and installed npm shims", () => {
    const { packageJson: packedPackageJson } = packedPackageFixture;

    for (const alias of SUPPORTED_CLI_ALIASES) {
      expect(packedPackageJson.bin?.[alias]).toBe(CLI_BIN_TARGET);
    }

    const packedBinNames = Object.entries(packedPackageJson.bin ?? {})
      .filter(([, target]) => target === CLI_BIN_TARGET)
      .map(([name]) => name)
      .sort();

    expect(packedBinNames).toEqual([...SUPPORTED_CLI_ALIASES].sort());
    expect(
      Object.fromEntries(
        packedBinNames.map((name) => [name, expectedNpmShimNames(name)]),
      ),
    ).toEqual({
      "oh-my-claudecode": [
        "oh-my-claudecode",
        "oh-my-claudecode.cmd",
        "oh-my-claudecode.ps1",
      ],
      omc: ["omc", "omc.cmd", "omc.ps1"],
    });
  });
});

// Regression guard for #3494: the *built/packed* project-memory learner must never
// harvest arbitrary shell text (e.g. any command containing "npm test" / "npm run build")
// into the durable build.testCommand / build.buildCommand facts. Source was fixed by #3426,
// but dist is gitignored and rebuilt at prepack, so only an assertion over the shipped
// artifact catches source->dist drift that reintroduces the dangerous command harvesting.
describe("packed project-memory learner command-harvest regression (#3494)", () => {
  function projectMemoryDistDir(): string {
    return join(packDirCache!, "package", "dist", "hooks", "project-memory");
  }

  async function importPackedLearner(): Promise<{
    learnFromToolOutput: (
      toolName: string,
      toolInput: unknown,
      toolOutput: unknown,
      projectRoot: string,
      userMessage?: string,
    ) => Promise<void>;
    saveProjectMemory: (projectRoot: string, memory: unknown) => Promise<void>;
    loadProjectMemory: (projectRoot: string) => Promise<any>;
    SCHEMA_VERSION: unknown;
  }> {
    const dir = projectMemoryDistDir();
    const learner = await import(pathToFileURL(join(dir, "learner.js")).href);
    const storage = await import(pathToFileURL(join(dir, "storage.js")).href);
    const constants = await import(
      pathToFileURL(join(dir, "constants.js")).href
    );
    return {
      learnFromToolOutput: learner.learnFromToolOutput,
      saveProjectMemory: storage.saveProjectMemory,
      loadProjectMemory: storage.loadProjectMemory,
      SCHEMA_VERSION: constants.SCHEMA_VERSION,
    };
  }

  function createBaseMemory(
    projectRoot: string,
    schemaVersion: unknown,
  ): Record<string, unknown> {
    return {
      version: schemaVersion,
      lastScanned: Date.now(),
      projectRoot,
      techStack: {
        languages: [],
        frameworks: [],
        packageManager: null,
        runtime: null,
      },
      build: {
        buildCommand: null,
        testCommand: null,
        lintCommand: null,
        devCommand: null,
        scripts: {},
      },
      conventions: {
        namingStyle: null,
        importStyle: null,
        testPattern: null,
        fileOrganization: null,
      },
      structure: {
        isMonorepo: false,
        workspaces: [],
        mainDirectories: [],
        gitBranches: null,
      },
      customNotes: [],
      directoryMap: {},
      hotPaths: [],
      userDirectives: [],
    };
  }

  it("ships a project-memory learner in the packed dist tree", () => {
    getPackedPackage();
    expect(existsSync(join(projectMemoryDistDir(), "learner.js"))).toBe(true);
  });

  it.each([
    ["npm test", "npm test"],
    ["npm run build", "npm run build"],
    [
      "compound pipeline containing npm test",
      "git diff --name-only | xargs npm test",
    ],
  ])(
    "does not harvest shell text into durable build/test commands: %s",
    async (_name, command) => {
      getPackedPackage();
      const {
        learnFromToolOutput,
        saveProjectMemory,
        loadProjectMemory,
        SCHEMA_VERSION,
      } = await importPackedLearner();

      const tempDir = mkdtempSync(join(tmpdir(), "omc-packed-learner-"));
      try {
        await saveProjectMemory(
          tempDir,
          createBaseMemory(tempDir, SCHEMA_VERSION),
        );

        await learnFromToolOutput(
          "Bash",
          { command },
          "Node.js v20.10.0",
          tempDir,
        );

        const updated = await loadProjectMemory(tempDir);
        expect(updated?.build.testCommand).toBeNull();
        expect(updated?.build.buildCommand).toBeNull();
        // Positive control: the learner still works (extracts env hints) so the null
        // assertions above cannot pass vacuously via a no-op learner.
        expect(
          updated?.customNotes.some(
            (note: { content: string }) => note.content === "Node.js v20.10.0",
          ),
        ).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("does not overwrite existing trusted build/test commands from Bash command shape", async () => {
    getPackedPackage();
    const {
      learnFromToolOutput,
      saveProjectMemory,
      loadProjectMemory,
      SCHEMA_VERSION,
    } = await importPackedLearner();

    const tempDir = mkdtempSync(join(tmpdir(), "omc-packed-learner-"));
    try {
      const memory = createBaseMemory(tempDir, SCHEMA_VERSION);
      (memory.build as Record<string, unknown>).buildCommand = "trusted build";
      (memory.build as Record<string, unknown>).testCommand = "trusted test";
      await saveProjectMemory(tempDir, memory);

      await learnFromToolOutput(
        "Bash",
        { command: "npm test" },
        "Node.js v20.10.0",
        tempDir,
      );

      const updated = await loadProjectMemory(tempDir);
      expect(updated?.build.buildCommand).toBe("trusted build");
      expect(updated?.build.testCommand).toBe("trusted test");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
