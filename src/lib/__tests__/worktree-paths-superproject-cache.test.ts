import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "child_process";
import { join, resolve } from "path";
import { clearWorktreeCache, getOmcRoot } from "../worktree-paths.js";

const mockedExecSync = vi.mocked(execSync);

describe("resolveSuperprojectRoot cache", () => {
  beforeEach(() => {
    clearWorktreeCache();
    mockedExecSync.mockReset();
  });

  afterEach(() => {
    clearWorktreeCache();
    vi.restoreAllMocks();
  });

  it("caches repeated explicit non-git root probes, including null results, without changing the literal root", () => {
    const relativeRoot = join("superproject-cache-non-git");
    mockedExecSync.mockImplementation(() => {
      throw Object.assign(new Error("not a submodule"), {
        status: 128,
        stderr:
          "fatal: not a git repository (or any of the parent directories): .git",
      });
    });

    expect(getOmcRoot(relativeRoot)).toBe(join(relativeRoot, ".omc"));
    expect(getOmcRoot(relativeRoot)).toBe(join(relativeRoot, ".omc"));
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
    expect(mockedExecSync).toHaveBeenLastCalledWith(
      "git rev-parse --show-superproject-working-tree",
      expect.objectContaining({ cwd: resolve(relativeRoot) }),
    );
  });

  it("does not cache transient superproject probe errors", () => {
    const transientRoot = resolve("repos", "transient-superproject-error");
    mockedExecSync.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    expect(getOmcRoot(transientRoot)).toBe(join(transientRoot, ".omc"));
    expect(getOmcRoot(transientRoot)).toBe(join(transientRoot, ".omc"));
    expect(mockedExecSync).toHaveBeenCalledTimes(2);
  });

  it("does not cache a partial anchor after a nested probe fails", () => {
    const nestedRoot = resolve("repos", "partial", "inner");
    const outerRoot = resolve("repos", "partial");
    mockedExecSync.mockImplementation((_command, options) => {
      if (options?.cwd === nestedRoot) return `${outerRoot}\n`;
      if (options?.cwd === outerRoot) throw new Error("transient outer failure");
      throw new Error(`unexpected cwd: ${String(options?.cwd)}`);
    });

    expect(getOmcRoot(nestedRoot)).toBe(join(outerRoot, ".omc"));
    expect(getOmcRoot(nestedRoot)).toBe(join(outerRoot, ".omc"));
    expect(mockedExecSync).toHaveBeenCalledTimes(4);
  });

  it("caches the final outermost root after climbing nested submodules", () => {
    const nestedRoot = resolve("repos", "outer", "middle", "inner");
    const middleRoot = resolve("repos", "outer", "middle");
    const outerRoot = resolve("repos", "outer");
    mockedExecSync.mockImplementation((_command, options) => {
      switch (options?.cwd) {
        case nestedRoot:
          return `${middleRoot}\n`;
        case middleRoot:
          return `${outerRoot}\n`;
        case outerRoot:
          return "";
        default:
          throw new Error(`unexpected cwd: ${String(options?.cwd)}`);
      }
    });

    expect(getOmcRoot(nestedRoot)).toBe(join(outerRoot, ".omc"));
    expect(mockedExecSync).toHaveBeenCalledTimes(3);
    expect(getOmcRoot(nestedRoot)).toBe(join(outerRoot, ".omc"));
    expect(mockedExecSync).toHaveBeenCalledTimes(3);
  });

  it("clearWorktreeCache invalidates both negative and positive superproject entries", () => {
    const nonGitRoot = resolve("repos", "no-superproject");
    const nestedRoot = resolve("repos", "outer", "inner");
    const outerRoot = resolve("repos", "outer");
    mockedExecSync.mockImplementation((_command, options) => {
      if (options?.cwd === nonGitRoot) {
        throw Object.assign(new Error("not a submodule"), {
          status: 128,
          stderr: "fatal: not a git repository",
        });
      }
      if (options?.cwd === nestedRoot) return `${outerRoot}\n`;
      if (options?.cwd === outerRoot) return "";
      throw new Error(`unexpected cwd: ${String(options?.cwd)}`);
    });

    expect(getOmcRoot(nonGitRoot)).toBe(join(nonGitRoot, ".omc"));
    expect(getOmcRoot(nestedRoot)).toBe(join(outerRoot, ".omc"));
    expect(mockedExecSync).toHaveBeenCalledTimes(3);

    clearWorktreeCache();

    expect(getOmcRoot(nonGitRoot)).toBe(join(nonGitRoot, ".omc"));
    expect(getOmcRoot(nestedRoot)).toBe(join(outerRoot, ".omc"));
    expect(mockedExecSync).toHaveBeenCalledTimes(6);
  });

  it("evicts the least-recently-used superproject entry at capacity eight", () => {
    mockedExecSync.mockReturnValue("");
    const roots = Array.from({ length: 9 }, (_value, index) =>
      resolve("repos", `cache-${index}`),
    );

    for (const root of roots.slice(0, 8)) {
      getOmcRoot(root);
    }
    expect(mockedExecSync).toHaveBeenCalledTimes(8);

    getOmcRoot(roots[0]!);
    getOmcRoot(roots[8]!);
    expect(mockedExecSync).toHaveBeenCalledTimes(9);

    getOmcRoot(roots[0]!);
    getOmcRoot(roots[1]!);
    expect(mockedExecSync).toHaveBeenCalledTimes(10);
  });
});
