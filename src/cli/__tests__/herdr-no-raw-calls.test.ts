/**
 * Verification test: ensures no raw herdr child_process calls exist outside
 * herdr-session.ts.
 *
 * Every herdr call in the codebase must go through the centralized runner
 * (runHerdr/runHerdrRaw) defined in src/team/herdr-session.ts, mirroring the
 * tmux centralization guard. This test enforces that invariant.
 */

import { describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { join } from "path";

function grepForRawHerdrCalls(): string[] {
  const srcDir = join(__dirname, "..", "..");
  // Patterns that match raw herdr calls via child_process functions.
  // Covers both single-quote and double-quote variants.
  const patterns = [
    "execFileSync\\s*\\(\\s*['\"]herdr",
    "execSync\\s*\\(\\s*['\"`]herdr",
    "spawnSync\\s*\\(\\s*['\"]herdr",
    "execFile\\s*\\(\\s*['\"]herdr",
    "\\bexec\\s*\\(\\s*[`'\"]herdr",
  ];
  const combined = patterns.join("|");

  try {
    const result = execSync(
      `grep -rn --include='*.ts' -E '${combined}' '${srcDir}' || true`,
      { encoding: "utf-8", timeout: 10000 },
    );
    return (
      result
        .split("\n")
        .filter(Boolean)
        // Exclude the wrapper implementations in herdr-session.ts itself
        .filter((line) => !line.includes("team/herdr-session.ts"))
        // Exclude test files
        .filter((line) => !line.includes("__tests__/"))
        // Exclude comments (lines starting with optional whitespace then * or //)
        .filter((line) => {
          const content = line.split(":").slice(2).join(":").trim();
          return !content.startsWith("*") && !content.startsWith("//");
        })
    );
  } catch {
    return [];
  }
}

describe("herdr call centralization", () => {
  it("has zero raw herdr child_process calls outside herdr-session.ts and test files", () => {
    const violations = grepForRawHerdrCalls();
    if (violations.length > 0) {
      const formatted = violations.map((v) => `  ${v}`).join("\n");
      expect.fail(
        `Found ${violations.length} raw herdr call(s) outside herdr-session.ts:\n${formatted}\n\n` +
          "All herdr calls must use the centralized runners (runHerdr, runHerdrRaw) from src/team/herdr-session.ts.",
      );
    }
    expect(violations).toHaveLength(0);
  });
});
