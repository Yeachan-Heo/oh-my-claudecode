# Issue #3712: Release and installation verification and epic closure

**Status:** executable mechanism delivered; epic closure held on unresolved predecessors (temporal condition, not a mechanism gap).
**Parent epic:** #3698. **Planning contract:** [ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md](ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md) (merged via PR #3701, plan head `0a91273e61dbbd47eb0af4c02844409251e08398`).
**Non-goal (hard):** no release/tag/publish/main mutation is performed or authorized here.

## 1. What this issue ships now

The owner released all dependency holds for parallel work and directed that
retirement/closure-time prerequisites be implemented as executable mechanisms
with receipts and tests, without falsely closing the epic. This issue therefore
ships:

1. `scripts/verify-epic-3698-closure.mjs` — the closure verifier (fail-closed).
2. `scripts/collect-epic-3698-ci-evidence.mjs` — read-only exact-head CI evidence collector (`gh`).
3. `receipts/epic-3698/` — schema-validated migration/verification receipts and the remaining-risk register.
4. `tests/integration/epic-3698-closure-verifier.test.ts` — acceptance tests.

## 2. Verifier checks and verdict semantics

`node scripts/verify-epic-3698-closure.mjs [--evidence ci.json] [--base origin/dev] [--json-out path]`

| Check | Pass | Pending (temporal) | Fail |
|---|---|---|---|
| `exactHeadCi` | every recorded PR green at exact head | no evidence file supplied yet | stale-head check, non-green conclusion, malformed evidence |
| `docsLinks` | all relative links in closure docs resolve | no closure docs present | broken relative link / missing owned doc |
| `shippedMetrics` | epic targets met | target unmet and owning child not terminal | target unmet although every owning child is terminal |
| `migrationReceipts` | >= 1 schema-valid receipt | receipts dir missing/empty | schema-invalid receipt |
| `aliasRetirementPolicy` | all alias-usage receipts satisfy the retirement window | no receipts, or window unsatisfied | (never fails: unsatisfied window blocks removal, not the verdict) |
| `releaseSecurityParity` | change set touches no release/publish authority | — | change set touches release workflows/scripts, `.npmrc`, or `package.json` version |
| `childTerminality` | all children #3702-#3711 have terminal receipts | any child lacks terminal evidence | — |
| `remainingRisk` | register exists, schema-valid, non-empty | — | missing/invalid/empty register |

Exit codes: `0` PASS (all checks pass), `2` PENDING_TEMPORAL (no failures, temporal
prerequisites outstanding — the epic must stay open), `1` FAIL (mechanism or
evidence defect). Pending is honest non-closure evidence, never a silent pass.

## 3. Adapter seams for unmerged prerequisites

Where a prerequisite API is not yet merged, the verifier consumes a narrow
receipt interface instead of the API directly; after the prerequisite merges,
its owner (or the rebase of this lane) only needs to emit the receipt:

- **#3706 (merged):** alias telemetry already emits
  `.omc/state/<project>/state/alias-receipts.json` (`totals.aliasUses`,
  `byAlias`, `byCanonical`). Canonical share derives as
  `canonicalUses / (canonicalUses + aliasUses)`; the verifier's `alias-usage`
  receipt is the durable hand-off shape.
- **All children #3702-#3711 are terminal.** Terminal receipts exist for all 10 children. #3704 (#3724) and #3707 (#3725) merged with CI failure (inventory-graph-drift, resolved post-merge by #3711); all others merged green.
- **Alias retirement window remains pending:** #3711 shipped the executable verifier (`src/alias-retirement/`) but retirement requires >= 2 minor releases AND >= 90 days AND >= 95% canonical usage for 2 consecutive releases AND zero known critical integrations. The verifier reports this as pending and aliases must NOT be removed.
- **Quantitative metrics not at target:** skills=41, commands=28, workflows=8 (targets: 12-18 commands, 5-6 workflows). The verifier honestly reports FAIL for shipped metrics. Surface reduction depends on the alias retirement window; the children shipped registries/SSOTs/dispatchers/verifiers without deleting surface files.

## 4. Temporal conditions recorded (not blockers to code)

1. Alias retirement: >= 2 minor releases AND >= 90 days, >= 95% canonical usage
   for 2 consecutive releases, zero known critical integrations. Zero qualifying
   releases have shipped since deprecation — removal is prohibited now.
2. Epic closure requires every child #3702-#3711 terminal (all 10 are now terminal)
   plus exact-head CI at final heads and metrics at target. The verdict is FAIL
   because quantitative metrics (12-18 commands, 5-6 workflows) are not met with
   all owners terminal — honest evidence that surface reduction was not achieved.
3. Metric targets (12-18 commands; 5-6 workflows) are now owned by terminal
   children; the verifier reports FAIL because targets are unmet. This is honest
   evidence, not a mechanism defect.

## 5. Evidence captured on this branch

- Install/pack/smoke matrix at exact origin/dev `570028b24edea9878b0d003bcbf1cb184d8fa47c`:
  `receipts/epic-3698/install-verification-2026-08-12.receipt.json`.
- Exact-head CI for 7 green merged PRs (#3701/#3715/#3716/#3720/#3721/#3723/#3729):
  `receipts/epic-3698/ci-evidence-merged.receipt.json`. PRs #3724/#3725 excluded (CI failure).
- Measured metrics: `receipts/epic-3698/metrics-2026-08-12.receipt.json`.
- Remaining risks: `receipts/epic-3698/remaining-risk.json`.
