---
name: principles
description: Twenty-four cross-cutting engineering principles for OMC lanes in five groups — core judgment, architecture, verification, delegation, and meta — from premise-testing and root-cause fixes to domain modeling, panel diversity, and encoding lessons as structure. Load for debugging, verification, benchmarking, design work, delegation briefs, or any fix that has already failed twice.
aliases: []
metadata:
  credits:
    principles-library: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Engineering Principles

Twenty-four principles distilled for OMC's lanes from the pstack principle
library (credited above) and rewritten against OMC's own mechanisms. Each
names when it applies and which lane carries it. This is a discipline
skill: it shapes how work is done; it never gates delivery on its own.

## When to use

- a fix has failed twice, or two fixes share one explanation
- debugging, verification, or benchmarking work is starting
- a design choice repeats a shape assumption across files
- delegation prompts are being written and a lane's standing principles
  should travel with the brief

## When not to use

- a one-line mechanical edit with an obvious check
- a hotfix under time pressure — state which principle you skipped and why
  in one line, then proceed

## Core

### Laziness Protocol

Refactoring, sizing a diff, or tempted to add abstractions, layers, or
signal threading. Bias to deletion and the smallest change that solves the
problem. Composes with `minimal-code-discipline`. Carried by `executor` and
`code-simplifier`.

### Foundational Thinking

Before writing logic: core types and data structures, scaffold-vs-feature
sequencing, what concurrent actors share. Carried by `architect` and
`planner`.

### Redesign from First Principles

Integrating a new requirement into an existing design. Redesign as if the
requirement had been foundational from day one, instead of patching the old
shape around it. Carried by `architect`.

### Attack the premise

When two or more attempted fixes share one assumption and all failed the
same gate, stop writing fix three. Write the shared assumption down, test
it directly, and let the result choose the next move. Carried by `critic`
during plan gap analysis and by `debugger` before a third retry.

### Subtract before you add

Before sequencing an addition, refactor, or rewrite, remove the dead weight
first and build on the simpler base. Carried by `executor` and
`code-simplifier`.

### Minimize reader load

Reviewing or shaping code that is hard to trace. Count layers and hidden
state, collapse one-caller wrappers, shrink mutable scope. Carried by
`code-simplifier` and `writer`.

### Outcome-oriented execution

Planned rewrites and migrations with explicit phase boundaries. Converge on
the target architecture; do not preserve throwaway compatibility states.
Carried by `planner`.

### Experience first

Product, UX, or feature-scope tradeoffs. Choose user delight over
implementation convenience, and say the tradeoff out loud when you take it.
Carried by `designer`.

### Exhaust the design space

A novel interaction or architectural decision with no precedent. Build 2-3
competing options and compare before committing — the `arena` and
`architect` skills are this principle operationalized. Carried by
`architect`.

### Build the lever

Any non-trivial repeated work. Build the tool that does or proves it —
codemod, script, generator — rather than doing it by hand a third time; the
tool is the artifact a reviewer reruns. Carried by `executor`.

## Architecture

### Model the domain

When stateful logic branches a lot or repeats a shape assumption across
files, encode the domain in a structure — a state machine, a typed model, a
registry, a reducer — instead of scattering conditionals. OMC's graph
runtime (`graph` skill) is this principle at full size. Carried by
`architect`.

### Boundary discipline

Wiring validation, error handling, or framework adapters. Guards at system
boundaries, trust internal types, keep business logic pure. Carried by
`architect` and `executor`.

### Type system discipline

Designing types or signatures in any typed language. Make illegal states
unrepresentable, brand primitives, parse external data at boundaries; in
TypeScript, `typescript-best-practices` grounds this in syntax. Carried by
`architect` and `executor`.

### Make operations converge

Design commands, lifecycle steps, and loops that run amid crashes and
retries to converge to the same end state. OMC's team recovery replays
worker checkpoints idempotently; user code deserves the same property.
Carried by `executor`.

### Migrate callers, then delete legacy APIs

Introducing a new internal API while old callers exist. Migrate every
caller and delete the old surface in one wave; a compatibility shim with no
expiry is a second system. Carried by `executor`.

### Separate before serializing shared state

Concurrent actors might write the same file, branch, key, or object.
Eliminate the sharing first (a writer per worktree is OMC's house form);
locking is the fallback, not the first move. Carried by `executor` and
`team`.

## Verification

### Prove it works

Done means verified against the real artifact — the command's actual
output, the passing test, the rendered page — never a proxy and never "it
compiles". The `verify` skill owns the evidence format. Carried by
`verifier`.

### Fix root causes

Trace each symptom to the first place the system went wrong and fix it
there. A guard for a state that should not exist is a workaround, not a
fix; it is legitimate only when that state itself is legitimate. Carried by
`debugger`; `verifier` treats symptom-level patches as incomplete work.

### Sequence work into verifiable units

Multi-step work — sweeps, migrations, runs of similar edits — and how
commits and PRs stack. Small units that each end in a check, verified
before the next, ordered so the sequence proves itself. Carried by
`planner` and `git-master`.

### Test behavior, not implementation

Assert what users of the code can observe. A test worth keeping fails when
the behavior breaks and passes when only internals change. Carried by
`test-engineer`.

### Explain the number

Before trusting, reporting, or acting on a measured number, find what
limits it and rule out that it measured something other than the work you
think. Label every claim measured, inferred, or guess in the same sentence.
The `benchmark-checklist` skill owns the full procedure. Carried by
`scientist` and by any lane reporting performance.

## Delegation

### Guard the context window

Route bulk reading and large outputs to subagents; keep summaries in the
lead thread. Context spent on a wall of log output is context not spent on
judgment. Applies to every lane and to the orchestrator itself.

### Never block on the human

Tempted to ask "should I do X?" on reversible work. Proceed, present the
result, let the human course-correct; reserve questions for genuine
product calls no experiment can settle. Carried by every lane.

## Meta

### Encode lessons in structure

The second time you write the same instruction, stop writing it a third
time: encode it as a lint rule, a runtime check, a script, or — in OMC — a
learned skill via `skillify`, or an enforcement via `correct`. Text rots;
structure reruns. Carried by `skillify` and `self-improve`.

## Distribution map

When delegating, prepend the delegate lane's standing principles to the
brief.

| Lane | Standing principles |
| ---- | ------------------- |
| `critic` | Attack the premise |
| `debugger` | Attack the premise, Fix root causes |
| `verifier` | Prove it works, Fix root causes |
| `test-engineer` | Test behavior, not implementation |
| `architect` | Foundational Thinking, Redesign from First Principles, Model the domain, Exhaust the design space |
| `planner` | Foundational Thinking, Outcome-oriented execution, Sequence work into verifiable units |
| `executor` | Laziness Protocol, Subtract before you add, Make operations converge, Boundary discipline, Type system discipline, Migrate callers, Separate before serializing, Build the lever |
| `scientist` | Explain the number |
| `designer` | Experience first |
| `code-simplifier` | Laziness Protocol, Subtract before you add, Minimize reader load |
| `writer` | Minimize reader load |
| `git-master` | Sequence work into verifiable units |
| every lane | Guard the context window, Never block on the human, Encode lessons in structure |

## Reporting

When this skill is active, name in the reply which principle shaped each
non-obvious decision, in one clause. When a principle and an explicit user
instruction conflict, the user wins; say so in one sentence.
