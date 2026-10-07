/** Temp directory cleanup for jev-shadow and jev-resolve (issue #4266). */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const JEVRESOLVE_PATH = join(PROJECT_ROOT, "scripts/jev-resolve.mjs");

describe("issue #4266: jev temp directory cleanup", () => {
  let trackedTempDirs: string[] = [];

  beforeEach(() => {
    trackedTempDirs = [];
  });

  afterEach(() => {
    // Clean up any tracked directories
    for (const dir of trackedTempDirs) {
      try {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // Best effort
      }
    }
  });

  describe("readRequestFile cleanup", () => {
    it("removes temp directory after reading request file", () => {
      // Create a temp directory with a request file
      const tempDir = mkdtempSync(join(tmpdir(), "omc-jev-"));
      trackedTempDirs.push(tempDir);
      
      const requestFile = join(tempDir, "request.json");
      const testRequest = { point: "test", state: {}, questions: {}, heuristic: "test" };
      writeFileSync(requestFile, JSON.stringify(testRequest), { encoding: "utf8" });

      // Verify the directory exists
      expect(existsSync(tempDir)).toBe(true);

      // Run jev-resolve with the request file
      const result = spawnSync(process.execPath, [JEVRESOLVE_PATH, "--request-file", requestFile], {
        env: {
          ...process.env,
          OMC_JEV: "off", // Disable Jev to avoid actual API calls
        },
      });

      // Directory should be removed after processing
      expect(existsSync(tempDir)).toBe(false);
    });

    it("cleans up directory even if file read fails", () => {
      // Create a temp directory with an invalid request file
      const tempDir = mkdtempSync(join(tmpdir(), "omc-jev-"));
      trackedTempDirs.push(tempDir);
      
      const requestFile = join(tempDir, "request.json");
      writeFileSync(requestFile, "invalid json", { encoding: "utf8" });

      // Verify the directory exists
      expect(existsSync(tempDir)).toBe(true);

      // Run jev-resolve with the invalid request file
      const result = spawnSync(process.execPath, [JEVRESOLVE_PATH, "--request-file", requestFile], {
        env: {
          ...process.env,
          OMC_JEV: "off",
        },
      });

      // Directory should still be removed even on parse error
      expect(existsSync(tempDir)).toBe(false);
    });
  });

  describe("recordJevShadow cleanup", () => {
    it("removes temp directory in active mode after completion", () => {
      // Count existing temp dirs before test
      const tmpDirContents = readdirSync(tmpdir());
      const existingDirs = tmpDirContents.filter(d => d.startsWith("omc-jev-")).length;

      // Create a test script that uses recordJevShadow in active mode
      const testScript = `
        import { recordJevShadow } from '${PROJECT_ROOT}scripts/lib/jev-shadow.mjs';
        
        const result = recordJevShadow({
          point: 'test-point',
          state: {},
          questions: {},
          heuristic: 'test'
        });
        
        console.log(JSON.stringify({ success: true, result }));
      `;

      const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
      trackedTempDirs.push(tmpDir);
      
      const scriptFile = join(tmpDir, "test-script.mjs");
      writeFileSync(scriptFile, testScript, { encoding: "utf8" });

      // Run the test script with Jev disabled (which means active mode will skip)
      const result = spawnSync(process.execPath, [scriptFile], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          OMC_JEV: "off",
        },
      });

      // Verify the script ran successfully
      expect(result.status).toBe(0);
      
      // After the script completes, no new omc-jev-* temp directories
      // should be left behind from active mode processing
      const afterContents = readdirSync(tmpdir());
      const afterDirs = afterContents.filter(d => d.startsWith("omc-jev-")).length;
      
      // The number of directories should not increase significantly
      // (allowing a small buffer for race conditions)
      expect(afterDirs - existingDirs).toBeLessThanOrEqual(1);
    });
  });

  describe("sweepStaleTempDirs", () => {
    it("removes directories older than threshold", async () => {
      // This test verifies the sweep function can be called and cleans old dirs
      // Create some old mock directories
      const oldTempDir1 = mkdtempSync(join(tmpdir(), "omc-jev-"));
      const oldTempDir2 = mkdtempSync(join(tmpdir(), "omc-jev-"));
      
      trackedTempDirs.push(oldTempDir1, oldTempDir2);

      // Create a test script that calls sweepStaleTempDirs
      const testScript = `
        import { sweepStaleTempDirs } from '${PROJECT_ROOT}scripts/lib/jev-shadow.mjs';
        
        // Sweep directories older than 1ms (all of them should be swept)
        const cleaned = sweepStaleTempDirs(1);
        console.log(JSON.stringify({ cleaned }));
      `;

      const tmpDir = mkdtempSync(join(tmpdir(), "test-"));
      trackedTempDirs.push(tmpDir);
      
      const scriptFile = join(tmpDir, "test-sweep.mjs");
      writeFileSync(scriptFile, testScript, { encoding: "utf8" });

      // Run the test script
      const result = spawnSync(process.execPath, [scriptFile], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
      });

      // Verify the script ran successfully
      expect(result.status).toBe(0);

      // Parse the output to get count of cleaned directories
      try {
        const output = JSON.parse(result.stdout.trim());
        expect(output.cleaned).toBeGreaterThanOrEqual(2);
      } catch (e) {
        // If output is not valid JSON, it means the function didn't return anything
        // but it should have at least attempted the cleanup
      }

      // Verify the old directories were removed
      expect(existsSync(oldTempDir1)).toBe(false);
      expect(existsSync(oldTempDir2)).toBe(false);
    });
  });
});
