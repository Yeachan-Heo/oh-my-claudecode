import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectWorktreeDirtyEvidence,
  buildDirtyWorktreeNotice,
  isAbnormalTermination,
  MAX_EVIDENCE_ENTRIES,
  type WorktreeDirtyEvidence,
} from "../worktree-evidence.js";

const tempDirs: string[] = [];

function makeTempDir(prefix = "omc-wt-evidence-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

function initRepo(dir: string): void {
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("collectWorktreeDirtyEvidence", () => {
  it("returns clean for a pristine git worktree", () => {
    const repo = makeTempDir();
    initRepo(repo);

    const evidence = collectWorktreeDirtyEvidence(repo);
    expect(evidence.kind).toBe("clean");
    expect(evidence.trackedCount).toBe(0);
    expect(evidence.untrackedCount).toBe(0);
    expect(evidence.ignoredCount).toBe(0);
    expect(evidence.entries).toEqual([]);
    expect(evidence.truncated).toBe(false);
    expect(evidence.worktreeRoot).toBe(repo);
  });

  it("flags dirty when a tracked file is modified", () => {
    const repo = makeTempDir();
    initRepo(repo);
    writeFileSync(join(repo, "README.md"), "# modified\n");

    const evidence = collectWorktreeDirtyEvidence(repo);
    expect(evidence.kind).toBe("dirty");
    expect(evidence.trackedCount).toBe(1);
    expect(evidence.untrackedCount).toBe(0);
    expect(evidence.entries).toContain("README.md");
  });

  it("flags dirty for untracked files", () => {
    const repo = makeTempDir();
    initRepo(repo);
    writeFileSync(join(repo, "campaign.md"), "new work\n");

    const evidence = collectWorktreeDirtyEvidence(repo);
    expect(evidence.kind).toBe("dirty");
    expect(evidence.untrackedCount).toBe(1);
    expect(evidence.entries).toContain("campaign.md");
  });

  it("counts ignored files separately and does NOT treat them as at-risk work", () => {
    const repo = makeTempDir();
    initRepo(repo);
    writeFileSync(join(repo, ".gitignore"), "build/\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-m", "ignore build"]);
    mkdirSync(join(repo, "build"), { recursive: true });
    writeFileSync(join(repo, "build", "out.txt"), "artifact\n");

    const evidence = collectWorktreeDirtyEvidence(repo);
    expect(evidence.kind).toBe("clean");
    expect(evidence.trackedCount).toBe(0);
    expect(evidence.untrackedCount).toBe(0);
    expect(evidence.ignoredCount).toBe(1);
  });

  it("enumerates nested untracked directories with --untracked-files=all (issue #3663 B1)", () => {
    const repo = makeTempDir();
    initRepo(repo);
    // `git status --porcelain` (without --untracked-files=all) collapses a
    // nested untracked directory to a single "dir/" line. The collector must
    // enumerate every file so the counts and bounded entries reflect the real
    // at-risk work.
    const nested = join(repo, "src", "deep", "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "a.ts"), "a\n");
    writeFileSync(join(nested, "b.ts"), "b\n");
    writeFileSync(join(nested, "c.ts"), "c\n");

    const evidence = collectWorktreeDirtyEvidence(repo);
    expect(evidence.kind).toBe("dirty");
    expect(evidence.untrackedCount).toBe(3);
    expect(evidence.trackedCount).toBe(0);
    expect(evidence.entries).toContain("src/deep/nested/a.ts");
    expect(evidence.entries).toContain("src/deep/nested/b.ts");
    expect(evidence.entries).toContain("src/deep/nested/c.ts");
    expect(evidence.truncated).toBe(false);
  });

  it("combines tracked, untracked, and ignored counts", () => {
    const repo = makeTempDir();
    initRepo(repo);
    writeFileSync(join(repo, ".gitignore"), "build/\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-m", "ignore build"]);
    writeFileSync(join(repo, "README.md"), "# modified\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    mkdirSync(join(repo, "build"), { recursive: true });
    writeFileSync(join(repo, "build", "out.txt"), "artifact\n");

    const evidence = collectWorktreeDirtyEvidence(repo);
    expect(evidence.kind).toBe("dirty");
    expect(evidence.trackedCount).toBe(1);
    expect(evidence.untrackedCount).toBe(1);
    expect(evidence.ignoredCount).toBe(1);
  });

  it("returns not_git for a non-repository directory", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "not a repo\n");

    const evidence = collectWorktreeDirtyEvidence(dir);
    expect(evidence.kind).toBe("not_git");
  });

  it("returns cwd_missing for a deleted working directory", () => {
    const missing = join(makeTempDir(), "deleted-cwd");
    const evidence = collectWorktreeDirtyEvidence(missing);
    expect(evidence.kind).toBe("cwd_missing");
  });

  it("returns git_unavailable when the git binary cannot run", () => {
    const repo = makeTempDir();
    initRepo(repo);

    const evidence = collectWorktreeDirtyEvidence(repo, {
      gitCommand: join(repo, "no-such-git-binary"),
    });
    expect(evidence.kind).toBe("git_unavailable");
    expect(evidence.error).toContain("git_unavailable");
  });

  it("identifies linked git worktrees as isolated worktrees", () => {
    const repo = makeTempDir();
    initRepo(repo);
    const worktree = join(repo, ".omc", "team", "demo-team", "worktrees", "worker-1");
    mkdirSync(worktree, { recursive: true });
    git(repo, ["worktree", "add", "-b", "linked-branch", worktree]);

    const evidence = collectWorktreeDirtyEvidence(worktree);
    expect(evidence.isLinkedWorktree).toBe(true);
    expect(evidence.worktreeRoot).toBe(worktree);
    expect(evidence.kind).toBe("clean");

    // Dirty the linked worktree.
    writeFileSync(join(worktree, "README.md"), "# modified in worktree\n");
    const dirty = collectWorktreeDirtyEvidence(worktree);
    expect(dirty.kind).toBe("dirty");
    expect(dirty.trackedCount).toBe(1);
  });

  it("bounds entries and marks truncation", () => {
    const repo = makeTempDir();
    initRepo(repo);
    for (let i = 0; i < MAX_EVIDENCE_ENTRIES + 5; i++) {
      writeFileSync(join(repo, `untracked-${i}.txt`), `content ${i}\n`);
    }

    const evidence = collectWorktreeDirtyEvidence(repo);
    expect(evidence.kind).toBe("dirty");
    expect(evidence.untrackedCount).toBe(MAX_EVIDENCE_ENTRIES + 5);
    expect(evidence.entries.length).toBe(MAX_EVIDENCE_ENTRIES);
    expect(evidence.truncated).toBe(true);
  });

  it("bounds hundreds of nested untracked files with truncation (issue #3663 B1)", () => {
    const repo = makeTempDir();
    initRepo(repo);
    // With --untracked-files=all every nested file is enumerated; hundreds of
    // them must be counted fully but only the bounded prefix kept as entries.
    for (let d = 0; d < 12; d++) {
      const dir = join(repo, "deep", `d${d}`);
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 30; f++) {
        writeFileSync(join(dir, `f${f}.txt`), `content\n`);
      }
    }

    const evidence = collectWorktreeDirtyEvidence(repo);
    expect(evidence.kind).toBe("dirty");
    expect(evidence.untrackedCount).toBe(360);
    expect(evidence.entries.length).toBe(MAX_EVIDENCE_ENTRIES);
    expect(evidence.truncated).toBe(true);
  });

  it("never mutates the repository while collecting evidence", () => {
    const repo = makeTempDir();
    initRepo(repo);
    writeFileSync(join(repo, "README.md"), "# modified\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    const statusBefore = git(repo, ["status", "--porcelain"]);
    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const stashBefore = git(repo, ["stash", "list"]);

    collectWorktreeDirtyEvidence(repo);

    expect(git(repo, ["status", "--porcelain"])).toBe(statusBefore);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(repo, ["stash", "list"])).toBe(stashBefore);
    // No new commits were created by the collector.
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("is fail-closed and never throws", () => {
    expect(() => collectWorktreeDirtyEvidence(join(makeTempDir(), "nope"))).not.toThrow();
    const repo = makeTempDir();
    initRepo(repo);
    expect(() =>
      collectWorktreeDirtyEvidence(repo, { gitCommand: "/nonexistent/git" }),
    ).not.toThrow();
  });
  it("respects a shared bounded git deadline (issue #3663 B5)", () => {
    // B5: the total git wall-time must be capped by the shared deadline even
    // when a single git call would otherwise run far longer. Use a
    // script-provided fake git that sleeps longer than the tiny deadline; the
    // collector must degrade fail-open to git_unavailable instead of throwing
    // or overrunning.
    const repo = makeTempDir();
    initRepo(repo);
    const fakeGit = join(repo, "slow-git.sh");
    writeFileSync(
      fakeGit,
      `#!/bin/sh\nsleep 2\nexit 1\n`,
      { mode: 0o755 },
    );

    const startedAt = Date.now();
    const evidence = collectWorktreeDirtyEvidence(repo, {
      gitCommand: fakeGit,
      timeoutMs: 2000,
      deadlineMs: 120,
    });
    const elapsed = Date.now() - startedAt;

    expect(evidence.kind).toBe("git_unavailable");
    expect(elapsed).toBeLessThan(1500);
    expect(() => evidence).not.toThrow();
  });

  it("survives huge nested untracked output beyond the default buffer (issue #3663 B7)", () => {
    // B7: git status --untracked-files=all on a huge dirty tree can exceed
    // Node's default 1 MiB maxBuffer (ENOBUFS), losing ALL evidence. The
    // collector must count every line and cap entries without throwing.
    // Use a fake git that answers rev-parse with the repo toplevel and emits
    // > 1 MiB of status lines for the status calls — deterministic and fast.
    const repo = makeTempDir();
    initRepo(repo);
    const fakeGit = join(repo, "huge-git.sh");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  echo "$PWD"
  exit 0
fi
# Emit > 1 MiB of untracked status lines (default maxBuffer is 1 MiB).
for i in $(seq 1 60000); do
  echo "?? f$i.txt"
done
`,
      { mode: 0o755 },
    );

    const evidence = collectWorktreeDirtyEvidence(repo, {
      gitCommand: fakeGit,
    });
    expect(evidence.kind).toBe("dirty");
    expect(evidence.untrackedCount).toBe(60000);
    expect(evidence.entries.length).toBe(MAX_EVIDENCE_ENTRIES);
    expect(evidence.truncated).toBe(true);
  });

  it("keeps dirty evidence when only the ignored scan fails (issue #3663 P1)", () => {
    // P1: the ignored-file scan is informational. When the regular status call
    // already proved the worktree dirty, a secondary ignored-scan failure must
    // NOT overwrite the dirty kind with git_unavailable — that suppressed the
    // coordinator notice and the replay dirty_worktree record entirely.
    const repo = makeTempDir();
    initRepo(repo);
    const fakeGit = join(repo, "ignored-fails-git.sh");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  echo "$PWD"
  exit 0
fi
for arg in "$@"; do
  case "$arg" in
    --ignored=*) exit 128 ;;
  esac
done
printf ' M README.md\\n?? new.txt\\n'
exit 0
`,
      { mode: 0o755 },
    );

    const evidence = collectWorktreeDirtyEvidence(repo, { gitCommand: fakeGit });
    expect(evidence.kind).toBe("dirty");
    expect(evidence.trackedCount).toBe(1);
    expect(evidence.untrackedCount).toBe(1);
    // Ignored info is unavailable, so it degrades to 0 — never to lost evidence.
    expect(evidence.ignoredCount).toBe(0);
    expect(evidence.error).toContain("ignored_scan_failed");
    expect(evidence.worktreeRoot).toBe(repo);
    // The coordinator notice and the replay dirty gate both key off kind.
    expect(
      buildDirtyWorktreeNotice(evidence, "agent-p1", "executor"),
    ).toContain("2 uncommitted file(s)");
  });

  it("keeps a clean verdict when only the ignored scan fails (issue #3663 P1)", () => {
    const repo = makeTempDir();
    initRepo(repo);
    const fakeGit = join(repo, "ignored-fails-clean-git.sh");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  echo "$PWD"
  exit 0
fi
for arg in "$@"; do
  case "$arg" in
    --ignored=*) exit 128 ;;
  esac
done
exit 0
`,
      { mode: 0o755 },
    );

    const evidence = collectWorktreeDirtyEvidence(repo, { gitCommand: fakeGit });
    expect(evidence.kind).toBe("clean");
    expect(evidence.trackedCount).toBe(0);
    expect(evidence.untrackedCount).toBe(0);
    expect(evidence.ignoredCount).toBe(0);
    expect(evidence.error).toContain("ignored_scan_failed");
  });

  it("attributes overflow rows to their porcelain category (issue #3663 P2)", () => {
    // P2: rows beyond MAX_EVIDENCE_ENTRIES were counted as untracked
    // regardless of their porcelain status code, so tracked (at-risk,
    // committed-history-bearing) work was reported as untracked and ignored
    // rows past the cap vanished.
    const repo = makeTempDir();
    initRepo(repo);
    const fakeGit = join(repo, "mixed-overflow-git.sh");
    writeFileSync(
      fakeGit,
      `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  echo "$PWD"
  exit 0
fi
emit_tracked() {
  i=1
  while [ "$i" -le 30 ]; do
    printf ' M tracked-%s.txt\\n' "$i"
    i=$((i + 1))
  done
}
emit_untracked() {
  i=1
  while [ "$i" -le 25 ]; do
    printf '?? untracked-%s.txt\\n' "$i"
    i=$((i + 1))
  done
}
for arg in "$@"; do
  case "$arg" in
    --ignored=*)
      emit_tracked
      emit_untracked
      i=1
      while [ "$i" -le 10 ]; do
        printf '!! ignored-%s.txt\\n' "$i"
        i=$((i + 1))
      done
      exit 0
      ;;
  esac
done
emit_tracked
emit_untracked
exit 0
`,
      { mode: 0o755 },
    );

    const evidence = collectWorktreeDirtyEvidence(repo, { gitCommand: fakeGit });
    expect(evidence.kind).toBe("dirty");
    expect(evidence.trackedCount).toBe(30);
    expect(evidence.untrackedCount).toBe(25);
    expect(evidence.ignoredCount).toBe(10);
    expect(evidence.entries.length).toBe(MAX_EVIDENCE_ENTRIES);
    expect(evidence.truncated).toBe(true);
    // Ignored rows are informational and never inflate the at-risk total.
    expect(
      buildDirtyWorktreeNotice(evidence, "agent-p2", "executor"),
    ).toContain("55 uncommitted file(s)");
  });
});

describe("buildDirtyWorktreeNotice", () => {
  const agentId = "agent-abcdef123456789";
  const agentType = "oh-my-claudecode:executor";

  it("builds a bounded notice for dirty evidence", () => {
    const evidence: WorktreeDirtyEvidence = {
      kind: "dirty",
      worktreeRoot: "/tmp/omc/worktree-1",
      isLinkedWorktree: true,
      trackedCount: 1,
      untrackedCount: 2,
      ignoredCount: 0,
      entries: ["a.txt"],
      truncated: false,
    };

    const notice = buildDirtyWorktreeNotice(evidence, agentId, agentType);
    expect(notice).toBeTruthy();
    expect(notice).toContain("agent-a");
    expect(notice).toContain("3 uncommitted file(s)");
    expect(notice).toContain("1 tracked, 2 untracked");
    expect(notice).toContain("/tmp/omc/worktree-1");
    expect(notice).not.toContain("\n");
  });

  it("returns null for non-dirty kinds", () => {
    const base: WorktreeDirtyEvidence = {
      kind: "clean",
      worktreeRoot: "/tmp/omc/worktree-1",
      isLinkedWorktree: true,
      trackedCount: 0,
      untrackedCount: 0,
      ignoredCount: 0,
      entries: [],
      truncated: false,
    };
    expect(buildDirtyWorktreeNotice(base, agentId, agentType)).toBeNull();
    expect(
      buildDirtyWorktreeNotice({ ...base, kind: "not_git" }, agentId, agentType),
    ).toBeNull();
    expect(
      buildDirtyWorktreeNotice({ ...base, kind: "cwd_missing" }, agentId, agentType),
    ).toBeNull();
    expect(
      buildDirtyWorktreeNotice(
        { ...base, kind: "git_unavailable", error: "git_unavailable" },
        agentId,
        agentType,
      ),
    ).toBeNull();
  });

  it("redacts file content from the notice", () => {
    const repo = makeTempDir();
    initRepo(repo);
    writeFileSync(join(repo, "secrets.env"), "SUPER_SECRET_TOKEN=hunter2\n");
    const evidence = collectWorktreeDirtyEvidence(repo);

    const notice = buildDirtyWorktreeNotice(evidence, agentId, agentType);
    expect(evidence.kind).toBe("dirty");
    expect(notice).not.toContain("SUPER_SECRET_TOKEN");
    expect(notice).not.toContain("hunter2");
  });
});

describe("isAbnormalTermination", () => {
  it("treats explicit failure as abnormal", () => {
    expect(isAbnormalTermination({ success: false })).toBe(true);
    expect(isAbnormalTermination({ success: false, output: "any output" })).toBe(true);
  });

  it("detects structured failure envelopes when success is omitted (issue #3663 B6)", () => {
    // Whole-line <status>failed</status> envelope.
    expect(
      isAbnormalTermination({
        output: "<task-notification>\n<status>failed</status>\n</task-notification>",
      }),
    ).toBe(true);
    // Start-of-line API-error phrases.
    expect(
      isAbnormalTermination({ output: "Agent terminated early due to an API error" }),
    ).toBe(true);
    expect(
      isAbnormalTermination({ output: "API Error: Response stalled mid-stream" }),
    ).toBe(true);
  });

  it("never classifies a successful final report as abnormal (issue #3663 B6)", () => {
    // Explicit success wins even when the report mentions an API-error phrase.
    expect(
      isAbnormalTermination({
        success: true,
        output: "The parser now quotes \"Agent terminated early due to an API error\" correctly.",
      }),
    ).toBe(false);
    // Unanchored diagnostic phrases in prose (success omitted) are NOT
    // structured failure envelopes and must not classify failure.
    expect(
      isAbnormalTermination({
        output: "Final report: the fix covers \"Response stalled mid-stream\" handling and <status>failed</status> quoting in docs.",
      }),
    ).toBe(false);
    expect(
      isAbnormalTermination({
        output: "Mid-line <status>failed</status> mention is not an envelope.",
      }),
    ).toBe(false);
  });

  it("treats normal completion and cancel-like stops as non-abnormal", () => {
    expect(isAbnormalTermination({})).toBe(false);
    expect(isAbnormalTermination({ success: true, output: "done" })).toBe(false);
    expect(
      isAbnormalTermination({ output: "Interrupted by user — cancelling task" }),
    ).toBe(false);
    expect(isAbnormalTermination({ output: "" })).toBe(false);
  });
});
