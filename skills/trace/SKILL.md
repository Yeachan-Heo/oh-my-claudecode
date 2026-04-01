---
name: trace
description: Evidence-driven tracing lane that orchestrates competing tracer hypotheses in Claude built-in team mode
argument-hint: "<observation to trace>"
agent: tracer
level: 2
---

# Trace Skill

Use this skill for ambiguous, causal, evidence-heavy questions where the goal is to explain **why** an observed result happened, not to jump directly into fixing or rewriting code.

This is the orchestration layer on top of the built-in `tracer` agent. The goal is to make tracing feel like a reusable OMC operating lane: restate the observation, generate competing explanations, gather evidence in parallel, rank the explanations, and propose the next probe that would collapse uncertainty fastest.

## Good entry cases

Use `/oh-my-claudecode:trace` when the problem is:

- ambiguous
- causal
- evidence-heavy
- best answered by exploring competing explanations in parallel

Examples:
- runtime bugs and regressions
- performance / latency / resource behavior
- architecture / premortem / postmortem analysis
- scientific or experimental result tracing
- config / routing / orchestration behavior explanation
- “given this output, trace back the likely causes”

## Core tracing contract

Always preserve these distinctions:

1. **Observation** -- what was actually observed
2. **Hypotheses** -- competing explanations
3. **Evidence For** -- what supports each explanation
4. **Evidence Against / Gaps** -- what contradicts it or is still missing
5. **Current Best Explanation** -- the leading explanation right now
6. **Critical Unknown** -- the missing fact keeping the top explanations apart
7. **Discriminating Probe** -- the highest-value next step to collapse uncertainty

Do **not** collapse into:
- a generic fix-it coding loop
- a generic debugger summary
- a raw dump of worker output
- fake certainty when evidence is incomplete

## Evidence strength hierarchy

Treat evidence as ranked, not flat.

From strongest to weakest:

1. **Controlled reproductions / direct experiments / uniquely discriminating artifacts**
2. **Primary source artifacts with tight provenance** (trace events, logs, metrics, benchmark outputs, configs, git history, file:line behavior)
3. **Multiple independent sources converging on the same explanation**
4. **Single-source code-path or behavioral inference**
5. **Weak circumstantial clues** (timing, naming, stack order, resemblance to prior bugs)
6. **Intuition / analogy / speculation**

Explicitly down-rank hypotheses that depend mostly on lower tiers when stronger contradictory evidence exists.

## Strong falsification / disconfirmation rules

Every serious `/trace` run must try to falsify its own favorite explanation.

For each top hypothesis:

- collect evidence **for** it
- collect evidence **against** it
- state what distinctive prediction it makes
- state what observation would be hard to reconcile with it
- identify the cheapest probe that would discriminate it from the next-best alternative

Down-rank a hypothesis when:

- direct evidence contradicts it
- it survives only by adding new unverified assumptions
- it makes no distinctive prediction compared with rivals
- a stronger alternative explains the same facts with fewer assumptions
- its support is mostly circumstantial while the rival has stronger evidence tiers

## Team-mode orchestration shape

Use **Claude built-in team mode** for `/trace`.

The lead should:

1. Restate the observed result or “why” question precisely
2. Extract the tracing target
3. Generate multiple deliberately different candidate hypotheses
4. Spawn **3 tracer lanes by default** in team mode
5. Assign one tracer worker per lane
6. Instruct each tracer worker to gather evidence **for** and **against** its lane
7. Run a **rebuttal round** between the leading hypothesis and the strongest remaining alternative
8. Detect whether the top lanes genuinely differ or actually converge on the same root cause
9. Merge findings into a ranked synthesis with an explicit critical unknown and discriminating probe

Important: workers should pursue deliberately different explanations, not the same explanation in parallel.

## Default hypothesis lanes for v1

Unless the prompt strongly suggests a better partition, use these 3 default lanes:

1. **Code-path / implementation cause**
2. **Config / environment / orchestration cause**
3. **Measurement / artifact / assumption mismatch cause**

These defaults are intentionally broad so the first slice works across bug, performance, architecture, and experiment tracing.

## Mandatory cross-check lenses

After the initial evidence pass, pressure-test the leaders with these lenses when relevant:

- **Systems lens** -- queues, retries, backpressure, feedback loops, upstream/downstream dependencies, boundary failures, coordination effects
- **Premortem lens** -- assume the current best explanation is incomplete or wrong; what failure mode would embarrass the trace later?
- **Science lens** -- controls, confounders, measurement bias, alternative variables, falsifiable predictions

These lenses are not filler. Use them when they can surface a missed explanation, hidden dependency, or weak inference.

## Worker contract

Each worker should be a **`tracer`** lane owner, not a generic executor.

Each worker must:

- own exactly one hypothesis lane
- restate its lane hypothesis explicitly
- gather evidence **for** the lane
- gather evidence **against** the lane
- rank the evidence strength behind its case
- call out missing evidence, failed predictions, and remaining uncertainty
- name the **critical unknown** for the lane
- recommend the best lane-specific **discriminating probe**
- avoid collapsing into implementation unless explicitly told to do so

Useful evidence sources include:

- relevant code, tests, configs, docs, logs, outputs, and benchmark artifacts
- existing trace artifacts via `trace_timeline`
- existing aggregate trace evidence via `trace_summary`

Recommended worker return structure:

1. **Lane**
2. **Hypothesis**
3. **Evidence For**
4. **Evidence Against / Gaps**
5. **Evidence Strength**
6. **Critical Unknown**
7. **Best Discriminating Probe**
8. **Confidence**

## Leader synthesis contract

The final `/trace` answer should synthesize, not just concatenate.

Return:

1. **Observed Result**
2. **Ranked Hypotheses**
3. **Evidence Summary by Hypothesis**
4. **Evidence Against / Missing Evidence**
5. **Rebuttal Round**
6. **Convergence / Separation Notes**
7. **Most Likely Explanation**
8. **Critical Unknown**
9. **Recommended Discriminating Probe**
10. **Additional Trace Lanes** (optional, only if uncertainty remains high)

Preserve a ranked shortlist even if one explanation is currently dominant.

## Rebuttal round and convergence detection

Before closing the trace:

- let the strongest non-leading lane present its best rebuttal to the current leader
- force the leader to answer the rebuttal with evidence, not assertion
- if the rebuttal materially weakens the leader, re-rank the table
- if two “different” hypotheses reduce to the same underlying mechanism, merge them and say so explicitly
- if two hypotheses still imply different next probes, keep them separate even if they sound similar

Do not claim convergence just because multiple workers use similar language. Convergence requires either:

- the same root causal mechanism, or
- independent evidence streams pointing to the same explanation

## Explicit down-ranking guidance

The lead should explicitly say why a hypothesis moved down:

- contradicted by stronger evidence
- lacks the observation it predicted
- requires extra ad hoc assumptions
- explains fewer facts than the leader
- lost the rebuttal round
- converged into a stronger parent explanation

This is important because `/trace` should teach the reader **why** one explanation outranks another, not just present a final table.

## Suggested lead prompt skeleton

Use a team-oriented orchestration prompt along these lines:

1. “Restate the observation exactly.”
2. “Generate 3 deliberately different hypotheses.”
3. “Create one tracer lane per hypothesis using Claude built-in team mode.”
4. “For each lane, gather evidence for and against, rank evidence strength, and name the critical unknown plus best discriminating probe.”
5. “Apply systems, premortem, and science lenses to the leaders if useful.”
6. “Run a rebuttal round between the top two explanations.”
7. “Return a ranked explanation table, convergence notes, the critical unknown, and the single best discriminating probe.”

## Output quality bar

Good `/trace` output is:

- evidence-backed
- concise but rigorous
- skeptical of premature certainty
- explicit about missing evidence
- practical about the next action
- explicit about why weaker explanations were down-ranked

## Example final synthesis shape

### Observed Result
[What happened]

### Ranked Hypotheses
| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|------|------------|------------|-------------------|--------------|
| 1 | ... | High / Medium / Low | Strong / Moderate / Weak | ... |

### Evidence Summary by Hypothesis
- Hypothesis 1: ...
- Hypothesis 2: ...
- Hypothesis 3: ...

### Evidence Against / Missing Evidence
- Hypothesis 1: ...
- Hypothesis 2: ...
- Hypothesis 3: ...

### Rebuttal Round
- Best rebuttal to leader: ...
- Why leader held / failed: ...

### Convergence / Separation Notes
- ...

### Most Likely Explanation
[Current best explanation]

### Critical Unknown
[Single missing fact keeping uncertainty open]

### Recommended Discriminating Probe
[Single next probe]

### Additional Trace Lanes
[Only if uncertainty remains high]
