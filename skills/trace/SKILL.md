---
name: trace
description: Evidence-driven tracing lane that orchestrates competing tracer hypotheses in Claude built-in team mode
agent: tracer
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
6. **Next Probe** -- the highest-value step to collapse uncertainty

Do **not** collapse into:
- a generic fix-it coding loop
- a generic debugger summary
- a raw dump of worker output
- fake certainty when evidence is incomplete

## Team-mode orchestration shape

Use **Claude built-in team mode** for `/trace`.

The lead should:

1. Restate the observed result or “why” question precisely
2. Extract the tracing target
3. Generate multiple deliberately different candidate hypotheses
4. Spawn **3 tracer lanes by default** in team mode
5. Assign one tracer worker per lane
6. Instruct each tracer worker to gather evidence **for** and **against** its lane
7. Merge findings into a ranked synthesis

Important: workers should pursue deliberately different explanations, not the same explanation in parallel.

## Default hypothesis lanes for v1

Unless the prompt strongly suggests a better partition, use these 3 default lanes:

1. **Code-path / implementation cause**
2. **Config / environment / orchestration cause**
3. **Measurement / artifact / assumption mismatch cause**

These defaults are intentionally broad so the first slice works across bug, performance, architecture, and experiment tracing.

## Worker contract

Each worker should be a **`tracer`** lane owner, not a generic executor.

Each worker must:

- own exactly one hypothesis lane
- restate its lane hypothesis explicitly
- gather evidence **for** the lane
- gather evidence **against** the lane
- call out missing evidence and remaining uncertainty
- recommend the best lane-specific next probe
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
5. **Confidence**
6. **Best Next Probe**

## Leader synthesis contract

The final `/trace` answer should synthesize, not just concatenate.

Return:

1. **Observed Result**
2. **Ranked Hypotheses**
3. **Evidence Summary by Hypothesis**
4. **Evidence Against / Missing Evidence**
5. **Most Likely Explanation**
6. **Recommended Next Probe**
7. **Additional Trace Lanes** (optional, only if uncertainty remains high)

Preserve a ranked shortlist even if one explanation is currently dominant.

## Suggested lead prompt skeleton

Use a team-oriented orchestration prompt along these lines:

1. “Restate the observation exactly.”
2. “Generate 3 deliberately different hypotheses.”
3. “Create one tracer lane per hypothesis using Claude built-in team mode.”
4. “For each lane, gather evidence for and against.”
5. “Return a ranked explanation table, missing evidence, and the single best next probe.”

## Output quality bar

Good `/trace` output is:

- evidence-backed
- concise but rigorous
- skeptical of premature certainty
- explicit about missing evidence
- practical about the next action

## Example final synthesis shape

### Observed Result
[What happened]

### Ranked Hypotheses
| Rank | Hypothesis | Confidence | Why it leads |
|------|------------|------------|--------------|
| 1 | ... | High / Medium / Low | ... |

### Evidence Summary by Hypothesis
- Hypothesis 1: ...
- Hypothesis 2: ...
- Hypothesis 3: ...

### Evidence Against / Missing Evidence
- Hypothesis 1: ...
- Hypothesis 2: ...
- Hypothesis 3: ...

### Most Likely Explanation
[Current best explanation]

### Recommended Next Probe
[Single next probe]

### Additional Trace Lanes
[Only if uncertainty remains high]
