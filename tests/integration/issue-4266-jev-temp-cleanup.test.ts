/** Temp directory cleanup for jev-shadow and jev-resolve (issue #4266). */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const JEVRESOLVE_PATH = join(PROJECT_ROOT, "scripts/jev-resolve.mjs");
const JEV_SHADOW_URL = pathToFileURL(
  join(PROJECT_ROOT, "scripts/lib/jev-shadow.mjs"),
).href;

function runResolver(requestFile: string) {
  return spawnSync(
    process.execPath,
    [JEVRESOLVE_PATH, "--request-file", requestFile],
    {
      env: { ...process.env, OMC_JEV: "off" },
      encoding: "utf8",
    },
  );
}

function runActiveRecord(tempRoot: string, homeRoot: string) {
  const script = `
    import { recordJevShadow } from ${JSON.stringify(JEV_SHADOW_URL)};
    const result = recordJevShadow({
      point: "cleanup-test",
      state: {},
      questions: {},
      heuristic: "test",
    });
    console.log(JSON.stringify({ result }));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOME: homeRoot,
      USERPROFILE: homeRoot,
      TMPDIR: tempRoot,
      TMP: tempRoot,
      TEMP: tempRoot,
      OMC_JEV: "cleanup-test:active",
      TYPESAFE_API_KEY: "test-key",
      OMC_JEV_ENDPOINT: "http://127.0.0.1:1",
      OMC_JEV_TIMEOUT_MS: "100",
      OMC_JEV_LOG_DIR: join(homeRoot, "logs"),
    },
    encoding: "utf8",
    timeout: 5000,
  });
}

describe("issue #4266: Jev temp directory cleanup", () => {
  it("removes the generated temp directory after reading a request", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omc-jev-"));
    try {
      const requestFile = join(tempDir, "request.json");
      writeFileSync(
        requestFile,
        JSON.stringify({ point: "test", state: {}, questions: {} }),
      );

      const result = runResolver(requestFile);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ mode: "off" });
      expect(existsSync(tempDir)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("removes its temp directory after a request read or parse failure", () => {
    for (const contents of [undefined, "invalid json"]) {
      const tempDir = mkdtempSync(join(tmpdir(), "omc-jev-"));
      try {
        const requestFile = join(tempDir, "request.json");
        if (contents !== undefined) writeFileSync(requestFile, contents);

        const result = runResolver(requestFile);

        expect(result.status).toBe(0);
        expect(existsSync(tempDir)).toBe(false);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("only removes the request file outside the temp root", () => {
    const parent = mkdtempSync(join(tmpdir(), "issue-4266-parent-"));
    const nested = join(parent, "omc-jev-cache");
    mkdirSync(nested);
    const requestFile = join(nested, "request.json");
    const siblingFile = join(nested, "unrelated.txt");
    writeFileSync(
      requestFile,
      JSON.stringify({ point: "test", state: {}, questions: {} }),
    );
    writeFileSync(siblingFile, "keep");

    try {
      const result = runResolver(requestFile);

      expect(result.status).toBe(0);
      expect(existsSync(nested)).toBe(true);
      expect(existsSync(requestFile)).toBe(false);
      expect(existsSync(siblingFile)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("sweeps stale request dirs and preserves unrelated temp entries", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "issue-4266-"));
    const tempRoot = join(testRoot, "tmp");
    const homeRoot = join(testRoot, "home");
    mkdirSync(tempRoot, { mode: 0o700 });
    mkdirSync(homeRoot, { mode: 0o700 });
    const staleDir = mkdtempSync(join(tempRoot, "omc-jev-"));
    writeFileSync(join(staleDir, "request.json"), "{}");
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(staleDir, oldTime, oldTime);

    const unrelatedDir = mkdtempSync(join(tempRoot, "omc-jev-"));
    const unrelatedFile = join(unrelatedDir, "notes.txt");
    writeFileSync(unrelatedFile, "keep");
    utimesSync(unrelatedDir, oldTime, oldTime);

    const freshDir = mkdtempSync(join(tempRoot, "omc-jev-"));
    const freshRequest = join(freshDir, "request.json");
    writeFileSync(freshRequest, "{}");

    const sharedTmpMarker = join(tempRoot, ".omc-jev-sweep-throttle");
    const victimPath = join(homeRoot, "victim");
    let createdSymlink = false;
    if (process.platform !== "win32") {
      symlinkSync(victimPath, sharedTmpMarker);
      createdSymlink = true;
    }

    try {
      const result = runActiveRecord(tempRoot, homeRoot);
      const privateMarker = join(
        homeRoot,
        ".omc",
        "state",
        ".jev-sweep-throttle",
      );
      const canVerifyTempOwnership = typeof process.getuid === "function";

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).result.mode).toBe("degraded");
      expect(existsSync(staleDir)).toBe(!canVerifyTempOwnership);
      expect(existsSync(unrelatedDir)).toBe(true);
      expect(existsSync(unrelatedFile)).toBe(true);
      expect(existsSync(freshDir)).toBe(true);
      expect(existsSync(freshRequest)).toBe(true);
      expect(existsSync(privateMarker)).toBe(true);
      expect(existsSync(victimPath)).toBe(false);
      expect(
        readdirSync(tempRoot).filter((entry) => entry.startsWith("omc-jev-")),
      ).toHaveLength(canVerifyTempOwnership ? 2 : 3);
      if (createdSymlink)
        expect(lstatSync(sharedTmpMarker).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("skips a sweep when the cross-process marker is recent", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "issue-4266-throttled-"));
    const tempRoot = join(testRoot, "tmp");
    const homeRoot = join(testRoot, "home");
    const stateDir = join(homeRoot, ".omc", "state");
    mkdirSync(tempRoot, { mode: 0o700 });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const markerPath = join(stateDir, ".jev-sweep-throttle");
    writeFileSync(markerPath, "recent");
    const recentTime = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(markerPath, recentTime, recentTime);

    const staleDir = mkdtempSync(join(tempRoot, "omc-jev-"));
    writeFileSync(join(staleDir, "request.json"), "{}");
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(staleDir, oldTime, oldTime);

    try {
      const result = runActiveRecord(tempRoot, homeRoot);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).result.mode).toBe("degraded");
      expect(existsSync(staleDir)).toBe(true);
      expect(Date.now() - lstatSync(markerPath).mtimeMs).toBeGreaterThan(
        9 * 60 * 1000,
      );
      const lockBucket = Math.floor(Date.now() / (60 * 60 * 1000));
      expect(
        existsSync(join(stateDir, `.jev-sweep-throttle.lock-${lockBucket}`)),
      ).toBe(false);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("skips a duplicate sweep while another process holds the throttle lock", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "issue-4266-locked-"));
    const tempRoot = join(testRoot, "tmp");
    const homeRoot = join(testRoot, "home");
    const stateDir = join(homeRoot, ".omc", "state");
    mkdirSync(tempRoot, { mode: 0o700 });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const lockBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    const lockPath = join(stateDir, `.jev-sweep-throttle.lock-${lockBucket}`);
    writeFileSync(lockPath, "held");

    const staleDir = mkdtempSync(join(tempRoot, "omc-jev-"));
    writeFileSync(join(staleDir, "request.json"), "{}");
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(staleDir, oldTime, oldTime);

    try {
      const result = runActiveRecord(tempRoot, homeRoot);
      const privateMarker = join(stateDir, ".jev-sweep-throttle");

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).result.mode).toBe("degraded");
      expect(existsSync(staleDir)).toBe(true);
      expect(existsSync(privateMarker)).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("keeps the prior hour lock active across a bucket boundary", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "issue-4266-rollover-"));
    const tempRoot = join(testRoot, "tmp");
    const homeRoot = join(testRoot, "home");
    const stateDir = join(homeRoot, ".omc", "state");
    mkdirSync(tempRoot, { mode: 0o700 });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const currentBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    const previousLock = join(
      stateDir,
      `.jev-sweep-throttle.lock-${currentBucket - 1}`,
    );
    const currentLock = join(
      stateDir,
      `.jev-sweep-throttle.lock-${currentBucket}`,
    );
    writeFileSync(previousLock, String(process.pid));

    const markerPath = join(stateDir, ".jev-sweep-throttle");
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    writeFileSync(markerPath, "expired");
    utimesSync(markerPath, oldTime, oldTime);

    const staleDir = mkdtempSync(join(tempRoot, "omc-jev-"));
    writeFileSync(join(staleDir, "request.json"), "{}");
    utimesSync(staleDir, oldTime, oldTime);

    try {
      const result = runActiveRecord(tempRoot, homeRoot);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).result.mode).toBe("degraded");
      expect(existsSync(staleDir)).toBe(true);
      expect(existsSync(currentLock)).toBe(false);
      expect(existsSync(previousLock)).toBe(true);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("continues sweeping when the prior hour lock owner has exited", () => {
    const exitedOwner = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(exitedOwner.status).toBe(0);

    const testRoot = mkdtempSync(join(tmpdir(), "issue-4266-dead-lock-"));
    const tempRoot = join(testRoot, "tmp");
    const homeRoot = join(testRoot, "home");
    const stateDir = join(homeRoot, ".omc", "state");
    mkdirSync(tempRoot, { mode: 0o700 });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    const currentBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    const previousLock = join(
      stateDir,
      `.jev-sweep-throttle.lock-${currentBucket - 1}`,
    );
    const currentLock = join(
      stateDir,
      `.jev-sweep-throttle.lock-${currentBucket}`,
    );
    writeFileSync(previousLock, String(exitedOwner.pid));

    const markerPath = join(stateDir, ".jev-sweep-throttle");
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    writeFileSync(markerPath, "expired");
    utimesSync(markerPath, oldTime, oldTime);

    const staleDir = mkdtempSync(join(tempRoot, "omc-jev-"));
    writeFileSync(join(staleDir, "request.json"), "{}");
    utimesSync(staleDir, oldTime, oldTime);

    try {
      const result = runActiveRecord(tempRoot, homeRoot);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).result.mode).toBe("degraded");
      expect(lstatSync(markerPath).mtimeMs).toBeGreaterThan(oldTime.getTime());
      expect(existsSync(staleDir)).toBe(typeof process.getuid !== "function");
      expect(existsSync(currentLock)).toBe(false);
      expect(existsSync(previousLock)).toBe(true);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("rolls past abandoned hourly locks left by crashed processes", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "issue-4266-stale-lock-"));
    const tempRoot = join(testRoot, "tmp");
    const homeRoot = join(testRoot, "home");
    const stateDir = join(homeRoot, ".omc", "state");
    mkdirSync(tempRoot, { mode: 0o700 });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, ".jev-sweep-throttle"), "expired");
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(join(stateDir, ".jev-sweep-throttle"), oldTime, oldTime);
    const currentBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    const staleLockPath = join(
      stateDir,
      `.jev-sweep-throttle.lock-${currentBucket - 48}`,
    );
    const currentLockPath = join(
      stateDir,
      `.jev-sweep-throttle.lock-${currentBucket}`,
    );
    writeFileSync(staleLockPath, "stale");
    utimesSync(staleLockPath, oldTime, oldTime);

    const staleDir = mkdtempSync(join(tempRoot, "omc-jev-"));
    writeFileSync(join(staleDir, "request.json"), "{}");
    const staleRequestTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(staleDir, staleRequestTime, staleRequestTime);

    try {
      const result = runActiveRecord(tempRoot, homeRoot);
      const privateMarker = join(stateDir, ".jev-sweep-throttle");

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).result.mode).toBe("degraded");
      expect(existsSync(staleDir)).toBe(typeof process.getuid !== "function");
      expect(existsSync(privateMarker)).toBe(true);
      expect(existsSync(staleLockPath)).toBe(false);
      expect(existsSync(currentLockPath)).toBe(false);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("skips the sweep when the private state directory cannot host a throttle marker", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "issue-4266-no-marker-"));
    const tempRoot = join(testRoot, "tmp");
    const homeRoot = join(testRoot, "home");
    mkdirSync(tempRoot, { mode: 0o700 });
    mkdirSync(homeRoot, { mode: 0o700 });
    const omcDir = join(homeRoot, ".omc");
    mkdirSync(omcDir, { mode: 0o700 });
    writeFileSync(join(omcDir, "state"), "not a directory");
    const staleDir = mkdtempSync(join(tempRoot, "omc-jev-"));
    writeFileSync(join(staleDir, "request.json"), "{}");
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(staleDir, oldTime, oldTime);

    try {
      const result = runActiveRecord(tempRoot, homeRoot);
      const privateMarker = join(
        homeRoot,
        ".omc",
        "state",
        ".jev-sweep-throttle",
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).result.mode).toBe("degraded");
      expect(existsSync(staleDir)).toBe(true);
      expect(existsSync(privateMarker)).toBe(false);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });
});
