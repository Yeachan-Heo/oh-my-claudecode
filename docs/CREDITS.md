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
| `babysit` skill | idea | pstack babysit | PR watch-and-fix loop; merge authority stays with the human |
| `fix-ci` skill | idea | pstack fix-ci | real/flaky/environmental CI failure classification |
| `fix-merge-conflicts` skill | idea | pstack fix-merge-conflicts | both-intent-preserving non-interactive resolution |
| `get-pr-comments` skill | idea | pstack get-pr-comments | review-thread dedupe and fix/dismiss/ask triage |
| `src/features/watch-pr/policy.ts` | mechanism | pstack watch-pr | gate ordering, mergeability-unknown wait, no-checks confirmation window; pure reimplementation |
| `src/features/verification-ledger/ledger.ts` | mechanism | pstack orch ledger | verdict vocabulary, append-only TSV shape, formula-cell guard |
| `scripts/check-omc-playbooks.mjs` | mechanism | pstack check-playbooks | extends/anchor validation for project playbook extensions |
