# oh-my-claudecode v4.13.5

v4.13.5 is a larger maintenance and stability release than the generated notes originally showed: **18 merged PRs / 32 commits** since v4.13.4.

## Highlights

### Team auto-merge runtime

- Added the team auto-merge / fan-out rebase path for worker branches.
- Added mailbox, leader inbox, commit-cadence, merge-orchestrator, restart recovery, and safety checks for team runtime flows.
- Hardened auto-merge runtime contracts and gitdir safety.

### HUD and rate-limit correctness

- Fixed several Max / Pro / enterprise-spend edge cases in HUD rate-limit display.
- Preserved Pro/Max rate limits when subscription metadata is missing or enterprise-shaped spend data appears.
- Fixed Max overage used-credit classification and cold-start statusLine flicker.

### Ralph / hooks / session-state stability

- Fixed stale Ralph stop-hook behavior after cancel.
- Made Ralph PRD state session-scoped.
- Improved SessionStart reconciliation for hard-terminated sessions and explicit start markers.
- Clarified durable SessionStart cleanup evidence and stopped relying on hook-runner PPID for cleanup.

### Tool and skill behavior fixes

- Fixed structured Write/Edit success-envelope handling so successful object responses are not treated as failures.
- Fixed `/deep-dive` so it honors the shared `omc.deepInterview.ambiguityThreshold` setting instead of using a hardcoded threshold.
- Confirmed CLAUDE.md closing tag alignment.
- Removed AI slop across source files.

## Merged PRs

- #2807 — refactor(src): remove AI slop across 13 files
- #2810 — Fix HUD rate limits with missing subscription metadata
- #2814 — Fix Max HUD rate limits with enterprise spend
- #2820 — Confirm CLAUDE.md closing tag alignment
- #2823 — Preserve Pro/Max rate limits with zero enterprise spend
- #2826 — Fix post-tool verifier object response false positives
- #2830 — Protect HUD limits from enterprise-shaped Pro/Max spend
- #2833 — Fix stale Ralph stop hook after cancel
- #2836 — Fix HUD Max overage used credits classification
- #2839 — Protect Max HUD rate limits from legacy spend cache
- #2831 — Team auto-merge / fan-out rebase
- #2817 — SessionStart reconciliation for hard-terminated sessions
- #2841 — Structured Write/Edit success envelopes
- #2844 — HUD statusLine cold-start flicker
- #2848 — Session-scoped Ralph PRD state
- #2850 — Max HUD rate limits with enterprise spend cache data
- #2852 — Deep-dive ambiguity threshold settings
- #2853 — Release prep v4.13.5

## Validation

- Main CI passed
- Upgrade Test passed
- Release workflow passed
- npm package published: `oh-my-claude-sisyphus@4.13.5`

## Install / Update

```bash
npm install -g oh-my-claude-sisyphus@4.13.5
```

Or reinstall the plugin:

```bash
claude /install-plugin oh-my-claudecode
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.13.4...v4.13.5

## Contributors

Thank you to everyone who contributed fixes, reviews, and release validation.

@Yeachan-Heo
