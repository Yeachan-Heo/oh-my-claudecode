/**
 * Doc-lint: the diverse-model panel is a panel-tier concept. Upstream
 * #411 retired the phrase everywhere but the panel-tier skills (arena,
 * interrogate), and #412 seats those panels from the routing config.
 *
 * Assertions:
 *   1. "diverse" appears in exactly the two panel-tier skills.
 *   2. Both panel-tier skills seat from `team.roleRouting`.
 *   3. Both keep the no-config fallback to the default provider triple.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");
const PANEL_SKILLS = ["arena", "interrogate"];

const read = (skill: string) =>
  readFileSync(join(REPO_ROOT, "skills", skill, "SKILL.md"), "utf8");

describe("panel-tier wording", () => {
  it("keeps the diverse-model language on the panel-tier skills only", () => {
    const carried: string[] = [];
    for (const skill of PANEL_SKILLS) {
      if (/diverse/i.test(read(skill))) carried.push(skill);
    }
    expect(carried.sort()).toEqual([...PANEL_SKILLS].sort());
  });

  it("seats both panel-tier skills from team.roleRouting with a fallback", () => {
    for (const skill of PANEL_SKILLS) {
      const body = read(skill);
      expect(body, `${skill} reads team.roleRouting`).toContain("team.roleRouting");
      expect(
        body,
        `${skill} keeps the no-config fallback to the default provider triple`,
      ).toContain("1:claude,1:codex,1:gemini");
    }
  });
});
