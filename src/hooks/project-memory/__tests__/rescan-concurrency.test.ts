/**
 * Regression tests: a stale rescan must not overwrite concurrent locked writes.
 *
 * registerProjectMemoryContext and rescanProjectEnvironment both rescan project
 * memory. Detection is slow, so a locked writer (addCustomNote,
 * learnFromToolOutput) can persist user data between the rescan's initial read
 * and its save. These tests gate the detector to reproduce that window
 * deterministically and assert the concurrent user data survives the rescan.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { contextCollector } from "../../../features/context-injector/collector.js";
import { loadProjectMemory, saveProjectMemory } from "../storage.js";
import { addCustomNote } from "../learner.js";
import { CACHE_EXPIRY_MS } from "../constants.js";
import type { ProjectMemory } from "../types.js";

// Controllable detector stub. Detection blocks until the test releases it,
// reproducing the window between the rescan's initial read and its save.
const detectorGate = vi.hoisted(() => {
  const state: {
    detected: ProjectMemory | null;
    entered: (() => void) | null;
    release: (() => void) | null;
  } = { detected: null, entered: null, release: null };
  return state;
});

vi.mock("../detector.js", () => ({
  detectProjectEnvironment: vi.fn(async () => {
    detectorGate.entered?.();
    await new Promise<void>((resolve) => {
      detectorGate.release = resolve;
    });
    return detectorGate.detected;
  }),
}));

const {
  registerProjectMemoryContext,
  clearProjectMemorySession,
  rescanProjectEnvironment,
} = await import("../index.js");

function makeMemory(projectRoot: string, overrides: Partial<ProjectMemory> = {}): ProjectMemory {
  return {
    version: "1.0.0",
    lastScanned: Date.now(),
    projectRoot,
    techStack: {
      languages: [
        { name: "TypeScript", version: null, confidence: "high", markers: ["tsconfig.json"] },
      ],
      frameworks: [],
      packageManager: "npm",
      runtime: null,
    },
    build: {
      buildCommand: "npm run build",
      testCommand: "npm test",
      lintCommand: "npm run lint",
      devCommand: null,
      scripts: { build: "tsc", test: "vitest" },
    },
    conventions: { namingStyle: null, importStyle: null, testPattern: null, fileOrganization: null },
    structure: { isMonorepo: false, workspaces: [], mainDirectories: [], gitBranches: null },
    customNotes: [],
    directoryMap: {},
    hotPaths: [],
    userDirectives: [],
    ...overrides,
  };
}

describe("Project Memory rescan concurrency", () => {
  let tempDir: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(async () => {
    delete process.env.OMC_STATE_DIR;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rescan-concurrency-"));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;

    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "rescan-race-app", scripts: { build: "tsc", test: "vitest" } }, null, 2),
    );
    await fs.writeFile(path.join(tempDir, "tsconfig.json"), "{}");

    detectorGate.detected = null;
    detectorGate.entered = null;
    detectorGate.release = null;
  });

  afterEach(async () => {
    delete process.env.OMC_STATE_DIR;
    contextCollector.clear("rescan-race-1");
    contextCollector.clear("rescan-race-2");
    clearProjectMemorySession("rescan-race-1");
    clearProjectMemorySession("rescan-race-2");
    await fs.rm(tempDir, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  });

  it("registerProjectMemoryContext keeps a note written while a stale rescan is detecting", async () => {
    const sessionId = "rescan-race-1";
    const noteContent = "note written while the stale rescan is detecting";

    // Seed a memory old enough to trigger a rescan.
    await saveProjectMemory(
      tempDir,
      makeMemory(tempDir, { lastScanned: Date.now() - CACHE_EXPIRY_MS - 60_000 }),
    );

    const detectionEntered = new Promise<void>((resolve) => {
      detectorGate.entered = resolve;
    });
    detectorGate.detected = makeMemory(tempDir, {
      build: {
        buildCommand: "pnpm build:detected",
        testCommand: "pnpm test:detected",
        lintCommand: null,
        devCommand: null,
        scripts: { build: "detected" },
      },
    });

    const registered = registerProjectMemoryContext(sessionId, tempDir);
    await detectionEntered;

    // While detection is pending, a locked writer persists a user note.
    await addCustomNote(tempDir, "test", noteContent);
    const midFlight = await loadProjectMemory(tempDir);
    expect(
      midFlight?.customNotes.some((note) => note.content === noteContent),
    ).toBe(true);

    detectorGate.release?.();
    await registered;

    const final = await loadProjectMemory(tempDir);
    // The rescan really happened: detected schema fields were applied.
    expect(final?.build.buildCommand).toBe("pnpm build:detected");
    // The concurrent note must survive the rescan save.
    expect(final?.customNotes.some((note) => note.content === noteContent)).toBe(true);
  });

  it("rescanProjectEnvironment keeps a note written while the rescan is detecting", async () => {
    const noteContent = "note written while the manual rescan is detecting";

    await saveProjectMemory(
      tempDir,
      makeMemory(tempDir, { lastScanned: Date.now() - CACHE_EXPIRY_MS - 60_000 }),
    );

    const detectionEntered = new Promise<void>((resolve) => {
      detectorGate.entered = resolve;
    });
    detectorGate.detected = makeMemory(tempDir, {
      techStack: {
        languages: [],
        frameworks: [],
        packageManager: "pnpm",
        runtime: null,
      },
    });

    const rescan = rescanProjectEnvironment(tempDir);
    await detectionEntered;

    await addCustomNote(tempDir, "test", noteContent);
    const midFlight = await loadProjectMemory(tempDir);
    expect(
      midFlight?.customNotes.some((note) => note.content === noteContent),
    ).toBe(true);

    detectorGate.release?.();
    await rescan;

    const final = await loadProjectMemory(tempDir);
    // The rescan really happened: detected schema fields were applied.
    expect(final?.techStack.packageManager).toBe("pnpm");
    expect(final?.customNotes.some((note) => note.content === noteContent)).toBe(true);
  });

  it("keeps a user directive written while a stale rescan is detecting", async () => {
    const sessionId = "rescan-race-2";
    const directiveText = "always use pnpm to run tests";

    await saveProjectMemory(
      tempDir,
      makeMemory(tempDir, { lastScanned: Date.now() - CACHE_EXPIRY_MS - 60_000 }),
    );

    const detectionEntered = new Promise<void>((resolve) => {
      detectorGate.entered = resolve;
    });
    detectorGate.detected = makeMemory(tempDir);

    const registered = registerProjectMemoryContext(sessionId, tempDir);
    await detectionEntered;

    // learnFromToolOutput is the other locked writer; it records user
    // directives from the user message.
    await import("../learner.js").then((learner) =>
      learner.learnFromToolOutput("Read", { file_path: path.join(tempDir, "package.json") }, "", tempDir, directiveText),
    );
    const midFlight = await loadProjectMemory(tempDir);
    expect(
      midFlight?.userDirectives.some((directive) => directive.context === directiveText),
    ).toBe(true);

    detectorGate.release?.();
    await registered;

    const final = await loadProjectMemory(tempDir);
    expect(
      final?.userDirectives.some((directive) => directive.context === directiveText),
    ).toBe(true);
  });
});
