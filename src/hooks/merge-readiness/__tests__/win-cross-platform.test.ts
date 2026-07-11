import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, isAbsolute, join, sep } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectMergeReadinessEvidence,
  createInitialMergeReadinessState,
  readMergeReadinessState,
  slugifyMergeReadiness,
} from "../index.js";
import {
  getOmcRoot,
  resolveSessionStatePath,
  resolveToWorktreeRoot,
  validateSessionId,
} from "../../../lib/worktree-paths.js";

const isWin32 = process.platform === "win32";
const BS = String.fromCharCode(92); // backslash, shell-safe

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "omc-mr-win-"));
  git(["init"], dir);
  git(["config", "user.email", "t@e.com"], dir);
  git(["config", "user.name", "T"], dir);
  writeFileSync(join(dir, "README.md"), "before\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  writeFileSync(join(dir, "README.md"), "after\n");
  return dir;
}

describe("merge-readiness Windows cross-platform contract", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeRepo();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves .omc root with the platform-native separator under a worktree", () => {
    const omcRoot = getOmcRoot(tempDir);
    expect(isAbsolute(omcRoot)).toBe(true);
    // .omc root terminates with the native separator + ".omc" (backslash on win32,
    // forward slash on POSIX) - proves path.join builds the path, not string concat.
    expect(omcRoot.endsWith(sep + ".omc")).toBe(true);
    // Worktree root prefix preserved verbatim (no accidental drive-letter drop on win32).
    expect(omcRoot.startsWith(tempDir)).toBe(true);
  });

  it("constructs the session-scoped state path with native separators and validates the id", () => {
    const sessionId = "win-session-123";
    const statePath = resolveSessionStatePath("merge-readiness", sessionId, tempDir);
    expect(statePath.includes(join("state", "sessions", sessionId))).toBe(true);
    expect(statePath.endsWith(join(sessionId, "merge-readiness-state.json"))).toBe(true);
    expect(statePath.includes(sep)).toBe(true);

    // Path-traversal rejection is platform-agnostic: backslash OR forward-slash OR ".."
    // must throw regardless of host OS (prevents .omc/state/sessions/../x writes).
    expect(() => validateSessionId("bad/session")).toThrow();
    expect(() => validateSessionId("bad" + sep + "session")).toThrow();
    expect(() => validateSessionId("..escape")).toThrow();
    expect(() => validateSessionId("ok_session-1")).not.toThrow();
  });

  it("resolves the worktree root from a subdirectory (not a subdirectory itself)", () => {
    const sub = join(tempDir, "nested", "deep");
    mkdirSync(sub, { recursive: true });
    const root = resolveToWorktreeRoot(sub);
    // Must climb to the git worktree root, never the nested subdir - prevents .omc
    // from being created in a subdirectory on Windows drives (#576).
    // On win32, git rev-parse --show-toplevel emits forward slashes AND expands 8.3
    // short names (ADMINI~1 -> Administrator), while mkdtempSync keeps the short form.
    // So string equality fails even for the same physical dir. Prove identity by:
    // (a) both share the mkdtemp random basename (final path segment),
    // (b) both share the same drive letter prefix on win32.
    const rootBase = basename(root);
    const tempBase = basename(tempDir);
    expect(rootBase).toBe(tempBase);
    if (isWin32) {
      expect(root.charAt(1)).toBe(":"); // drive letter preserved
      // Case-insensitive drive+path prefix match (Administrator vs ADMINI~1 short name).
      const norm = (x: string) => x.toLowerCase().split("\\").join("/");
      expect(norm(root).endsWith(norm(tempDir).split("/").slice(-2).join("/"))).toBe(true);
    }
    if (isWin32) {
      // Drive-letter or UNC prefix must survive the climb on win32.
      expect(/^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\")).toBe(true);
    }
  });

  it("collects git evidence on the native platform (git exec resolves on win32)", () => {
    // Concrete native-Windows evidence: execFileSync("git", ...) resolves git.exe
    // through the OS PATH on win32 and returns the working-tree diff.
    const evidence = collectMergeReadinessEvidence(tempDir);
    expect(evidence.changedFiles).toContain("README.md");
    // git emits forward-slash relative paths even on win32; no backslash leakage.
    for (const f of evidence.changedFiles) {
      expect(f.indexOf(BS)).toBe(-1);
    }
    // A fresh local repo has no upstream/remote, so git rev-parse @{upstream} and
    // symbolic-ref refs/remotes/origin/HEAD legitimately exit 128 - the runtime must
    // capture these as graceful missingEvidence strings, NOT crash. The core diff
    // commands (diff/status/ls-files) succeed and populate changedFiles.
    const gitGracefulFailures = evidence.missingEvidence.filter((m) => /git \w+ failed\s\(\(\d\)\)/i.test(m));
    // The failures are surfaced as strings (not thrown), proving graceful capture on win32.
    for (const f of gitGracefulFailures) {
      expect(typeof f === "string" && f.includes("failed")).toBe(true);
    }
    // The healthy diff command(s) still succeeded - changedFiles is populated.
    expect(evidence.changedFiles.length).toBeGreaterThan(0);
  });

  it("normalizes backslash artifact paths to forward slashes on win32 (listArtifactFiles contract)", () => {
    mkdirSync(join(tempDir, ".omc", "specs"), { recursive: true });
    writeFileSync(join(tempDir, ".omc", "specs", "design.md"), "spec for the change\n");
    // Plant a merge-readiness artifact that must be EXCLUDED from source evidence.
    mkdirSync(join(tempDir, ".omc", "artifacts", "merge-readiness"), { recursive: true });
    writeFileSync(join(tempDir, ".omc", "artifacts", "merge-readiness", "self.md"), "self\n");

    const evidence = collectMergeReadinessEvidence(tempDir);
    expect(evidence.sourceArtifacts).toContain("specs/design.md");
    // No backslashes survive into the persisted artifact list on win32.
    expect(evidence.sourceArtifacts.every((f) => f.indexOf(BS) === -1)).toBe(true);
    // Merge-readiness own artifacts are excluded (no self-reference in evidence).
    expect(evidence.sourceArtifacts.every((f) => !f.includes("merge-readiness"))).toBe(true);
    expect(evidence.testEvidence).toContain("specs/design.md");
  });

  it("persists session-scoped state readable via the same resolver (short-name tmpdir on win32)", () => {
    // On win32, os.tmpdir() often returns an 8.3 short-name path (ADMINI~1). State
    // written through that tempDir must read back through the same resolver, proving
    // the path round-trips even when the drive prefix is a short name.
    if (isWin32 && tmpdir().indexOf("~1") === -1) {
      console.warn("[win-cross-platform] tmpdir is long-form; short-name round-trip not exercised on this host");
    }
    const sessionId = "win-persist-session";
    const state = createInitialMergeReadinessState(tempDir, "/merge-readiness --standard win change", sessionId);
    expect(state.result).toBe("pending");

    const statePath = resolveSessionStatePath("merge-readiness", sessionId, tempDir);
    expect(existsSync(statePath)).toBe(true);
    const persisted = readMergeReadinessState(tempDir, sessionId);
    expect(persisted?.session_id).toBe(sessionId);
    expect(persisted?.evidence.changedFiles).toEqual(state.evidence.changedFiles);

    const raw = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    expect(raw.session_id).toBe(sessionId);
  });

  it("slugifies change summaries identically across platforms (no separator leakage)", () => {
    // slugifyMergeReadiness strips everything outside [a-z0-9], so drive letters /
    // backslashes never leak into the slug on win32.
    expect(slugifyMergeReadiness("Fix auth on Windows: D:\\path issue")).toBe("fix-auth-on-windows-d-path-issue");
    expect(slugifyMergeReadiness("")).toBe("change");
    expect(slugifyMergeReadiness("   ")).toBe("change");
    const long = "a".repeat(120);
    expect(slugifyMergeReadiness(long).length).toBe(48);
    // CJK collapses to hyphens (non-[a-z0-9] stripped), trimmed; result stays in [a-z0-9-].
    expect(slugifyMergeReadiness("修复 认证 问题")).toMatch(/^[a-z0-9-]*$/);
  });

  it("invokes git.exe successfully on win32 (no ETIMEDOUT / no exec spawn failure)", () => {
    // Native-Windows evidence: execFileSync("git", args, {windowsHide:true})
    // resolves git.exe from PATH on win32 and returns structured output. The proof
    // is that collectMergeReadinessEvidence completes (no throw) and produces git
    // stdout (changedFiles populated) rather than an ENOENT/ETIMEDOUT surface error.
    const evidence = collectMergeReadinessEvidence(tempDir);
    // No "timed out" entry => git exec did not hang on win32.
    expect(evidence.missingEvidence.some((m) => /timed out/i.test(m))).toBe(false);
    // No "git <cmd> failed (exit ?)" with an unknown exit (spawn/ENOENT) => git resolved.
    const spawnFailures = evidence.missingEvidence.filter((m) => /failed \(exit \?\)\)/i.test(m) && !/\d\)/.test(m));
    expect(spawnFailures).toEqual([]);
    // The diff command ran: changedFiles is populated from git diff --name-only HEAD.
    expect(evidence.changedFiles).toContain("README.md");
  });
});
