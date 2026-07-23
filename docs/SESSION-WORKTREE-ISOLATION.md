# Session Worktree Isolation

Session worktree isolation is the opt-in contract for running a plan-and-execute
skill (`plan`/`ralplan`, `autopilot`, `ralph`, `ultrawork`, `ultraqa`,
`self-improve`) inside a **dedicated, temporary git worktree** so that several
Claude Code sessions can work the same repository in parallel without touching
each other's files.

It is the session-level counterpart to
[`TEAM-WORKTREE-MODE.md`](./TEAM-WORKTREE-MODE.md), which isolates *workers
inside one team session*. This document isolates *whole sessions* from one
another.

## Why this exists

OMC already scopes **state** per session: `.omc/state/sessions/{sessionId}/`,
`OMC_SESSION_ID`, `--plan-id`, and the `.omc-workspace` anchor keep two
concurrent runs from clobbering each other's `prd.json`, plans, and mailboxes.
Every skill's `## Parallel session caveats` block reports that as
`Parallel verdict: supported`.

That verdict is about state, not about the filesystem. A git repository has
exactly **one working tree**. Two sessions running `ralph` in the same clone
share it, which means:

- Session A's `git checkout` moves the branch out from under session B.
- Session B's uncommitted edits get swept into session A's commit.
- A branch cut for ticket X silently carries ticket Y's half-finished code.
- Build/test runs interleave against a tree that is a mix of two tasks.

Isolated state does not prevent any of this. A separate worktree does: each
session gets its own directory and its own checked-out branch, sharing a single
`.git`.

## Availability

- **Opt-in. Off by default.** No existing workflow changes behavior unless the
  user turns this on. This mirrors the rollout stance of native team worktree
  mode.
- **Prompt-level workflow contract, not runtime enforcement** — the same status
  as `companyContext` in [`settings-schema.md`](./settings-schema.md). Skills
  read the configuration and follow the steps below; nothing in OMC's runtime
  forces provisioning.
- Requires a git repository. In a non-git directory, or when `git worktree` is
  unavailable, skills report that and continue in place.

## Configuration

`.claude/omc.jsonc` (project) or `~/.config/claude-omc/config.jsonc` (user);
project overrides user.

```jsonc
{
  "sessionWorktree": {
    // "off" (default) | "ask" | "auto"
    "mode": "ask",
    // where worktrees are provisioned, relative to the repo root
    "root": ".omc/worktrees",
    // branch to cut from; resolved against the remote when present
    "base": "origin/main",
    // "on-clean-exit" (default) | "never"
    "cleanup": "on-clean-exit"
  }
}
```

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `mode` | `"off" \| "ask" \| "auto"` | `"off"` | `off`: never provision. `ask`: offer via `AskUserQuestion` at the preflight step. `auto`: provision without asking. |
| `root` | `string` | `".omc/worktrees"` | Worktree parent directory, relative to the repo root. |
| `base` | `string` | `"origin/main"` | Base ref for the new branch. Falls back to `origin/master`, then the current HEAD's upstream, then HEAD. |
| `cleanup` | `"on-clean-exit" \| "never"` | `"on-clean-exit"` | `on-clean-exit` removes the worktree only when it is clean and fully merged; a dirty worktree is always preserved. |

Per-run overrides beat configuration:

- `--worktree` — force provisioning for this run, even when `mode` is `off`.
- `--no-worktree` — skip provisioning for this run, even when `mode` is `auto`.

## Workspace contract

| Field | Contract |
| --- | --- |
| Worktree root | `<repo>/.omc/worktrees/<slug>` |
| Branch | `omc/<slug>` |
| Slug | Ticket key when the task names one (`ABC-123`), otherwise `<skill>-<short-session-id>` |
| Session cwd | The provisioned `worktree_path` |
| State root | Unchanged — `.omc/` resolution still follows `OMC_STATE_DIR > .omc-workspace > git > cwd` |

The layout deliberately matches native team worktree mode
(`<repo>/.omc/team/<team-name>/worktrees/<worker-name>`): everything OMC creates
lives under `.omc/`, which is already ignored, so provisioning adds no
`.gitignore` churn and `rm -rf .omc` never strands a checkout that git still
tracks.

Note the consequence documented in [`REFERENCE.md`](./REFERENCE.md): for a
linked worktree the default `.omc/` lives inside that worktree, so deleting the
worktree deletes its local OMC state. Set `OMC_STATE_DIR` if a run's state must
outlive its worktree.

## Preflight

Skills that provision run this before their first mutation:

1. **Resolve intent.** `--no-worktree` wins; then `--worktree`; then
   `sessionWorktree.mode`. If the result is "no", skip the rest silently.
2. **Check the repository.** `git rev-parse --show-toplevel`. Not a repo → report
   and continue in place.
3. **Check for an existing worktree.** `git worktree list --porcelain`. If the
   target path already exists and is clean and on the expected branch, reuse it.
   A path/branch mismatch is a failure, not a reason to reuse the wrong tree.
4. **Refuse on a dirty leader tree.** If the current working tree has uncommitted
   changes, do not provision — surface the dirty state and let the user commit,
   stash, or pass `--no-worktree`. Copying an unsafe base is worse than staying
   put. (Same rule as team worktree mode.)
5. **Provision.**
   ```sh
   git fetch --quiet <remote> && \
   git worktree add -b "omc/<slug>" ".omc/worktrees/<slug>" "<base>"
   ```
6. **Enter it.** Use `EnterWorktree` when the harness exposes it; otherwise run
   subsequent commands with the worktree path as cwd. Report the path and branch
   to the user in one line.
7. **Carry environment.** A fresh worktree contains tracked files only. Ignored
   local configuration (`.env*`, credentials, service-account files) and
   installed dependencies do not exist there. Copy what the project needs and run
   its install step inside the worktree. Never symlink `node_modules` between
   worktrees.

## Planning/execution boundary

`plan` and `ralplan` **must not provision**. Planning modes are barred from
mutating the repository before explicit execution approval, and `git worktree
add` writes to `.git` and creates a branch.

Instead, a planning mode **records the intended worktree** in its plan artifact:

```markdown
## Execution workspace

- Worktree: `.omc/worktrees/ABC-123` (to be created at execution time)
- Branch: `omc/ABC-123`, cut from `origin/main`
- Provisioned by: the execution skill's worktree preflight
```

The execution skill that consumes the handoff (`autopilot`, `ralph`, `team`)
performs the preflight and provisions. This keeps one authority for the
mutation and keeps the plan reproducible.

## Cleanup

- On clean exit with `cleanup: "on-clean-exit"`: `git worktree remove
  .omc/worktrees/<slug>` then `git worktree prune`. Never `rm -rf` a worktree
  directory — that strands git metadata.
- A dirty or unmerged worktree is **always preserved** and surfaced as a warning,
  whatever `cleanup` says. Unreviewed work is not OMC's to discard.
- One branch belongs to exactly one worktree. `git checkout` of a branch that
  `git worktree list` shows as held elsewhere will be refused by git; that
  refusal is the guard, not an error to force past.

## Interaction with existing worktree surfaces

| Surface | Scope | Relationship |
|---------|-------|--------------|
| Session worktree isolation (this doc) | One Claude Code session | Isolates sessions from each other |
| [Native team worktree mode](./TEAM-WORKTREE-MODE.md) | Workers inside one team session | Isolates workers; owns its own layout under `.omc/team/` |
| `project-session-manager` (`/psm`) | Issue/PR/feature, with tmux | Provisions under `~/.psm/worktrees/` and launches its own session |

They compose: a session isolated by this contract may still run a team whose
workers get their own worktrees underneath it. When PSM already placed the
session in a worktree, the preflight in step 3 finds a usable tree and reuses it
rather than nesting another.

## Non-goals

- **Multiple agents editing one branch in one working tree.** That is not made
  safe by this document or any other; the model is one branch, one worktree, one
  writer.
- **Automatic conflict resolution or merging** between session branches. Landing
  the branch stays a normal review-and-merge.
- **Runtime enforcement.** Nothing here blocks a skill that ignores the contract.
