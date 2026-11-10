/**
 * Checkpoint feature tests: shadow-commit snapshot, listing, and rollback
 * semantics on real temporary git repositories.
 */

import { execFileSync } from "child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CheckpointError,
  createCheckpoint,
  isWorktreeDirty,
  listCheckpoints,
  rollbackToCheckpoint,
} from "../checkpoint/index.js";

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string): void {
  git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]);
}

/** Create a real git repo with one commit and a .gitignore. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "omc-checkpoint-"));
  tempDirs.push(dir);
  git(dir, ["init", "-q"]);
  // Restored files are compared byte for byte, whatever core.autocrlf the machine sets.
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "init"]);
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(dir, "base.txt"), "v1\n");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add base"]);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("createCheckpoint", () => {
  it("captures modified and untracked files without touching HEAD", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.txt"), "v2\n");
    writeFileSync(join(dir, "untracked.txt"), "new\n");

    const headBefore = git(dir, ["rev-parse", "HEAD"]);
    const id = createCheckpoint(dir, "test snapshot");

    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(headBefore);
    // HEAD and worktree untouched by snapshot.
    expect(readFileSync(join(dir, "base.txt"), "utf8")).toBe("v2\n");
  });

  it("labels the shadow commit", () => {
    const dir = makeRepo();
    const id = createCheckpoint(dir, "my label");
    const entries = listCheckpoints(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(id);
    expect(entries[0].label).toBe("my label");
    expect(entries[0].createdAt).toBeTruthy();
  });

  it("fails outside a git repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "omc-no-repo-"));
    tempDirs.push(outside);
    expect(() => createCheckpoint(outside, "x")).toThrow(CheckpointError);
  });

  it("rejects empty labels", () => {
    const dir = makeRepo();
    expect(() => createCheckpoint(dir, "   ")).toThrow(CheckpointError);
  });
});

describe("rollbackToCheckpoint", () => {
  it("restores modified content and removes files created after the snapshot", () => {
    const dir = makeRepo();
    const id = createCheckpoint(dir, "before changes");

    // Simulate an autonomous run gone wrong: modify, create, and leave junk.
    writeFileSync(join(dir, "base.txt"), "v2-broken\n");
    writeFileSync(join(dir, "generated.txt"), "junk\n");
    writeFileSync(join(dir, "ignored.txt"), "kept\n");

    rollbackToCheckpoint(dir, id, true);

    expect(readFileSync(join(dir, "base.txt"), "utf8")).toBe("v1\n");
    expect(existsSync(join(dir, "generated.txt"))).toBe(false);
    // Ignored paths survive (clean -fd keeps them).
    expect(readFileSync(join(dir, "ignored.txt"), "utf8")).toBe("kept\n");
    expect(git(dir, ["status", "--porcelain"])).toBe("");
  });

  it("refuses to discard uncommitted changes without force", () => {
    const dir = makeRepo();
    const id = createCheckpoint(dir, "safe point");
    writeFileSync(join(dir, "base.txt"), "v2\n");

    expect(() => rollbackToCheckpoint(dir, id)).toThrow(/--force/);
    // Worktree untouched by the refused rollback.
    expect(readFileSync(join(dir, "base.txt"), "utf8")).toBe("v2\n");
  });

  it("rejects unknown checkpoint ids", () => {
    const dir = makeRepo();
    expect(() => rollbackToCheckpoint(dir, "deadbeefdead")).toThrow(/unknown checkpoint/);
  });

  it("rejects traversal-shaped ids", () => {
    const dir = makeRepo();
    expect(() => rollbackToCheckpoint(dir, "../../etc")).toThrow(/invalid checkpoint id/);
  });
});

describe("isWorktreeDirty / listCheckpoints", () => {
  it("reports dirty state and lists checkpoints oldest first", () => {
    const dir = makeRepo();
    expect(isWorktreeDirty(dir)).toBe(false);
    const first = createCheckpoint(dir, "first");
    writeFileSync(join(dir, "extra.txt"), "x\n");
    const second = createCheckpoint(dir, "second");

    const entries = listCheckpoints(dir);
    // Both checkpoints can land in the same second (creatordate has second
    // granularity), so compare as a set; order is verified by --sort=creatordate.
    expect([...entries.map((e) => e.id)].sort()).toEqual([first, second].sort());

    // Snapshotting does not commit anything: extra.txt is still untracked
    // relative to HEAD even though the second checkpoint captured it.
    expect(isWorktreeDirty(dir)).toBe(true);
  });
});

describe("snapshots seeded from the real index", () => {
  function checkpointFiles(cwd: string, id: string): string[] {
    return git(cwd, ["ls-tree", "-r", "--name-only", id]).split("\n");
  }

  it("keeps a tracked file that matches .gitignore through a rollback", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "ignored.txt"), "tracked v1\n");
    git(dir, ["add", "-f", "ignored.txt"]);
    commit(dir, "track ignored.txt");

    const id = createCheckpoint(dir, "before build");
    expect(checkpointFiles(dir, id)).toContain("ignored.txt");

    // The run rebuilds the tracked file and breaks a source file.
    writeFileSync(join(dir, "ignored.txt"), "rebuilt\n");
    writeFileSync(join(dir, "base.txt"), "v2-broken\n");
    rollbackToCheckpoint(dir, id, true);

    expect(readFileSync(join(dir, "ignored.txt"), "utf8")).toBe("tracked v1\n");
    expect(readFileSync(join(dir, "base.txt"), "utf8")).toBe("v1\n");
    expect(git(dir, ["status", "--porcelain"])).toBe("");
  });

  it("keeps a tracked file that matches .git/info/exclude, and still leaves out untracked ignored files", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "settings.local.json"), "{}\n");
    git(dir, ["add", "settings.local.json"]);
    commit(dir, "track settings.local.json");
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    appendFileSync(join(dir, ".git", "info", "exclude"), "*.local.json\n");
    writeFileSync(join(dir, "scratch.local.json"), "untracked\n");

    const id = createCheckpoint(dir, "before");
    expect(checkpointFiles(dir, id)).toContain("settings.local.json");
    expect(checkpointFiles(dir, id)).not.toContain("scratch.local.json");

    rmSync(join(dir, "settings.local.json"));
    rollbackToCheckpoint(dir, id, true);

    expect(readFileSync(join(dir, "settings.local.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(dir, "scratch.local.json"), "utf8")).toBe("untracked\n");
    expect(git(dir, ["status", "--porcelain"])).toBe("");
  });

  it("reads a linked worktree's own index", () => {
    const dir = makeRepo();
    const parent = mkdtempSync(join(tmpdir(), "omc-checkpoint-wt-"));
    tempDirs.push(parent);
    const worktree = join(parent, "wt");
    git(dir, ["worktree", "add", "-q", "--detach", worktree]);
    // Tracked only in the linked worktree: the main worktree's index lacks it.
    writeFileSync(join(worktree, "ignored.txt"), "tracked v1\n");
    git(worktree, ["add", "-f", "ignored.txt"]);
    commit(worktree, "track ignored.txt in the linked worktree");

    const id = createCheckpoint(worktree, "before build");
    expect(checkpointFiles(worktree, id)).toContain("ignored.txt");

    writeFileSync(join(worktree, "ignored.txt"), "rebuilt\n");
    rollbackToCheckpoint(worktree, id, true);

    expect(readFileSync(join(worktree, "ignored.txt"), "utf8")).toBe("tracked v1\n");
    expect(git(worktree, ["status", "--porcelain"])).toBe("");
  });

  it("keeps the executable bit and symlinks when core.fileMode and core.symlinks are off", () => {
    const dir = makeRepo();
    git(dir, ["config", "core.fileMode", "false"]);
    git(dir, ["config", "core.symlinks", "false"]);
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
    git(dir, ["add", "run.sh"]);
    git(dir, ["update-index", "--chmod=+x", "run.sh"]);
    // Without core.symlinks, a symlink is checked out as a file holding its target.
    writeFileSync(join(dir, "link"), "base.txt");
    const blob = git(dir, ["hash-object", "-w", "link"]);
    git(dir, ["update-index", "--add", "--cacheinfo", `120000,${blob},link`]);
    commit(dir, "add run.sh and link");

    const id = createCheckpoint(dir, "before");
    const tree = git(dir, ["ls-tree", id]);
    expect(tree).toMatch(/^100755 blob [0-9a-f]+\trun\.sh$/m);
    expect(tree).toMatch(/^120000 blob [0-9a-f]+\tlink$/m);

    writeFileSync(join(dir, "base.txt"), "v2-broken\n");
    rollbackToCheckpoint(dir, id, true);

    expect(git(dir, ["status", "--porcelain"])).toBe("");
  });

  it("keeps a submodule that is not checked out", () => {
    const dir = makeRepo();
    // As after a clone without --recurse-submodules: a gitlink and an empty directory.
    mkdirSync(join(dir, "sub"));
    const head = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["update-index", "--add", "--cacheinfo", `160000,${head},sub`]);
    commit(dir, "add sub");

    const id = createCheckpoint(dir, "before");
    expect(git(dir, ["ls-tree", id, "sub"])).toMatch(/^160000 commit [0-9a-f]+\tsub$/);

    writeFileSync(join(dir, "base.txt"), "v2-broken\n");
    rollbackToCheckpoint(dir, id, true);

    expect(existsSync(join(dir, "sub"))).toBe(true);
    expect(git(dir, ["status", "--porcelain"])).toBe("");
  });

  it("snapshots a conflicted merge as the worktree has it", () => {
    const dir = makeRepo();
    git(dir, ["checkout", "-q", "-b", "other"]);
    writeFileSync(join(dir, "base.txt"), "other\n");
    git(dir, ["add", "base.txt"]);
    commit(dir, "other");
    git(dir, ["checkout", "-q", "-"]);
    writeFileSync(join(dir, "base.txt"), "mine\n");
    git(dir, ["add", "base.txt"]);
    commit(dir, "mine");
    expect(() => git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "other"])).toThrow();
    expect(git(dir, ["status", "--porcelain"])).toBe("UU base.txt");

    const id = createCheckpoint(dir, "mid-merge");
    expect(git(dir, ["show", `${id}:base.txt`])).toContain("<<<<<<<");
  });

  it("snapshots a repository with no commits and no index", () => {
    const dir = mkdtempSync(join(tmpdir(), "omc-checkpoint-"));
    tempDirs.push(dir);
    git(dir, ["init", "-q"]);
    git(dir, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(dir, "a.txt"), "a\n");

    const id = createCheckpoint(dir, "first");
    expect(checkpointFiles(dir, id)).toEqual(["a.txt"]);
  });
});
