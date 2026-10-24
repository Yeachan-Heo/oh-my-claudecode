---
name: principles
description: Ten cross-cutting engineering principles for OMC lanes — test the premise before the third fix, fix root causes, prove work on the real artifact, test behavior not implementation, model the domain, make retries converge, subtract before adding, explain measured numbers, guard the context window, encode repeated lessons as structure. Load for debugging, verification, benchmarking, design work, or any fix that has already failed twice.
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

Ten principles distilled for OMC's lanes from the pstack principle library
(credited above) and rewritten against OMC's own mechanisms. Each principle
names when it applies and which lane carries it. This is a discipline skill:
it shapes how work is done; it never gates delivery on its own.

## When to use

- a fix has failed twice, or two fixes share one explanation
- debugging, verification, or benchmarking work is starting
- a design choice repeats a shape assumption across files
- delegation prompts are being written and a lane's standing principles should travel with the brief

## When not to use

- a one-line mechanical edit with an obvious check
- a hotfix under time pressure — state which principle you skipped and why in one line, then proceed

## The principles

### Attack the premise

When two or more attempted fixes share one assumption and all failed the same
gate, stop writing fix three. Write the shared assumption down, test it
directly, and let the result choose the next move. Carried by `critic` during
plan gap analysis and by `debugger` before a third retry.

### Fix root causes

Trace each symptom to the first place the system went wrong and fix it there.
A guard for a state that should not exist is a workaround, not a fix; it is
legitimate only when that state itself is legitimate. Carried by `debugger`;
`verifier` treats symptom-level patches as incomplete work.

### Prove it works

Done means verified against the real artifact — the command's actual output,
the passing test, the rendered page — never a proxy and never "it compiles".
The `verify` skill owns the evidence format; this principle is why that format
demands fresh evidence. Carried by `verifier`.

### Test behavior, not implementation

Assert what users of the code can observe. A test worth keeping fails when the
behavior breaks and passes when only internals change. Carried by
`test-engineer`.

### Model the domain

When stateful logic branches a lot or repeats a shape assumption across
files, encode the domain in a structure — a state machine, a typed model, a
registry, a reducer — instead of scattering conditionals. OMC's graph runtime
(`graph` skill) is this principle at full size. Carried by `architect`.

### Make operations converge

Design commands, lifecycle steps, and loops that run amid crashes and retries
to converge to the same end state. OMC's team recovery replays worker
checkpoints idempotently; user code deserves the same property. Carried by
`executor`.

### Subtract before you add

Before sequencing an addition, refactor, or rewrite, remove the dead weight
first and build on the simpler base. Pairs with `minimal-code-discipline`.
Carried by `executor` and `code-simplifier`.

### Explain the number

Before trusting, reporting, or acting on a measured number, find what limits
it and rule out that it measured something other than the work you think.
Label every claim measured, inferred, or guess in the same sentence. The
`benchmark-checklist` skill owns the full procedure. Carried by `scientist`
and by any lane reporting performance.

### Guard the context window

Route bulk reading and large outputs to subagents; keep summaries in the lead
thread. Context spent on a wall of log output is context not spent on
judgment. Applies to every lane and to the orchestrator itself.

### Encode lessons in structure

The second time you write the same instruction, stop writing it a third time:
encode it as a lint rule, a runtime check, a script, or — in OMC — a learned
skill via `skillify`. Text rots; structure reruns. Carried by `skillify` and
`self-improve`.

## Distribution map

When delegating, prepend the delegate lane's standing principles to the brief.

| Lane | Standing principles |
| ---- | ------------------- |
| `critic` | Attack the premise |
| `debugger` | Attack the premise, Fix root causes |
| `verifier` | Prove it works, Fix root causes |
| `test-engineer` | Test behavior, not implementation |
| `architect` | Model the domain |
| `executor` | Make operations converge, Subtract before you add |
| `scientist` | Explain the number |
| `code-simplifier` | Subtract before you add |
| every lane | Guard the context window, Encode lessons in structure |

## Reporting

When this skill is active, name in the reply which principle shaped each
non-obvious decision, in one clause. When a principle and an explicit user
instruction conflict, the user wins; say so in one sentence.
