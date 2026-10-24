#!/usr/bin/env python3
"""Shorten over-budget skill descriptions to <=240 chars (compact plugin shim budget).
Usage: python _descriptions.py skill1[:desc] ... — desc omitted => skip. Reads/writes skills/<name>/SKILL.md."""
import io, re, sys

DESCS = {
"principles": "Twenty-four engineering principles in five groups, mapped to the lane carrying each — premise testing, root causes, honest verification, domain modeling, convergence, context discipline. For design, debugging, or delegation briefs.",
"create-formal-verification-skill": "Verify the project's riskiest invariant with TLA+, Lean, or Kani — chosen by property shape — and leave a project-local skill the next agent reruns; assumptions are part of the deliverable. For properties tests cannot reach.",
"create-verification-skill": "Generate the project's own verify skill: build/test/lint commands discovered by running them, a feature map of what each covers, manual checks, and an earned first verdict. Run once per repo.",
"figure-it-out": "Design a rigorous bespoke playbook for a task no bundled skill fits — steps that each end in a check, verification commands, failure branches — stored under .omc/playbooks/ and anchor-validated. For recurring unusual task shapes.",
"babysit": "Drive an open PR to merge-ready on the watch-pr verdict policy — watch checks and review state, fix CI, address comments; never merges, rebases, or force-pushes. For 'get this green' or 'babysit PR #N'.",
"maintain-verification-skill": "Re-sync the project's verification skill when its commands drift — re-run each recorded command, update expectations and the feature map to what is true now, record the verdict actually earned.",
"models": "Interactive setup for role-based model routing: edit team.roleRouting (provider, tier, per-provider reasoning effort; orchestrator model-only), check panel diversity, warn on missing provider CLIs.",
"why": "Investigate why code is the way it is from evidence — human rulings verbatim, git archaeology, linked issues, incident records — every claim labeled evidence, inference, or guess. For 'why was this built this way'.",
"arena": "Run N parallel candidates at one brief and synthesize: rubric-first framing, isolated fan-out, a cross-judge on a different model, criterion-by-criterion pick, hand grafting. When one attempt would lock in the wrong shape.",
"benchmark-checklist": "Vet a measured number before reporting or acting on it: name the limiter, measure the claimed work, repeat with variance, rule out the observer, label every claim. For any speedup, regression, or score you are about to report.",
"architect": "Settle types and module shape before cross-boundary code — competing designs explored in parallel, compared on API surface and invariants, decision recorded with rejected alternatives and an accepted-deviations register.",
"blast-radius": "Map what a change could break beyond the diff — dependents found by search and AST, classified certain/likely/unlikely — and prove the certain and likely ones by running their checks. Before risky refactors or signature changes.",
"typescript-best-practices": "TypeScript grounding for type-system discipline: discriminated unions over flags, satisfies, parse-don't-validate at boundaries, branded primitives, no non-null assertions on external data.",
"interrogate": "Adversarial pass over a diff or design: three reviewers on different models each try to break it — correctness, security, edge cases — findings merged by severity into a blocking verdict. For contested or high-risk changes.",
"maintain-formal-verification-skill": "Re-sync an existing formal verification skill after the covered code changed: re-check every assumption, update cited lines, rerun the tool; formally-verified only after a green rerun.",
"technical-writing": "One layered standard for shipping prose — docs, RFCs, readmes, PR descriptions, commit messages: outcome first, one meaning one home, checkable statements, no filler. Composes with minimal-prose-discipline.",
"fix-merge-conflicts": "Resolve merge conflicts non-interactively: start the integration, read both sides' intent from their commits, preserve both intents, validate on the resolved tree. Never force-pushes shared branches.",
"recall": "Reconstruct working context from artifacts in trust order — state files, notepad, verification ledger, decision trail, transcript tail — then report where work stands and the next action. After a break or crash.",
"correct": "Find the mistakes agents keep repeating in this repo and make each impossible at the highest enforcing level — lint rule, type guard, runtime check, script, then text — with every enforcement proven to fire.",
"ketchup": "Catch up on everything since your last message: a 1-3 sentence executive summary, one status line per action item with evidence links, and open questions. For 'catch me up' after stepping away.",
"show-me-your-work": "Append-only decision trail for long or autonomous work: one TSV row per non-obvious decision — what was chosen, what was rejected and why, the deciding evidence. For work a human will audit later.",
"in-your-own-words": "Play back the goal, the problem, and the success check in your own words before work starts, surfacing assumptions — so misunderstanding is caught while it is cheap. Before non-trivial work begins.",
"sharpen": "Aim a vague task at its real target without overspecifying: name the consumer, the observable change, the done-check, and the non-goals; at most one question when a real fork remains.",
"what-did-i-get-done": "Summarize authored commits over a period, grouped by theme with commit-range evidence, mechanical churn separated, and unfinished branches named. For standups and 'what did I get done'.",
"get-pr-comments": "Fetch and triage review threads on a PR: threads deduped with resolution state, each with a fix/dismiss/ask recommendation, bot findings read skeptically. Before addressing review feedback.",
"teach": "Explain a subsystem to a learner by composing how and why — the walkthrough cited to code, the decisions that shaped it, paced with a prediction check. For onboarding and knowledge transfer.",
"bro": "Restate the last technical message in plain human language — no jargon, no shorthand, every fact and number kept. For 'say it plainly' or when a reply was too dense.",
}

LIMIT = 240
for name, desc in DESCS.items():
    if len(desc) > LIMIT:
        raise SystemExit(f'OVER BUDGET ({len(desc)}): {name}')
    path = f'skills/{name}/SKILL.md'
    try:
        s = io.open(path, encoding='utf-8').read()
    except FileNotFoundError:
        continue
    m = re.search(r'^description:\s*.*$', s, re.M)
    if not m:
        raise SystemExit(f'no description in {name}')
    assert '"' not in desc, name
    s = s[:m.start()] + f'description: "{desc}"' + s[m.end():]
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print(f'{name}: ->{len(desc)}')
print('ALL WITHIN', LIMIT)
