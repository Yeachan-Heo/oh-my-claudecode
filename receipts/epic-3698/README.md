# Epic #3698 closure receipts

Machine-readable migration and verification receipts for issue #3712
(Release and installation verification and epic closure). Validated by
`scripts/verify-epic-3698-closure.mjs`; CI evidence is collected by
`scripts/collect-epic-3698-ci-evidence.mjs`. Contract:
[docs/design/ISSUE-3712-RELEASE-VERIFICATION.md](../../docs/design/ISSUE-3712-RELEASE-VERIFICATION.md).

## Receipt format

Every `*.receipt.json` file is:

```json
{
  "schemaVersion": 1,
  "kind": "metrics-snapshot | alias-usage | ci-evidence | child-terminal | remaining-risk | install-verification",
  "issue": 3712,
  "createdAt": "<ISO-8601>",
  "payload": { }
}
```

Kind-specific payload requirements enforced by the verifier:

- `alias-usage`: `canonicalShare` in [0,1], `minorReleases`, `daysSinceDeprecation`,
  `consecutiveReleasesAtThreshold`, `knownCriticalIntegrations`. Satisfies the
  retirement policy only when `minorReleases >= 2` AND `daysSinceDeprecation >= 90`
  AND `canonicalShare >= 0.95` for `consecutiveReleasesAtThreshold >= 2` AND
  `knownCriticalIntegrations == 0`. Source adapter: the #3706 alias resolver emits
  `.omc/state/<project>/state/alias-receipts.json` with `totals.aliasUses` and
  `byCanonical` counts; canonical share = canonicalUses / (canonicalUses + aliasUses).
  The release-window fields are supplied by #3711 receipts once releases ship.
- `ci-evidence`: `pullRequests[]` with `number`, `headSha`, and `checks[]`; each check
  must bind the exact head via `sha` (must equal `headSha`) or `exactHead: true`, and
  have conclusion `success|skipped|neutral`.
- `child-terminal`: `state` (`merged|closed`) plus non-empty `evidence`.
- `metrics-snapshot`: public/internal counts plus `measurementSha256`.
- `install-verification`: scoped command/verdict/evidence rows for pack/install/smoke.
- `remaining-risk`: the register lives at `remaining-risk.json` (not a `.receipt.json`
  file) and requires a non-empty `risks[]` array with id/description/severity/
  mitigation/status.

## Current receipts

- `ci-evidence-merged.receipt.json` — exact-head CI for 7 green PRs (#3701, #3715, #3716, #3720, #3721, #3723, #3729). PRs #3724/#3725 excluded (CI failure).
- `metrics-2026-08-12.receipt.json` — measured surface counts at origin/dev `570028b24ede`.
- `install-verification-2026-08-12.receipt.json` — pack/install/smoke evidence at the same head.
- `child-3702/3703/3704/3705/3706/3707/3708/3709/3710/3711-terminal.receipt.json` (all 10 children terminal).
- `remaining-risk.json` — explicit remaining-risk register.
