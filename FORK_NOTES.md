# Fork Notes — avireddy0/oh-my-claudecode

This repository is a fork of [Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode).

- **Upstream remote:** `upstream` → `https://github.com/Yeachan-Heo/oh-my-claudecode.git`
- **Origin remote:** `origin`  → `https://github.com/avireddy0/oh-my-claudecode.git`
- **Last upstream merge:** `96a0cfbc` (2026-03-09); the audit on 2026-04-26 dated the most recent active sync at 2026-03-31 (~26 days stale at audit time).
- **Commits behind upstream/main as of 2026-04-26:** **1115** (per `git rev-list --count origin/main..upstream/main`; the 2026-04-26 audit reported 740 — the gap has continued to widen).
- **Commits ahead of upstream/main:** 4

## CRITICAL — Local patches live in bundled artifacts, not in `src/`

The fork carries three behavioral fixes that exist **only in committed bundle/script files**, not in the TypeScript sources. A naive `git merge upstream/main` will silently overwrite them and re-introduce the bugs they fix.

The patches must either be ported into `src/` and rebuilt, or re-applied by hand after every upstream merge.

### Patch inventory

| # | Patch | File(s) | Symptom if reverted |
|---|-------|---------|----------------------|
| 1 | **RALPLAN mode constant + `init_atomic_write` injection** | `bridge/cli.cjs` | `MODE_NAMES.RALPLAN` lookups fall back to undefined; race conditions on init JSON writes |
| 2 | **`teamCreateTask` 5s lock loop** (concurrency fix) | `bridge/team.js` (uses `.lock-create-task` directory); helpers in `bridge/team-mcp.cjs` (`ensureDirSync`, `DEFAULT_STALE_LOCK_MS = 30000`) | Concurrent team task creation can corrupt task store |
| 3 | **Exit-code-only Bash failure detection** | `scripts/post-tool-verifier.mjs` | Reverts to broad `error:` / `failed` / `cannot` / `fatal:` regex → false-positive PostToolUse hook failures on benign output containing those words |

Companion drift on the same patch wave: `bridge/runtime-cli.cjs`, `bridge/team-bridge.cjs`, `bridge/mcp-server.cjs`.

### How to detect a regression

After any merge from upstream, before pushing:

```bash
# Patch 1 — RALPLAN constant must still be wired into the bundle
grep -q "RALPLAN" bridge/cli.cjs || echo "REGRESSION: Patch 1 reverted"

# Patch 2 — teamCreateTask must still acquire the .lock-create-task directory
grep -q "lock-create-task" bridge/team.js || echo "REGRESSION: Patch 2 reverted"

# Patch 3 — failure detection must be exit-code-based, not regex
grep -q "exit code\|exitCode" scripts/post-tool-verifier.mjs || echo "REGRESSION: Patch 3 reverted"
```

A non-empty output from any line means the merge silently dropped that patch.

### Recovery procedure

If a regression is detected after merging upstream:

1. Identify the pre-merge SHA on `main`: `git log --merges --grep="upstream/main" -5`.
2. Checkout the affected files from that SHA:
   ```bash
   PRE_MERGE=<sha-from-step-1>
   git checkout "$PRE_MERGE" -- \
     bridge/cli.cjs \
     bridge/team.js \
     bridge/team-mcp.cjs \
     bridge/runtime-cli.cjs \
     bridge/team-bridge.cjs \
     bridge/mcp-server.cjs \
     scripts/post-tool-verifier.mjs
   ```
3. Re-run the detection commands above to confirm restoration.
4. Commit the restoration with a message that names the patch numbers.

## Strategic options for a permanent fix

Option A and Option B below are the two known-good ways to stop fighting this. Either is fine; both are out of scope for this PR.

- **Option A — Port patches into `src/` and rebuild.** Locate the TypeScript origins (`src/cli/...`, `src/mcp/...`, `src/hooks/...`) for each patched bundle, port the fix to source, run the bundler (`npm run build:*`), commit both source and bundle. This is the "right" fix but requires deep familiarity with the build graph (`build-cli.mjs`, `build-team-server.mjs`, etc.).
- **Option B — Stop tracking bundles, rebuild on install.** Remove `bridge/*.cjs` from version control, build them as part of the plugin install/postinstall step. Eliminates the drift surface entirely but changes the consumer contract (`claude-code-memory` currently imports from the committed bundle).

Until either option lands, the detection commands above are the safety net.

## Why this file exists

This PR (Wave H) deliberately does **not** attempt the source extraction. Its only goal is to prevent silent regression on the next upstream merge by documenting the patch set in a place a human reviewer will see during merge review.
