# Credits

OMC stands on other projects. When a skill, workflow, or mechanism derives from
an external project's ideas, the derivation is recorded in three places:

1. the skill frontmatter `metadata.credits` block (machine-adjacent, ships with the skill),
2. the table below (human-readable registry), and
3. for ported code, a header comment in the ported file naming the design source.

Three borrowing kinds:

- **idea** — a concept or discipline re-expressed in OMC's own words and mechanisms; no text or code copied.
- **mechanism** — a behavioral design (state machine, contract, algorithm) reimplemented in OMC's codebase.
- **text** — wording carried over with permission of its license; the source license is noted in the row.

Two scopes, stated explicitly. **Skill/workflow ideas and mechanisms introduced
by recent work** are row-registered below; absence from the table asserts no
external derivation for those kinds. **Pre-existing code-level derivations are
documented in their own file headers** (each ported file names its source), and
are summarized once per upstream source here rather than file-by-file.

| OMC surface | Kind | Source | Notes |
| ----------- | ---- | ------ | ----- |
| `pr` summary visuals | idea | [show-me](https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md) (Dex Horthy, Humanlayer) | smallest visual that proves the change |
| `pr` merge-danger framing | idea | [mattpocock/skills](https://github.com/mattpocock/skills) | |
| `arena` skill | idea | pstack arena | N-candidate bakeoff re-expressed on OMC's Task fan-out and `omc team` worktree isolation |
| `interrogate` skill | idea | pstack interrogate | adversarial multi-reviewer panel re-expressed on OMC agents and providers |
| `babysit` skill | idea | pstack babysit | PR watch-and-fix loop; merge authority stays with the human |
| `models` skill | idea | pstack setup-pstack | setup wizard for OMC's existing `team.roleRouting` plus panel-diversity guidance |
| `create-formal-verification-skill` skill | idea | pstack create-formal-verification-skill | TLA+/Lean/Kani selection method and one-property-per-skill discipline |
| `maintain-formal-verification-skill` skill | idea | pstack maintain-formal-verification-skill | drift re-sync procedure for formal verification skills |
| `create-verification-skill` skill | idea | pstack create-verification-skill | project verify-skill generation, commands discovered by execution, feature map |
| `maintain-verification-skill` skill | idea | pstack maintain-verification-skill | verify-skill drift re-sync |
| `why` skill | idea | pstack why | multi-source investigation epistemics; human-rulings-verbatim rule |
| `how` skill | idea | pstack how | explorer/explainer two-pass subsystem walkthrough |
| `correct` skill | idea | pstack correct | repeated-mistake elimination ladder (lint > type > runtime > script > text) |
| `blast-radius` skill | idea | pstack blast-radius | dependents mapping and classification with executed proof |
| `architect` skill | idea | pstack architect | parallel design exploration with accepted-deviations register |
| `figure-it-out` skill | idea | pstack figure-it-out | bespoke playbook designer, stored under `.omc/playbooks/` |
| `show-me-your-work` skill | idea | pstack show-me-your-work | TSV decision trail with formula-cell guard |
| `technical-writing` skill | idea | pstack technical-writing | layered prose standard for shipping surfaces |
| `typescript-best-practices` skill | idea | pstack typescript-best-practices | TS syntax grounding for type-system discipline |
| `teach` skill | idea | pstack teach | how+why composition with a landing check |
| `bro` skill | idea | pstack bro | plain-language restatement keeping every fact |
| `sharpen` skill | idea | pstack sharpen | task aiming: consumer, done-check, non-goals |
| `in-your-own-words` skill | idea | pstack in-your-own-words | goal/problem/success playback before work starts |
| `recall` skill | idea | pstack recall | artifact-first context recovery in trust order |
| `ketchup` skill | idea | pstack ketchup | session catch-up with executive summary and status lines |
| `what-did-i-get-done` skill | idea | pstack what-did-i-get-done | authored-commit summaries grouped by theme |
| `fix-ci` skill | idea | pstack fix-ci | real/flaky/environmental CI failure classification |
| `fix-merge-conflicts` skill | idea | pstack fix-merge-conflicts | both-intent-preserving non-interactive resolution |
| `get-pr-comments` skill | idea | pstack get-pr-comments | review-thread dedupe and fix/dismiss/ask triage |
| `principles` skill | idea | pstack principles | grouped engineering principles and carrying lanes |
| `benchmark-checklist` skill | idea | pstack benchmark-checklist | benchmark acceptance checklist |
| `src/features/watch-pr/policy.ts` | mechanism | pstack watch-pr | gate ordering, mergeability-unknown wait, no-checks confirmation window; pure reimplementation |
| `src/features/verification-ledger/ledger.ts` | mechanism | pstack orch ledger | verdict vocabulary, append-only TSV shape, formula-cell guard |
| `scripts/check-omc-playbooks.mjs` | mechanism | pstack check-playbooks | extends/anchor validation for project playbook extensions |
