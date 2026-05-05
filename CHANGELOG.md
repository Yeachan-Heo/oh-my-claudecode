# Unreleased

### New Features

- **Deep Interview: Round 0 topology enumeration** (#2919) — confirms and locks top-level components before ambiguity scoring, rotates multi-component targeting, and includes confirmed components plus deferrals in generated specs.

### Migration Notes

- Existing `deep-interview` state files without `state.topology` are treated as legacy state. On resume, unfinished interviews run the new Round 0 topology gate before the next scoring pass; already-finalized specs are left unchanged and should be treated as topology-not-captured legacy artifacts.

---

# oh-my-claudecode v4.13.6: Reliability & macOS Hardening

## Release Notes

Bug fixes for session lifecycle, macOS launch path, and team auth, plus reviewer/designer agent upgrades for Opus 4.7. Net delivery is **14 PRs**: the omx-teams backport (#2903) shipped and was reverted (#2910) within the window, so team-runtime behavior matches v4.13.5.

### New Features

- **`--madmax`/`--yolo` now require tmux on macOS** (#2909)
- **Designer agent: domain-aware override of Opus 4.7 editorial defaults** (#2893)
- **Code-reviewer agent: discovery/filter separation for Opus 4.7** (#2892)
- **Planning artifacts: timestamp canonical handoff files** (#2894)
- **Pre-tool: warn on fallback slop language** (#2878)

### Bug Fixes

- **Stop hook: clean up orphan session state** (#2912, fixes #2911)
- **Cancel: clear Ralph stop hook artifacts** (#2897)
- **Persistent mode: ignore orphan autopilot routing echo** (#2899)
- **Launch: preserve Claude auth in runtime config** (#2908, fixes #2906)
- **Team: use claude bare mode with API key auth** (#2890)
- **Team: require delegation evidence for broad completions** (#2895)
- **Autoresearch: stop discarding the first passing candidate** (#2905, by @stevenmorrisroe)
- **Project memory: keep detector authoritative for schema-known fields on rescan** (#2883)
- **Project memory: preserve unknown fields across rescan** (#2882)
- **Wiki: honor `workingDirectory` for manual worktrees** (#2880)
- **Post-tool verifier: recognize Edit success output** (#2877)

### Other Changes

- **Docs: explain prebuild-install warning** (#2914, fixes #2913)
- **Reverted: omx-teams backport (#2903)** — reverted by #2910

### Stats

- **14 PRs net** | **5 features** | **11 fixes** | **1 docs** | **1 backport reverted**

### Contributors

@devswha @EthanJStark @RobinNorberg @stevenmorrisroe @Yeachan-Heo

---

# oh-my-claudecode v4.13.5: Maintenance Release

## Release Notes

Release with **4 other changes** across **4 merged PRs**.

### Other Changes

- **Fix Max HUD rate limits with enterprise spend cache data** (#2850)
- **Fix session-scoped Ralph PRD state** (#2848)
- **Fix HUD statusLine cold-start flicker** (#2844)
- **Fix stale Ralph stop hook after cancel** (#2833)

### Stats

- **4 PRs merged** | **0 new features** | **0 bug fixes** | **0 security/hardening improvements** | **4 other changes**
