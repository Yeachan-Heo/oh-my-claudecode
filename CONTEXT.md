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

## Refit
- Definition: The user-invoked, cross-session environment retrospective that reads OMC's instruments (trace timeline, friction report, logs, plan notepads) and lands each user-approved finding on one of four fix-owner surfaces: deterministic check, steering volume, tooling, or information access.
- Boundary: (improves the environment, not the code — code defects belong to review; a single launch run's lessons belong to that run's sediment pass)
- Resolved ambiguity: refit writes nothing without user approval; a declined finding is declined explicitly with its reason, and "no findings" is a stated outcome, never a silent one.

## Scout
- Definition: The single pre-dispatch exploration pass in launch Phase 4 that resolves questions shared by two or more tickets, writing notes to `.omc/specs/<feature-slug>/notes/` for workers to consume by pointer.
- Boundary: (covers shared questions only — a question one ticket needs stays in that ticket; the scout writes notes, never code)
- Resolved ambiguity: the pass runs once per launch run, before the frontier opens — not per ticket, and not per worker.

## Integration branch
- Definition: The single merge target created at launch Phase 4 start that outlives the workers; worker branches merge into it only after the two-axis review gate passes, and C5 verify runs against it.
- Boundary: (branch topology realized through team's merge coordination APIs — a launch topology, not a launch state machine)
- Resolved ambiguity: on a PR platform it opens as a draft PR referencing the spec and every ticket; on a patch-only platform it is a plain branch.

## Jev integration
- **Jev**: TypeSafe's System One decision model: send state plus typed questions (Choice/Score/Noul), receive structured judgments with calibrated probabilities. Not a text generator; external dependency at `api.typesafe.ai`, authenticated by `TYPESAFE_API_KEY`.
- **Judgment point**: A narrow, bounded decision inside OMC's orchestration currently made by keywords, rules, or prompt instructions. Enumerated set: mode/skill trigger, intent detection, model-tier routing, loop continuation, context pruning, ralph completion verdict, task-size classification, fact-forcing gate. Each judgment point is implemented twice: a heuristic twin and a Jev implementation.
- **Advisory point**: A judgment point whose answer is only injected as context for the main model or a human and never gates behavior; it has no active state (off/shadow only).
- **Script-side judgment channel**: The planned way for plain-Node hook scripts (which cannot import TS) to consult the judgment resolver, via a subprocess reading stdin JSON; gated on a hook latency budget set by the owner.
- **Point registry**: The single declaration site where every judgment point's name, questions, and latency class are defined; recorders are generated from it, and adding a judgment point means adding one registry entry.
- **Promotion evidence**: The per-point shadow-data report (agreement rate, disagreement examples, latency and cost) that gates flipping a judgment point to active; produced by one eval tool over the shared shadow log.
- **Heuristic twin**: The existing rule-based implementation of a judgment point that remains the fallback and eval baseline.
- **Degraded mode**: The contract that a judgment point falls back to its heuristic twin whenever Jev is unconfigured, timed out, unavailable, or over budget. The workflow never blocks on Jev. _Avoid_: fail-open (implementation jargon), fallback mode.
- **Shadow mode**: A judgment-point rollout state in which the Jev implementation and its heuristic twin both run, the Jev answer is recorded but not acted on, and promotion to active requires recorded evidence that Jev matches or beats the heuristic twin. Each judgment point is in exactly one of three states: off, shadow, active.
