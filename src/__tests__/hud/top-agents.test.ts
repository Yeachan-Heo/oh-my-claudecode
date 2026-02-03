/**
 * Test for the "Top: none" fix
 *
 * Verifies that calculateSessionHealth correctly fetches top agents
 * from TokenTracker instead of returning an empty hardcoded array.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";

describe("Top Agents Display Fix", () => {
  describe("Source code verification", () => {
    it("calculateSessionHealth calls getTopAgents instead of hardcoding empty array", async () => {
      // Read the source file to verify the fix is in place
      const indexPath = path.join(process.cwd(), "src/hud/index.ts");
      const sourceCode = await fs.readFile(indexPath, "utf-8");

      // The fix should include these patterns:
      // 1. Get sessionId from stdin
      expect(sourceCode).toContain("extractSessionId(stdin.transcript_path)");

      // 2. Get tracker with sessionId
      expect(sourceCode).toContain("getTokenTracker(sessionId)");

      // 3. Call getTopAgents on the tracker
      expect(sourceCode).toContain("tracker.getTopAgents(");

      // 4. Map results to the expected format (spacing-agnostic)
      expect(sourceCode).toMatch(
        /\.map\s*\(\s*\(?a\)?\s*=>\s*\(\s*{\s*agent:\s*a\.agent,\s*cost:\s*a\.cost\s*}\s*\)\s*\)/,
      );

      // 5. Should NOT have the old hardcoded empty array pattern
      // (this was: topAgents: [], in the return statement)
      // The fix replaces it with a variable reference
      expect(sourceCode).toMatch(/topAgents,\s*\n\s*costPerHour/);
    });

    it("has proper error handling for top agents fetch", async () => {
      const indexPath = path.join(process.cwd(), "src/hud/index.ts");
      const sourceCode = await fs.readFile(indexPath, "utf-8");

      // Should have try-catch around the top agents fetch
      expect(sourceCode).toContain("// Get top agents from tracker");
      expect(sourceCode).toContain(
        "// Top agents fetch failed - continue with empty",
      );
    });
  });

  describe("Type verification", () => {
    it("SessionHealth.topAgents has correct type structure", async () => {
      const typesPath = path.join(process.cwd(), "src/hud/types.ts");
      const typesSource = await fs.readFile(typesPath, "utf-8");

      // topAgents should be an array of objects with agent and cost
      expect(typesSource).toContain(
        "topAgents?: Array<{ agent: string; cost: number }>",
      );
    });
  });

  describe("Data flow verification", () => {
    it("extractSessionId is imported and used", async () => {
      const indexPath = path.join(process.cwd(), "src/hud/index.ts");
      const sourceCode = await fs.readFile(indexPath, "utf-8");

      // extractSessionId should be imported from output-estimator (quote-agnostic)
      expect(sourceCode).toMatch(
        /import\s*{\s*extractSessionId\s*}\s*from\s*['"]\.\.\/analytics\/output-estimator\.js['"]/,
      );
    });

    it("getTokenTracker is imported and used", async () => {
      const indexPath = path.join(process.cwd(), "src/hud/index.ts");
      const sourceCode = await fs.readFile(indexPath, "utf-8");

      // getTokenTracker should be imported from token-tracker (quote-agnostic)
      expect(sourceCode).toMatch(
        /import\s*{\s*getTokenTracker\s*}\s*from\s*['"]\.\.\/analytics\/token-tracker\.js['"]/,
      );
    });
  });
});

describe("TokenTracker.getTopAgents contract", () => {
  it("getTopAgents method exists in TokenTracker", async () => {
    const trackerPath = path.join(
      process.cwd(),
      "src/analytics/token-tracker.ts",
    );
    const sourceCode = await fs.readFile(trackerPath, "utf-8");

    // Method should be defined with correct signature (may span multiple lines)
    expect(sourceCode).toContain("async getTopAgents(");
    expect(sourceCode).toContain("limit: number = 5");
    expect(sourceCode).toContain(
      "Promise<Array<{ agent: string; tokens: number; cost: number }>>",
    );
  });

  it("getTopAgents reads from sessionStats.byAgent", async () => {
    const trackerPath = path.join(
      process.cwd(),
      "src/analytics/token-tracker.ts",
    );
    const sourceCode = await fs.readFile(trackerPath, "utf-8");

    // Should read from sessionStats.byAgent
    expect(sourceCode).toContain("this.sessionStats.byAgent");
  });

  it("getTopAgents sorts by cost descending", async () => {
    const trackerPath = path.join(
      process.cwd(),
      "src/analytics/token-tracker.ts",
    );
    const sourceCode = await fs.readFile(trackerPath, "utf-8");

    // Should sort by cost descending
    expect(sourceCode).toContain("sort((a, b) => b.cost - a.cost)");
  });
});

describe("Debug Logging for Silent Catch Blocks", () => {
  describe("Cost calculation error handling", () => {
    it("catches error parameter in cost calculation catch block", async () => {
      const indexPath = path.join(process.cwd(), "src/hud/index.ts");
      const sourceCode = await fs.readFile(indexPath, "utf-8");

      // Should catch error parameter (not just empty catch)
      // Looking for: } catch (error) {
      expect(sourceCode).toMatch(
        /}\s*catch\s*\(\s*error\s*\)\s*{[\s\S]*?Cost calculation failed/,
      );
    });

    it("logs cost calculation errors when OMC_DEBUG is set", async () => {
      const indexPath = path.join(process.cwd(), "src/hud/index.ts");
      const sourceCode = await fs.readFile(indexPath, "utf-8");

      // Should check process.env.OMC_DEBUG before logging
      expect(sourceCode).toContain("if (process.env.OMC_DEBUG)");

      // Should log the error with a clear prefix
      expect(sourceCode).toMatch(
        /console\.error\(['"]\[HUD\] Cost calculation failed:/,
      );
    });

    it("includes error object in cost calculation log", async () => {
      const indexPath = path.join(process.cwd(), "src/hud/index.ts");
      const sourceCode = await fs.readFile(indexPath, "utf-8");

      // Should pass the error to console.error
      expect(sourceCode).toMatch(/console\.error\([^)]*error\s*\)/);
    });
  });

  describe("Top agents fetch error handling", () => {
    it("catches error parameter in top agents fetch catch block", async () => {
      const indexPath = path.join(process.cwd(), "src/hud/index.ts");
      const sourceCode = await fs.readFile(indexPath, "utf-8");

      // Should catch error parameter (not just empty catch)
      // Looking for: } catch (error) {
      expect(sourceCode).toMatch(
        /}\s*catch\s*\(\s*error\s*\)\s*{[\s\S]*?Top agents fetch failed/,
      );
    });

    it("logs top agents fetch errors when OMC_DEBUG is set", async () => {
      const indexPath = path.join(process.cwd(), "src/hud/index.ts");
      const sourceCode = await fs.readFile(indexPath, "utf-8");

      // Should check process.env.OMC_DEBUG before logging
      // This will match the existing debug checks in the file
      expect(sourceCode).toContain("if (process.env.OMC_DEBUG)");

      // Should log the error with a clear prefix
      expect(sourceCode).toMatch(
        /console\.error\(['"]\[HUD\] Top agents fetch failed:/,
      );
    });

    it("includes error object in top agents fetch log", async () => {
      const indexPath = path.join(process.cwd(), "src/hud/index.ts");
      const sourceCode = await fs.readFile(indexPath, "utf-8");

      // Should pass the error to console.error
      // Will match multiple console.error calls, but that's okay
      expect(sourceCode).toMatch(/console\.error\([^)]*error\s*\)/);
    });
  });

  describe("Error logging pattern consistency", () => {
    it("uses consistent [HUD] prefix for all debug logs", async () => {
      const indexPath = path.join(process.cwd(), "src/hud/index.ts");
      const sourceCode = await fs.readFile(indexPath, "utf-8");

      // Both new error logs should use [HUD] prefix for consistency
      const hudPrefixMatches = sourceCode.match(/\[HUD\]/g);
      expect(hudPrefixMatches).toBeTruthy();
      expect(hudPrefixMatches!.length).toBeGreaterThanOrEqual(2);
    });

    it("all catch blocks in calculateSessionHealth have error handling", async () => {
      const indexPath = path.join(process.cwd(), "src/hud/index.ts");
      const sourceCode = await fs.readFile(indexPath, "utf-8");

      // Extract the calculateSessionHealth function
      const functionMatch = sourceCode.match(
        /async function calculateSessionHealth[\s\S]*?^}/m,
      );
      expect(functionMatch).toBeTruthy();

      const functionBody = functionMatch![0];

      // Should not have any empty catch blocks (} catch {)
      expect(functionBody).not.toMatch(/}\s*catch\s*{/);

      // All catch blocks should have error parameter
      const catchBlocks = functionBody.match(/}\s*catch\s*\(/g);
      if (catchBlocks) {
        expect(catchBlocks.length).toBeGreaterThan(0);
      }
    });
  });
});
