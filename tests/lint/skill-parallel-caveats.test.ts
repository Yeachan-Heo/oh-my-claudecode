/**
 * Doc-lint: verify every skill listed in Wave C has a valid ## Parallel session caveats block.
 *
 * Assertions per file:
 *   1. Contains the `## Parallel session caveats` heading.
 *   2. Contains the exact session-id-source sentence.
 *   3. Contains all four required bullet labels.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");

// ralph / ultrawork / ultraqa were retired in 5.0.0; ultragoal carries the
// long-running parallel lane that ralph used to cover.
const SKILLS: Record<string, string> = {
  autopilot: "skills/autopilot/SKILL.md",
  team: "skills/team/SKILL.md",
  ultragoal: "skills/ultragoal/SKILL.md",
  "self-improve": "skills/self-improve/SKILL.md",
};

const REQUIRED_HEADING = "## Parallel session caveats";

const REQUIRED_SESSION_ID_SENTENCE =
  "OMC_SESSION_ID env var wins in CLI contexts; hook payload data.session_id wins in hook contexts.";

const REQUIRED_BULLETS = [
  "**Multi-repo workspace anchor:**",
  "**Session id source:**",
  "**Plan id (when applicable):**",
  "**Parallel verdict:**",
];

describe("skill-parallel-caveats doc-lint", () => {
  for (const [skillName, relativePath] of Object.entries(SKILLS)) {
    const filePath = join(REPO_ROOT, relativePath);

    it(`${skillName}: contains ## Parallel session caveats heading`, () => {
      const content = readFileSync(filePath, "utf-8");
      expect(
        content.includes(REQUIRED_HEADING),
        `Missing "${REQUIRED_HEADING}" in ${relativePath}`
      ).toBe(true);
    });

    it(`${skillName}: contains exact session-id-source sentence`, () => {
      const content = readFileSync(filePath, "utf-8");
      expect(
        content.includes(REQUIRED_SESSION_ID_SENTENCE),
        `Missing exact session-id-source sentence in ${relativePath}:\n  "${REQUIRED_SESSION_ID_SENTENCE}"`
      ).toBe(true);
    });

    for (const bullet of REQUIRED_BULLETS) {
      it(`${skillName}: contains bullet "${bullet}"`, () => {
        const content = readFileSync(filePath, "utf-8");
        expect(
          content.includes(bullet),
          `Missing bullet "${bullet}" in ${relativePath}`
        ).toBe(true);
      });
    }
  }
});
