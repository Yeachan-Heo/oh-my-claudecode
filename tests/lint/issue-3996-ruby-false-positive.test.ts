/**
 * Cross-surface regression guards for issue #3996.
 *
 * Issue #2969 shipped a "Ralph requires Ruby" probe and doctor/setup steps
 * even though OMC has never used Ruby (no `.rb` file was ever committed, and
 * the only historical Ruby references were the probe itself, its docs, and
 * their tests). Issue #3996 removed the false positive and replaced it with a
 * truthful Node-runtime check. These guards keep it out of the shipped
 * surfaces:
 *  - scripts/plugin-setup.mjs must not probe Ruby at post-install
 *  - the omc-doctor and omc-setup Ralph steps must stay Ruby-free and must
 *    keep checking the real prerequisites (Node runtime, writable config dir)
 *  - skills/deep-interview/SKILL.md must cite the plan skill in a form that
 *    resolves (`Skill("oh-my-claudecode:plan")`), not `/omc-plan`
 *
 * Rollback boundary: delete tests/lint/issue-3996-ruby-false-positive.test.ts
 * — no runtime change.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");

const read = (relativePath: string): string =>
  readFileSync(join(REPO_ROOT, relativePath), "utf-8");

describe("issue #3996: no Ralph/Ruby false positive in shipped surfaces", () => {
  it("plugin-setup.mjs never probes Ruby or claims Ralph requires it", () => {
    const content = read("scripts/plugin-setup.mjs");
    expect(content).not.toMatch(/\bruby\b/i);
    expect(content).not.toContain("checkRalphRubyDependency");
  });

  it("omc-doctor Step 5 checks Ralph runtime prerequisites without Ruby", () => {
    const content = read("skills/omc-doctor/SKILL.md");
    expect(content).toContain("Check Ralph Runtime Prerequisites");
    expect(content).toContain("node --version");
    expect(content).not.toMatch(/\bruby\b/i);
    expect(content).not.toContain("Ralph Ruby Dependency");
  });

  it("omc-setup Step 2.0 checks Ralph runtime prerequisites without Ruby", () => {
    const content = read("skills/omc-setup/phases/02-configure.md");
    expect(content).toContain("Step 2.0: Check Ralph Runtime Prerequisites");
    expect(content).toContain("node --version");
    expect(content).not.toMatch(/\bruby\b/i);
  });
});

describe("issue #3996: deep-interview cites a resolvable plan invocation", () => {
  it("the approval-gated pipeline uses Skill(\"oh-my-claudecode:plan\"), not /omc-plan", () => {
    const content = read("skills/deep-interview/SKILL.md");
    // The plan skill's resolvable invocation form (matches the citation at
    // the AskUserQuestion options earlier in the same file).
    expect(content).toContain('Skill("oh-my-claudecode:plan")');
    // /omc-plan is the frontmatter display name, not a resolvable slash
    // command; it must not come back as an invocation citation.
    expect(content).not.toMatch(/(^|\s)\/omc-plan\b/);
  });
});
