/**
 * Integration coverage for project-memory PreCompact loading.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { processPreCompact, type PreCompactInput } from "../pre-compact.js";
import { SCHEMA_VERSION } from "../constants.js";
import type { ProjectMemory } from "../types.js";

const tempDirs: string[] = [];

const createMinimalPersistedMemory = (
  projectRoot: string,
): Omit<ProjectMemory, "customNotes" | "hotPaths" | "userDirectives"> => ({
  version: SCHEMA_VERSION,
  lastScanned: Date.now(),
  projectRoot,
  techStack: {
    languages: [
      {
        name: "TypeScript",
        version: null,
        confidence: "high",
        markers: ["tsconfig.json"],
      },
    ],
    frameworks: [],
    packageManager: "npm",
    runtime: null,
  },
  build: {
    buildCommand: "npm run build",
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
  directoryMap: {},
});

describe("Project Memory PreCompact storage integration", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("loads minimal persisted memory and formats compaction context without list fields", async () => {
    delete process.env.OMC_STATE_DIR;
    const projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "project-memory-precompact-"),
    );
    tempDirs.push(projectRoot);
    await fs.writeFile(path.join(projectRoot, "package.json"), "{}\n");
    await fs.mkdir(path.join(projectRoot, ".omc"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, ".omc", "project-memory.json"),
      JSON.stringify(createMinimalPersistedMemory(projectRoot)),
      "utf-8",
    );

    const input: PreCompactInput = {
      session_id: "test-session",
      transcript_path: "/tmp/transcript",
      cwd: projectRoot,
      permission_mode: "default",
      hook_event_name: "PreCompact",
      trigger: "auto",
    };

    const result = await processPreCompact(input);

    expect(result.continue).toBe(true);
    expect(result.systemMessage).toContain("Project Memory");
    expect(result.systemMessage).toContain("[Project Environment]");
    expect(result.systemMessage).not.toContain("[Directives]");
    expect(result.systemMessage).not.toContain("[Recent Learnings]");
  });
});
