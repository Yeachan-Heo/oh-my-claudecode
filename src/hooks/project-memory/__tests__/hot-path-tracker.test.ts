/**
 * Tests for the Hot Path Tracker scope-affinity ranking.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
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

describe("hot paths follow the current work", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const ROOT = "/repo";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seed(count: number, accessCount: number, lastAccessed: number): HotPath[] {
    return Array.from({ length: count }, (_, i) => ({
      path: `src/old-${i}.ts`,
      accessCount,
      lastAccessed,
      type: "file" as const,
    }));
  }

  function workOn(hotPaths: HotPath[], files: string[], at: number, passes = 4): HotPath[] {
    vi.setSystemTime(at);
    for (let pass = 0; pass < passes; pass++) {
      for (const file of files) {
        hotPaths = trackAccess(hotPaths, `${ROOT}/${file}`, ROOT, "file");
      }
    }
    return hotPaths;
  }

  const topPaths = (hotPaths: HotPath[], now: number) =>
    getTopHotPaths(hotPaths, 3, { now }).map((hp) => hp.path).sort();

  it("keeps a newly touched file when the list is full of entries touched more often today", () => {
    const hotPaths = workOn(seed(50, 4, NOW), ["src/late.ts"], NOW, 1);

    expect(hotPaths).toHaveLength(50);
    expect(hotPaths.map((hp) => hp.path)).toContain("src/late.ts");
  });

  it("keeps every new file touched in the same millisecond on a full list", () => {
    const newArea = ["src/b/one.ts", "src/b/two.ts", "src/b/three.ts"];
    const hotPaths = workOn(seed(50, 1, NOW), newArea, NOW, 1);

    expect(hotPaths.map((hp) => hp.path)).toEqual(expect.arrayContaining(newArea));
  });

  it("lets several new files build up counts while the list is full of recent heavy entries", () => {
    const newArea = ["src/b/one.ts", "src/b/two.ts", "src/b/three.ts"];
    const hotPaths = workOn(seed(50, 56, NOW - 2 * DAY), newArea, NOW);

    const counts = newArea.map((file) => hotPaths.find((hp) => hp.path === file)?.accessCount);
    expect(counts).toEqual([4, 4, 4]);
  });

  it("keeps decaying a count that is touched every hour", () => {
    let hotPaths: HotPath[] = [];
    for (let hour = 0; hour < 24; hour++) {
      hotPaths = workOn(hotPaths, ["src/hourly.ts"], NOW + hour * HOUR, 1);
    }

    const expected = Array.from({ length: 24 }, (_, age) => 0.5 ** (age / 24)).reduce((a, b) => a + b);
    expect(hotPaths[0].accessCount).toBeCloseTo(expected, 6);
  });

  it("does not let one touch revive a count built weeks ago", () => {
    let hotPaths = seed(1, 1000, NOW - 30 * DAY);
    hotPaths = workOn(hotPaths, ["src/today.ts"], NOW, 8);
    hotPaths = workOn(hotPaths, ["src/old-0.ts"], NOW, 1);

    const [first] = getTopHotPaths(hotPaths, 1, { now: NOW });
    expect(first.path).toBe("src/today.ts");
  });

  it("shows the new work area within two days of switching from a heavily used one", () => {
    const oldArea = ["src/a/one.ts", "src/a/two.ts", "src/a/three.ts"];
    const newArea = ["src/b/one.ts", "src/b/two.ts", "src/b/three.ts"];
    let hotPaths: HotPath[] = [];
    for (let day = 0; day < 14; day++) {
      hotPaths = workOn(hotPaths, oldArea, NOW + day * DAY, 40);
    }
    for (let day = 14; day < 16; day++) {
      hotPaths = workOn(hotPaths, newArea, NOW + day * DAY, 40);
    }

    expect(topPaths(hotPaths, NOW + 16 * DAY)).toEqual([...newArea].sort());
  });
});
