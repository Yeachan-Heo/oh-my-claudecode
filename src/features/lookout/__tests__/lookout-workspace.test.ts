/** Lookout workspace and briefing-file boundary tests. */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import { LookoutError, scanLookout } from "../index.js";

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "omc-lookout-"));
  tempDirs.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "init"]);
  writeFileSync(join(dir, "base.txt"), "v1\n");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add base"]);
  return dir;
}

function ids(findings: { id: string }[]): string[] {
  return findings.map((f) => f.id);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("scanLookout: workspace rules", () => {
  it("flags a dirty worktree as low severity with checkpoint advice", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.txt"), "v2\n");
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    const finding = report.findings.find((f) => f.id === "lookout.ws.dirty-worktree");
    expect(finding?.severity).toBe("low");
    expect(finding?.evidence).toContain(" M base.txt");
    expect(finding?.advice).toContain("omc checkpoint create");
    expect(report.summary.verdict).toBe("advisory"); // low findings are not "clear"
  });

  it("flags tracked secret-looking files", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    git(dir, ["add", ".env"]);
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add env"]);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    const finding = report.findings.find((f) => f.id === "lookout.ws.secrets-present");
    expect(finding?.severity).toBe("medium");
    expect(finding?.evidence).toContain(".env");
  });

  it("flags tracked secret paths under non-ASCII directories", () => {
    const dir = makeRepo();
    const nested = join(dir, "秘密");
    mkdirSync(nested);
    writeFileSync(join(nested, ".env"), "SECRET=1\n");
    git(dir, ["add", "."]);
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add nested env"]);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(report.findings.find((finding) => finding.id === "lookout.ws.secrets-present")?.evidence).toContain(
      "秘密/.env",
    );
  });

  it("does not trim tracked paths before classifying them", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, " .env"), "placeholder\n");
    git(dir, ["add", "."]);
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add leading-space file"]);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(ids(report.findings)).not.toContain("lookout.ws.secrets-present");
  });

  it("does not flag environment templates as secrets", () => {
    const dir = makeRepo();
    for (const name of [".env.example", ".env.local.example", ".env.production.template", ".env.dist"]) {
      writeFileSync(join(dir, name), "API_KEY=placeholder\n");
      git(dir, ["add", name]);
    }
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add env templates"]);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(ids(report.findings)).not.toContain("lookout.ws.secrets-present");
  });

  it("still flags environment-specific files without a template suffix", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, ".env.local"), "SECRET=1\n");
    git(dir, ["add", ".env.local"]);
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add env"]);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(ids(report.findings)).toContain("lookout.ws.secrets-present");
  });

  it("fails closed with exit code 2 for a nonexistent repository path", () => {
    try {
      scanLookout({ repo: "/nonexistent/omc-lookout-path", now: new Date("2026-09-08T00:00:00Z") });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LookoutError);
      expect((error as LookoutError).exitCode).toBe(2);
    }
  });

  it("reports a null repo outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "omc-lookout-nogit-"));
    tempDirs.push(dir);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(report.repo).toBeNull();
    expect(report.findings).toEqual([]);
  });

  it("preserves a repository root that ends with whitespace", () => {
    const parent = mkdtempSync(join(tmpdir(), "omc-lookout-root-"));
    tempDirs.push(parent);
    const dir = join(parent, "repo ");
    mkdirSync(dir);
    git(dir, ["init", "-q"]);
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "init"]);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(report.repo).toBe(realpathSync(dir));
  });

  it("fails closed on a broken repository instead of reporting clear", () => {
    // A .git file pointing at a missing gitdir makes git emit the same
    // "not a git repository" stderr as a plain directory — but a repository
    // exists here, so silence would hide an unreadable state.
    const dir = mkdtempSync(join(tmpdir(), "omc-lookout-broken-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, ".git"), "gitdir: /nonexistent/omc-lookout-gitdir\n");
    try {
      scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LookoutError);
      expect((error as LookoutError).exitCode).toBe(2);
    }
  });

  it.skipIf(process.platform === "win32")("fails closed on a dangling .git symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "omc-lookout-dangling-"));
    tempDirs.push(dir);
    symlinkSync(join(dir, "missing-gitdir"), join(dir, ".git"));
    try {
      scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LookoutError);
      expect((error as LookoutError).exitCode).toBe(2);
    }
  });

  it("overrides status.showUntrackedFiles=no when listing workspace changes", () => {
    const dir = makeRepo();
    git(dir, ["config", "status.showUntrackedFiles", "no"]);
    writeFileSync(join(dir, "untracked.txt"), "pending\n");
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(ids(report.findings)).toContain("lookout.ws.dirty-worktree");
  });

  it("ignores inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE when selecting --repo", () => {
    const withSecret = makeRepo();
    writeFileSync(join(withSecret, ".env"), "SECRET=1\n");
    git(withSecret, ["add", ".env"]);
    git(withSecret, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add env"]);
    const clean = makeRepo();
    // Compute the expected toplevel BEFORE the selection variables are
    // exported: the bare helper below does not sanitize them, and a
    // GIT_DIR-inherited rev-parse would return the wrong repo here too.
    const cleanTop = git(clean, ["rev-parse", "--show-toplevel"]);

    const saved = { ...process.env };
    try {
      process.env.GIT_DIR = join(withSecret, ".git");
      process.env.GIT_WORK_TREE = withSecret;
      process.env.GIT_COMMON_DIR = join(withSecret, "missing-common");
      process.env.GIT_OBJECT_DIRECTORY = join(withSecret, "missing-objects");
      // --repo points at the clean repo; inherited variables point at the
      // secret-bearing one. The scan must follow --repo.
      const report = scanLookout({ repo: clean, now: new Date("2026-09-08T00:00:00Z") });
      expect(report.repo).toBe(cleanTop);
      expect(ids(report.findings)).not.toContain("lookout.ws.secrets-present");
      // ...and the explicitly selected repo is scanned correctly.
      const direct = scanLookout({ repo: withSecret, now: new Date("2026-09-08T00:00:00Z") });
      expect(ids(direct.findings)).toContain("lookout.ws.secrets-present");
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it.skipIf(process.platform === "win32")("disables fsmonitor during scans", () => {
    const dir = makeRepo();
    const marker = join(dir, "fsmonitor-marker");
    const hook = join(dir, "fsmonitor-hook.cjs");
    writeFileSync(
      hook,
      "require('node:fs').appendFileSync(process.argv[2], 'x'); process.stdout.write('');",
    );
    git(dir, [
      "config",
      "core.fsmonitor",
      `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)} ${JSON.stringify(marker)}`,
    ]);

    scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(hook)).toBe(true);
  });
});

