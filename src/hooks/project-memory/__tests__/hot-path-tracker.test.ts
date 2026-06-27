/**
 * Tests for the Hot Path Tracker scope-affinity ranking.
 */

import { describe, it, expect } from "vitest";
import { getTopHotPaths, trackAccess } from "../hot-path-tracker.js";
import { HotPath, ProjectMemoryContext } from "../types.js";

const NOW = Date.parse("2026-03-24T15:00:00Z");

function hotPath(path: string, accessCount: number): HotPath {
  return { path, accessCount, lastAccessed: NOW, type: "file" };
}

describe("getTopHotPaths scope affinity", () => {
  it("boosts a hot path inside the working scope when stored with Windows separators", () => {
    // trackAccess() stores hp.path from path.relative(), which returns backslash
    // separators on Windows (e.g. "src\\app\\index.ts"), while normalizeScopePath()
    // converts the working directory to forward slashes. Before the fix the two
    // never matched on Windows, so scope affinity scored 0 and the in-scope file
    // lost to a more-accessed out-of-scope file. Asserts on literal strings, so it
    // runs and guards on every OS (the separator normalization is a no-op on POSIX).
    const inScope = hotPath("src\\app\\index.ts", 3); // fewer accesses...
    const outOfScope = hotPath("docs\\guide.md", 5); // ...but more accesses

    const context: ProjectMemoryContext = {
      workingDirectory: "src/app",
      now: NOW,
    };

    const top = getTopHotPaths([outOfScope, inScope], 10, context);

    // With scope affinity working, the in-scope file outranks the more-accessed
    // out-of-scope file. Before the fix both scored 0 affinity, so the
    // out-of-scope file (higher access count) ranked first.
    expect(top[0].path).toBe("src\\app\\index.ts");
  });

  it("ranks identically whether the in-scope path uses POSIX or Windows separators", () => {
    const posix = getTopHotPaths(
      [hotPath("docs/guide.md", 5), hotPath("src/app/index.ts", 3)],
      10,
      { workingDirectory: "src/app", now: NOW },
    );
    const windows = getTopHotPaths(
      [hotPath("docs\\guide.md", 5), hotPath("src\\app\\index.ts", 3)],
      10,
      { workingDirectory: "src/app", now: NOW },
    );

    expect(posix[0].path).toBe("src/app/index.ts");
    expect(windows[0].path).toBe("src\\app\\index.ts");
  });
});

describe("trackAccess separator normalization", () => {
  it("stores hot paths with forward slashes when given Windows separators", () => {
    // A relative path with backslashes (as produced by path.relative() on
    // Windows) must be stored with forward slashes so the persisted data and
    // the scope-affinity comparison stay consistent across operating systems.
    // The input is not absolute, so this takes the same branch on every OS and
    // asserts deterministically.
    const result = trackAccess([], "src\\app\\index.ts", "/repo", "file");

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/app/index.ts");
  });
});
