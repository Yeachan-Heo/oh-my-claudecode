import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "child_process";
import { join, resolve } from "path";
import { clearWorktreeCache, getOmcRoot } from "../worktree-paths.js";

const mockedExecFileSync = vi.mocked(execFileSync);

describe("resolveSuperprojectRoot cache", () => {
  beforeEach(() => {
    clearWorktreeCache();
    mockedExecFileSync.mockReset();
  });

  afterEach(() => {
    clearWorktreeCache();
    vi.restoreAllMocks();
  });

  it("caches repeated explicit non-git root probes, including null results, without changing the literal root", () => {
    const relativeRoot = join("superproject-cache-non-git");
    mockedExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("not a submodule"), {
        status: 128,
        stderr:
          "fatal: not a git repository (or any of the parent directories): .git",
      });
    });

    expect(getOmcRoot(relativeRoot)).toBe(join(relativeRoot, ".omc"));
    expect(getOmcRoot(relativeRoot)).toBe(join(relativeRoot, ".omc"));
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockedExecFileSync).toHaveBeenLastCalledWith(
      "git",
      ["rev-parse", "--show-superproject-working-tree"],
      expect.objectContaining({ cwd: resolve(relativeRoot), windowsHide: true }),
    );
  });

  it("does not cache transient superproject probe errors", () => {
    const transientRoot = resolve("repos", "transient-superproject-error");
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    expect(getOmcRoot(transientRoot)).toBe(join(transientRoot, ".omc"));
    expect(getOmcRoot(transientRoot)).toBe(join(transientRoot, ".omc"));
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("does not cache a partial anchor after a nested probe fails", () => {
    const nestedRoot = resolve("repos", "partial", "inner");
    const outerRoot = resolve("repos", "partial");
    mockedExecFileSync.mockImplementation((_command, _args, options) => {
      if (options?.cwd === nestedRoot) return `${outerRoot}\n`;
      if (options?.cwd === outerRoot) throw new Error("transient outer failure");
      throw new Error(`unexpected cwd: ${String(options?.cwd)}`);
    });

    expect(getOmcRoot(nestedRoot)).toBe(join(outerRoot, ".omc"));
    expect(getOmcRoot(nestedRoot)).toBe(join(outerRoot, ".omc"));
    expect(mockedExecFileSync).toHaveBeenCalledTimes(4);
  });

  it("caches the final outermost root after climbing nested submodules", () => {
    const nestedRoot = resolve("repos", "outer", "middle", "inner");
    const middleRoot = resolve("repos", "outer", "middle");
    const outerRoot = resolve("repos", "outer");
    mockedExecFileSync.mockImplementation((_command, _args, options) => {
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
    expect(mockedExecFileSync).toHaveBeenCalledTimes(3);
    expect(getOmcRoot(nestedRoot)).toBe(join(outerRoot, ".omc"));
    expect(mockedExecFileSync).toHaveBeenCalledTimes(3);
  });

  it("clearWorktreeCache invalidates both negative and positive superproject entries", () => {
    const nonGitRoot = resolve("repos", "no-superproject");
    const nestedRoot = resolve("repos", "outer", "inner");
    const outerRoot = resolve("repos", "outer");
    mockedExecFileSync.mockImplementation((_command, _args, options) => {
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
    expect(mockedExecFileSync).toHaveBeenCalledTimes(3);

    clearWorktreeCache();

    expect(getOmcRoot(nonGitRoot)).toBe(join(nonGitRoot, ".omc"));
    expect(getOmcRoot(nestedRoot)).toBe(join(outerRoot, ".omc"));
    expect(mockedExecFileSync).toHaveBeenCalledTimes(6);
  });

  it("evicts the least-recently-used superproject entry at capacity eight", () => {
    mockedExecFileSync.mockReturnValue("");
    const roots = Array.from({ length: 9 }, (_value, index) =>
      resolve("repos", `cache-${index}`),
    );

    for (const root of roots.slice(0, 8)) {
      getOmcRoot(root);
    }
    expect(mockedExecFileSync).toHaveBeenCalledTimes(8);

    getOmcRoot(roots[0]!);
    getOmcRoot(roots[8]!);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(9);

    getOmcRoot(roots[0]!);
    getOmcRoot(roots[1]!);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(10);
  });
});
