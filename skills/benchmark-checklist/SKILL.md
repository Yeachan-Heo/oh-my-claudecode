---
name: benchmark-checklist
description: "Vet a measured number before reporting or acting on it: name the limiter, measure the claimed work, repeat with variance, rule out the observer, label every claim. For any speedup, regression, or score you are about to report."
aliases: []
metadata:
  credits:
    benchmark-discipline: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Benchmark Checklist

Run this checklist before you report, commit, or act on any measured number:
a speedup, a regression, a throughput, a latency, or an eval score. Its
purpose is to keep you from measuring the wrong thing and believing it.

## When to use

- you ran a benchmark, profiler, timer, or eval and are about to state a number
- a decision (merge, revert, optimize further) depends on the measurement
- a user asks "is it faster?" and a measurement exists or will be taken

## When not to use

- no measurement is involved — do not block prose claims about unmeasured
  behavior on this checklist; instead label them as guesses

## 1. Name the limiter

State what limits the metric before you measure — CPU, lock contention, I/O,
allocator, network, cold cache, or the harness itself. A change that
"improves" a metric the limiter does not govern measured noise, not work. If
you cannot name a plausible limiter, say so and treat the number as
unexplained.

## 2. Measure the work you claim

- Same inputs, same data shape, same sizes as the claim being made.
- Warmup runs until steady state; report whether caches are cold or warm, and
  which claim each state supports.
- The measured path must include the changed code, end to end. A
  microbenchmark that skips the integration point does not support a claim
  about the system.

## 3. Repeat and report variance

Run enough repetitions to see the spread — at least five, more in noisy
environments. Report the median and the spread, not a single best run. If the
effect is smaller than run-to-run variance, the honest verdict is "no
measurable change".

## 4. Rule out the observer

- Confirm the tool measured the work: profile output naming your function,
  timers around the real span, counters that actually moved.
- A failing check must fail for the predicted reason; a passing one must rest
  on real state and exit codes, not truncated or swallowed output. This is
  the `principles` skill's Prove-it-works clause applied to measurement.

## 5. Report with labels

Every number carries its evidence and its label in the same sentence —
measured, inferred, or guess. Name the machine, the build, and the data
scale. When the stakes justify it, persist the raw output as an artifact
under `.omc/` and link it.

## Verdict

Only after all five sections pass does the number enter a reply, a PR
description, or a decision. If a section fails, report what you actually
established instead of the claim you hoped to make.
