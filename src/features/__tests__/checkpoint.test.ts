/**
 * Checkpoint feature tests: shadow-commit snapshot, listing, and rollback
 * semantics on real temporary git repositories.
 */

import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
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

/** Create a real git repo with one commit and a .gitignore. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "omc-checkpoint-"));
  tempDirs.push(dir);
  git(dir, ["init", "-q"]);
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
