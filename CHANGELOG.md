# oh-my-claudecode v5.6.2: per-role reasoningEffort in, map-driven runs end, from-map --execute —

## Release Notes

Release with **5 new features**, **13 bug fixes**, **7 other changes** across **29 merged PRs**.

### Highlights

- **feat(team): per-role reasoningEffort in roleRouting** (#4206)
- **feat(ralph): map-driven runs end to end — PRD compose, launch gate, write-back (spec #51 T-D)**
- **feat(ralph): from-map --execute — claims with provenance, routes human gates, drafts criteria and stops (spec #51 T-C)**
- **feat(ralph): omc ralph from-map — plan a run from a wayfinder map (spec #51 T-B)**
- **feat(factory): wayfinder map frontier enumerator (pure seam, spec #51 T-A)**

### New Features

- **feat(team): per-role reasoningEffort in roleRouting** (#4206)
- **feat(ralph): map-driven runs end to end — PRD compose, launch gate, write-back (spec #51 T-D)**
- **feat(ralph): from-map --execute — claims with provenance, routes human gates, drafts criteria and stops (spec #51 T-C)**
- **feat(ralph): omc ralph from-map — plan a run from a wayfinder map (spec #51 T-B)**
- **feat(factory): wayfinder map frontier enumerator (pure seam, spec #51 T-A)**

### Bug Fixes

- **fix(atomic-write): skip directory fsync on Windows to prevent EPERM** (#3744)
- **fix(#4221): parse before mode lookup, drop lossy substring skip; cover git-guardrails worker path** (#4221)
- **fix(#4217): warn when postinstall cannot build contained-fs; make tarball install check fail honestly** (#4217)
- **fix: use relative timestamps in runs-reconciler fixtures to prevent time-bomb failures**
- **fix: normalize node:test duration_ms and exclude pass/test counters from failure signatures**
- **fix(team): strict process-start identity on native Windows** (#4211)
- **fix(jev): restore real script active-mode regressions**
- **fix: preemptive-compaction awaits active result; script hooks consume answers**
- **fix: wire active mode answer consumption in script and TS callers** (#4208)
- **fix(jev): make :active mode consume the Jev answer** (#4208)
- **fix(team): restrict reasoningEffort to providers with a verified CLI flag; export OMC_TEAM_ROLE on scale-up** (#4206)
- **fix(hooks): run state-only PostToolUse hook async** (#4204)
- **fix: resolve session paths using getOmcRoot for multi-repo support**

### Documentation

- **docs: update Jev active mode behavior documentation**

### Other Changes

- **chore(inventory): regenerate inventory graph for #4217 packaging files**
- **chore: refresh inventory after runs-reconciler fixture fix**
- **chore: refresh inventory for fix #4215**
- **chore(inventory): regenerate inventory graph for #4211**
- **chore(inventory): refresh graph from clean Jev fix checkout**
- **chore(inventory): regenerate inventory graph from clean checkout** (#4206)
- **chore(inventory): regenerate inventory graph from clean checkout** (#4204)

### Stats

- **29 PRs merged** | **5 new features** | **13 bug fixes** | **0 security/hardening improvements** | **7 other changes**
