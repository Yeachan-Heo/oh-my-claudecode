/**
 * Lockfile contract for better-sqlite3 Node compatibility (issue #3872).
 *
 * better-sqlite3 12.6.2 (the previously locked resolution) ships no prebuilt
 * binary for Node 26 (module ABI 147) and its source fails to compile there
 * (`v8::PropertyCallbackInfo<v8::Value>` has no member named `This`). Because
 * the plugin install path installs from the repo tree, the committed
 * package-lock.json is what plugin users get: a stale pin silently disables
 * the SQLite-backed job state and prompt persistence on Node 26.
 *
 * First Node-26-capable release is 12.10.0 (engines add `26.x`; prebuilds
 * include node-v147). This contract fails when either surface regresses:
 *
 * 1. package.json floor drops below the Node-26-capable minimum
 *    (fresh lockfile regeneration could re-resolve an incompatible version).
 * 2. The committed lockfile resolves better-sqlite3 outside the declared
 *    package.json range, or below the Node-26-capable minimum.
 * 3. The locked version does not declare support for the Node major this
 *    check runs on (guards CI matrices against silent engine exclusions).
 *
 * Prebuild availability itself is registry-side and deliberately not fetched
 * here; the engines assertion is the deterministic local proxy — WiseLibs
 * gates engines and prebuild targets on the same Node-major set.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** First better-sqlite3 release whose engines include Node 26 and that ships node-v147 prebuilds. */
const NODE_26_CAPABLE_FLOOR = "12.10.0";

const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(REPO_ROOT, relativePath), "utf8")) as Record<string, unknown>;

const readManifest = (): { deps: Record<string, string>; engines: string } => {
  const pkg = readJson("package.json") as {
    dependencies?: Record<string, string>;
    engines?: Record<string, string>;
  };
  return {
    deps: pkg.dependencies ?? {},
    engines: pkg.engines?.node ?? "",
  };
};

const readLocked = (): { version: string; engines: string } => {
  const lock = readJson("package-lock.json") as {
    packages?: Record<string, { version?: string; engines?: Record<string, string> }>;
  };
  const entry = lock.packages?.["node_modules/better-sqlite3"];
  if (!entry?.version) {
    throw new Error("node_modules/better-sqlite3 missing from package-lock.json packages map");
  }
  return { version: entry.version, engines: entry.engines?.node ?? "" };
};

/** `>=X.Y.Z` lower bound of a caret/caret-equivalent range, e.g. `^12.10.0` -> `12.10.0`. */
const floorOf = (range: string): string => {
  const match = /^\^?(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!match) {
    throw new Error(`Unsupported better-sqlite3 range shape: ${range}`);
  }
  return match.slice(1).join(".");
};

/** True when `version` is semver-greater than or equal to `minimum` (major.minor.patch only). */
const gte = (version: string, minimum: string): boolean => {
  const [vMaj, vMin, vPatch] = version.split(".").map(Number);
  const [mMaj, mMin, mPatch] = minimum.split(".").map(Number);
  if (vMaj !== mMaj) return vMaj > mMaj;
  if (vMin !== mMin) return vMin > mMin;
  return vPatch >= mPatch;
};

/** True when a version satisfies the caret range shape used by this dependency. */
const satisfiesDeclaredRange = (version: string, range: string): boolean => {
  const floor = floorOf(range);
  const [versionMajor] = version.split(".").map(Number);
  const [floorMajor] = floor.split(".").map(Number);
  return versionMajor === floorMajor && gte(version, floor);
};

/** Node majors better-sqlite3 upstream supports within the current semver major (odd majors are upstream-supported non-LTS lines, e.g. 23.x). */
const SUPPORTED_NODE_MAJORS = [20, 22, 23, 24, 25, 26] as const;

describe("better-sqlite3 lockfile contract (issue #3872)", () => {
  it("declares a Node-26-capable floor in package.json", () => {
    const { deps } = readManifest();
    const range = deps["better-sqlite3"];
    if (!range) throw new Error("better-sqlite3 missing from package.json dependencies");
    expect(gte(floorOf(range), NODE_26_CAPABLE_FLOOR)).toBe(true);
  });

  it("resolves a Node-26-capable version in the committed lockfile", () => {
    const { deps } = readManifest();
    const locked = readLocked();
    expect(gte(locked.version, NODE_26_CAPABLE_FLOOR)).toBe(true);
    // Lock resolution must satisfy the complete declared caret range.
    expect(satisfiesDeclaredRange(locked.version, deps["better-sqlite3"])).toBe(true);
  });

  it("rejects a locked version below the declared caret floor", () => {
    expect(satisfiesDeclaredRange("12.11.1", "^12.12.0")).toBe(false);
    expect(satisfiesDeclaredRange("13.0.0", "^12.10.0")).toBe(false);
  });

  it("locked engines cover every upstream-supported Node major", () => {
    const locked = readLocked();
    for (const major of SUPPORTED_NODE_MAJORS) {
      expect(locked.engines).toContain(`${major}.x`);
    }
  });

  it("locked engines cover the Node major running this check", () => {
    const locked = readLocked();
    const major = process.versions.node.split(".")[0];
    expect(locked.engines).toContain(`${major}.x`);
  });

  it("manifest and lockfile expose the same supported Node majors", () => {
    expect(readManifest().engines).toBe(readLocked().engines);
  });
});
