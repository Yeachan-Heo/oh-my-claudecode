import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync as realExecFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

vi.mock("child_process", async () => {
  const actual =
    await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
  };
});

import { execFileSync } from "child_process";
import {
  clearWorktreeCache,
  getGitTopLevel,
  getOmcRoot,
  getWorktreeRoot,
  probeGitTopLevel,
  setGitShowToplevelProbeForTests,
  validateWorkingDirectory,
} from "../worktree-paths.js";

const mockedExecFileSync = vi.mocked(execFileSync);

function git(cwd: string, args: string[]): string {
  return realExecFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initRepo(cwd: string): void {
  mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "--quiet"]);
  git(cwd, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=omc-test",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "init",
  ]);
}

function showToplevelCalls(): number {
  return mockedExecFileSync.mock.calls.filter(
    ([, args]) =>
      Array.isArray(args) &&
      args[0] === "rev-parse" &&
      args[1] === "--show-toplevel",
  ).length;
}

describe("git top-level memoization", () => {
  let tempDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omc-toplevel-cache-"));
    process.chdir(originalCwd);
    clearWorktreeCache();
    mockedExecFileSync.mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    setGitShowToplevelProbeForTests(undefined);
    clearWorktreeCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("memoizes repeated state-root lookups without repeating show-toplevel", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);

    expect(getOmcRoot(repo)).toBe(join(repo, ".omc"));
    expect(getOmcRoot(repo)).toBe(join(repo, ".omc"));
    expect(getOmcRoot(repo)).toBe(join(repo, ".omc"));
    expect(showToplevelCalls()).toBe(1);
  });

  it("keeps a 171-call state render to one top-level probe", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);

    for (let renderCall = 0; renderCall < 171; renderCall++) {
      expect(getOmcRoot(repo)).toBe(join(repo, ".omc"));
    }

    expect(showToplevelCalls()).toBe(1);
  });

  it("keeps the root correct across repository and child-directory lookups", () => {
    const repo = join(tempDir, "repo");
    const child = join(repo, "src");
    initRepo(repo);
    mkdirSync(child, { recursive: true });

    expect(getGitTopLevel(repo)).toBe(repo);
    expect(getGitTopLevel(child)).toBe(repo);
    expect(getGitTopLevel(child)).toBe(repo);
    expect(showToplevelCalls()).toBe(2);
  });

  it("shares a positive entry between real and symlinked paths", () => {
    const repo = join(tempDir, "repo");
    const alias = join(tempDir, "repo-link");
    initRepo(repo);

    try {
      symlinkSync(repo, alias, "dir");
    } catch {
      return;
    }

    expect(getGitTopLevel(repo)).toBe(repo);
    expect(getGitTopLevel(alias)).toBe(repo);
    expect(showToplevelCalls()).toBe(1);
  });

  it("keeps linked worktree roots in separate cache entries", () => {
    const repo = join(tempDir, "repo");
    const linked = join(tempDir, "linked");
    initRepo(repo);
    git(repo, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "linked-cache-test",
      linked,
    ]);

    expect(getGitTopLevel(repo)).toBe(repo);
    expect(getGitTopLevel(linked)).toBe(linked);
    expect(getGitTopLevel(linked)).toBe(linked);
    expect(showToplevelCalls()).toBe(2);
  });

  it("invalidates a linked-worktree cache when common config changes", () => {
    const repo = join(tempDir, "repo");
    const linked = join(tempDir, "linked");
    initRepo(repo);
    git(repo, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "linked-common-config-test",
      linked,
    ]);

    expect(getGitTopLevel(linked)).toBe(linked);
    git(repo, ["config", "core.bare", "false"]);

    expect(getGitTopLevel(linked)).toBe(linked);
    expect(showToplevelCalls()).toBe(2);
  });

  it("invalidates a cached parent root when a nested repository appears", () => {
    const repo = join(tempDir, "repo");
    const nested = join(repo, "nested");
    initRepo(repo);
    mkdirSync(nested, { recursive: true });

    expect(getGitTopLevel(nested)).toBe(repo);
    initRepo(nested);
    expect(getGitTopLevel(nested)).toBe(nested);
    expect(showToplevelCalls()).toBe(2);
  });

  it("invalidates the state-anchor cache when a nested repository appears", () => {
    const repo = join(tempDir, "repo");
    const nested = join(repo, "nested");
    initRepo(repo);
    mkdirSync(nested, { recursive: true });

    expect(getWorktreeRoot(nested)).toBe(repo);
    initRepo(nested);
    expect(getWorktreeRoot(nested)).toBe(nested);
  });

  it("invalidates the state-anchor cache when Git discovery environment changes", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    const previousPath = process.env.PATH;
    try {
      expect(getWorktreeRoot(repo)).toBe(repo);
      process.env.PATH = `${previousPath ?? ""}${process.platform === "win32" ? ";" : ":"}${tempDir}`;

      expect(getWorktreeRoot(repo)).toBe(repo);
      expect(showToplevelCalls()).toBe(2);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("invalidates a cached superproject anchor when its gitlink is removed", () => {
    const superproject = join(tempDir, "superproject");
    const submodule = join(tempDir, "submodule");
    const checkedOutSubmodule = join(superproject, "nested");
    initRepo(superproject);
    initRepo(submodule);
    git(superproject, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      submodule,
      "nested",
    ]);
    git(superproject, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=omc-test",
      "commit",
      "--quiet",
      "-m",
      "add submodule",
    ]);

    expect(getWorktreeRoot(checkedOutSubmodule)).toBe(superproject);
    git(superproject, ["update-index", "--force-remove", "nested"]);
    git(superproject, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=omc-test",
      "commit",
      "--quiet",
      "-m",
      "remove submodule gitlink",
    ]);

    expect(getWorktreeRoot(checkedOutSubmodule)).toBe(checkedOutSubmodule);
  });

  it("invalidates a linked-worktree entry when its gitdir disappears", () => {
    const repo = join(tempDir, "repo");
    const linked = join(tempDir, "linked");
    initRepo(repo);
    git(repo, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "linked-metadata-test",
      linked,
    ]);

    expect(getGitTopLevel(linked)).toBe(linked);
    const gitDir = readFileSync(join(linked, ".git"), "utf8").match(
      /^\s*gitdir:\s*(.+?)\s*$/im,
    );
    expect(gitDir).not.toBeNull();
    rmSync(resolve(linked, gitDir![1]), { recursive: true, force: true });

    expect(getGitTopLevel(linked)).toBeNull();
    expect(showToplevelCalls()).toBe(2);
  });

  it("invalidates a cached root when repository HEAD metadata disappears", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);

    expect(getGitTopLevel(repo)).toBe(repo);
    rmSync(join(repo, ".git", "HEAD"));

    expect(getGitTopLevel(repo)).toBeNull();
    expect(showToplevelCalls()).toBe(2);
  });

  it("invalidates a cached root when Git discovery environment changes", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    const previousGitDir = process.env.GIT_DIR;
    try {
      expect(getGitTopLevel(repo)).toBe(repo);
      process.env.GIT_DIR = join(repo, ".git");

      expect(getGitTopLevel(repo)).toBe(repo);
      expect(showToplevelCalls()).toBe(2);
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
    }
  });

  it("distinguishes unset and empty Git environment values", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    const previousPath = process.env.PATH;
    let probeCalls = 0;
    setGitShowToplevelProbeForTests(() => {
      probeCalls++;
      return `${repo}\n`;
    });
    try {
      expect(getGitTopLevel(repo)).toBe(repo);
      delete process.env.PATH;
      expect(getGitTopLevel(repo)).toBe(repo);
      process.env.PATH = "";
      expect(getGitTopLevel(repo)).toBe(repo);
      process.env.PATH = "<unset>";
      expect(getGitTopLevel(repo)).toBe(repo);
      expect(probeCalls).toBe(4);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("invalidates a cached root when Git config metadata changes", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);

    expect(getGitTopLevel(repo)).toBe(repo);
    git(repo, ["config", "core.bare", "false"]);

    expect(getGitTopLevel(repo)).toBe(repo);
    expect(showToplevelCalls()).toBe(2);
  });

  it("does not cache a non-repository result before git init", () => {
    const repo = join(tempDir, "repo");

    expect(getGitTopLevel(repo)).toBeNull();
    initRepo(repo);
    expect(getGitTopLevel(repo)).toBe(repo);
    expect(showToplevelCalls()).toBe(2);
  });

  it("keeps direct boundary probes uncached", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);

    expect(probeGitTopLevel(repo).status).toBe("ok");
    expect(probeGitTopLevel(repo).status).toBe("ok");
    expect(showToplevelCalls()).toBe(2);
  });

  it("fails closed when the validator sees a transient git probe failure", () => {
    const repo = join(tempDir, "repo");
    initRepo(repo);
    process.chdir(repo);
    setGitShowToplevelProbeForTests(() => {
      const error = new Error("git unavailable") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });

    expect(() => validateWorkingDirectory()).toThrow(/git probe failed and was not used/);
  });
});
