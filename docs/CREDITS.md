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

Rows list every borrowing; absence from this table is the assertion that no
external derivation exists. Text-licensed borrowings additionally carry their
upstream license file at the repo root when the upstream license requires it.

| OMC surface | Kind | Source | Notes |
| ----------- | ---- | ------ | ----- |
| `pr` summary visuals | idea | [show-me](https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md) (Dex Horthy, Humanlayer) | smallest visual that proves the change |
| `pr` merge-danger framing | idea | [mattpocock/skills](https://github.com/mattpocock/skills) | |
| `principles` skill | idea | [pstack](https://github.com/cursor/plugins/tree/main/pstack) (Lauren Tan), via the [pstack-claude](https://github.com/michael-denyer/pstack-claude) port (Michael Denyer) | principle library re-expressed against OMC lanes |
| `benchmark-checklist` skill | idea | pstack benchmark-checklist / explain-the-number | measurement discipline rewritten for the verify protocol |
| `arena` skill | idea | pstack arena | N-candidate bakeoff re-expressed on OMC's Task fan-out and `omc team` worktree isolation |
| `interrogate` skill | idea | pstack interrogate | adversarial multi-reviewer panel re-expressed on OMC agents and providers |
| `babysit` skill | idea | pstack babysit | PR watch-and-fix loop; merge authority stays with the human |
| `models` skill | idea | pstack setup-pstack | setup wizard for OMC's existing `team.roleRouting` plus panel-diversity guidance |
| `create-formal-verification-skill` skill | idea | pstack create-formal-verification-skill | TLA+/Lean/Kani selection method and one-property-per-skill discipline |
| `src/features/watch-pr/policy.ts` | mechanism | pstack watch-pr | gate ordering, mergeability-unknown wait, no-checks confirmation window; pure reimplementation |
| `src/features/verification-ledger/ledger.ts` | mechanism | pstack orch ledger | verdict vocabulary, append-only TSV shape, formula-cell guard |
| `scripts/check-omc-playbooks.mjs` | mechanism | pstack check-playbooks | extends/anchor validation for project playbook extensions |
