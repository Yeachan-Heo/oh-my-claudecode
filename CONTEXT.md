---
documentLanguage: en
---

# Glossary

One entry per term: definition, boundaries, resolved ambiguity. Vocabulary here is law for all specs, tickets, and code naming.

## Intent
- Definition: A goal-level requirements document produced by a non-engineer contributor (support/ops) through an agent-facilitated conversation, stored at `docs/intents/<slug>/intent.md` with five sections: problem, goal, users-and-systems, constraints, open questions.
- Boundary: (is a statement of problem/goal/constraints, not a solution design — solution space belongs to the Spec)
- Resolved ambiguity: an accepted Intent is a valid mission brief for launch; "intent" is not the same as deep-interview's interview transcript.

## Review round
- Definition: One "submit → accept/reject" cycle of an Intent on the tracker, numbered incrementally; a rejected Intent is revised and resubmitted in the same file under the next round number.
- Boundary: (rounds accumulate in one tracker record file per Intent, not one file per round)
- Resolved ambiguity: any accepted Intent may be amended, but every amendment is a new round through full review — no "minor change" exemption.

## Blocking open question
- Definition: An open question that prevents spec approval until closed; non-blocking ones are tracked and may ride along into development.
- Boundary: (graded by "can the spec still be approved without answering it", not by the asker's preference)
- Resolved ambiguity: the drafting agent suggests a grade; the product owner has final say at spec approval.
