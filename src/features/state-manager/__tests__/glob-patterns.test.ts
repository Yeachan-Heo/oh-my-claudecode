import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const { TEST_ROOT, TEST_STATE_DIR, TEST_WORKTREE_ROOT, TEST_GLOBAL_STATE_DIR } =
  vi.hoisted(() => {
    const tempDirectory =
      process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const testRoot = `${tempDirectory}/omc-state-manager-glob-${suffix}`;

    return {
      TEST_ROOT: testRoot,
      TEST_STATE_DIR: `${testRoot}/worktree/state`,
      TEST_WORKTREE_ROOT: `${testRoot}/worktree`,
      TEST_GLOBAL_STATE_DIR: `${testRoot}/global-state`,
    };
  });

// Keep the global state dir away from the real ~/.omc so cleanup never touches it.
vi.mock("../../../utils/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/paths.js")>()),
  getGlobalOmcStateRoot: () => TEST_GLOBAL_STATE_DIR,
}));

vi.mock("../../../lib/worktree-paths.js", () => ({
  OmcPaths: {
    STATE: "state",
  },
  getWorktreeRoot: () => TEST_WORKTREE_ROOT,
  validateWorkingDirectory: () => TEST_WORKTREE_ROOT,
  getOmcRoot: (dir?: string) => `${dir ?? TEST_WORKTREE_ROOT}/.omc`,
}));

import { listStates, cleanupOrphanedStates } from "../index.js";
import { StateLocation } from "../types.js";

describe("state-manager glob patterns", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fs.mkdirSync(TEST_STATE_DIR, { recursive: true });
    fs.mkdirSync(TEST_WORKTREE_ROOT, { recursive: true });
    fs.mkdirSync(TEST_GLOBAL_STATE_DIR, { recursive: true });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  function writeState(name: string, ageDays = 0): string {
    const filePath = path.join(TEST_STATE_DIR, `${name}.json`);
    fs.writeFileSync(filePath, "{}", "utf-8");
    if (ageDays > 0) {
      const when = new Date(Date.now() - ageDays * 86_400_000);
      fs.utimesSync(filePath, when, when);
    }
    return filePath;
  }

  const names = (pattern: string) =>
    listStates({ pattern, location: StateLocation.LOCAL })
      .map((s) => s.name)
      .sort();

  it("treats regex metacharacters in a list pattern literally", () => {
    writeState("a.b");
    writeState("aXb");
    writeState("state(1)");
    writeState("state[");

    expect(names("a.b")).toEqual(["a.b"]);
    expect(names("state(1)")).toEqual(["state(1)"]);
    expect(names("state[")).toEqual(["state["]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still expands * as a wildcard", () => {
    writeState("ralph-state");
    writeState("ralph-state-2");
    writeState("team-state");

    expect(names("ralph-*")).toEqual(["ralph-state", "ralph-state-2"]);
    expect(names("*-state")).toEqual(["ralph-state", "team-state"]);
  });

  it("honors exclude patterns containing regex metacharacters during cleanup", () => {
    const keep = writeState("keep(1)", 60);
    const lookalike = writeState("keep1", 60);
    const dotted = writeState("a.b", 60);
    const dottedLookalike = writeState("aXb", 60);

    const result = cleanupOrphanedStates({
      maxAgeDays: 30,
      exclude: ["keep(1)", "a.b"],
    });

    expect(result.errors).toEqual([]);
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(dotted)).toBe(true);
    expect(fs.existsSync(lookalike)).toBe(false);
    expect(fs.existsSync(dottedLookalike)).toBe(false);
  });

  it("still expands * in cleanup exclusions", () => {
    const keep = writeState("keep-active", 60);
    const remove = writeState("orphan", 60);

    const result = cleanupOrphanedStates({
      maxAgeDays: 30,
      exclude: ["keep-*"],
    });

    expect(result.errors).toEqual([]);
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(remove)).toBe(false);
  });
});
