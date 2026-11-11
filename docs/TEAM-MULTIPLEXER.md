# Team Multiplexer Backend (tmux / Herdr)

Team multiplexer selection is the opt-in path for running `omc team` workers on
[Herdr](https://herdr.dev) — the agent-aware terminal multiplexer — instead of
tmux. It targets `runtime-v2` team sessions and follows the same provider
model as cmux: one persisted session marker, per-operation provider branches,
no schema fork.

## Availability

- **Opt-in / config-gated.** Unset means tmux; there is no behavior change
  unless `herdr` is selected.
- Setting: `team.ops.multiplexer` in the OMC plugin config
  (`~/.config/claude-omc/config.jsonc`), or env `OMC_TEAM_MULTIPLEXER`.
  Allowed values: `tmux`, `herdr`.
- Herdr binary required for the herdr backend (v0.9.x verified); the headless
  server is auto-started on demand.

## Mapping

| Team concept | tmux | herdr |
| --- | --- | --- |
| team session | `omc-team-<name>` session/window | `herdr:<workspace_id>` marker; one `omc-team-<name>` workspace label |
| worker pane | split-window pane (`%N`) | one tab per worker; pane `wN:pM` |
| worker start delivery | typed shell command (send-keys state machine) | `pane run` delivers the same start command; Herdr then auto-detects the worker CLI as an agent |
| task submit | literal typing + submit rounds | `agent prompt` (pane-addressed; submission-verified, honors bracketed paste) |
| output capture | `capture-pane -p` | `pane read --source recent-unwrapped` (plain text; same content heuristics) |
| liveness | `#{pane_dead}` + server identity | live-agent inventory membership — provable death, unlike cmux |
| interrupt / kill pane | `C-c` / `kill-pane` | `agent send-keys ctrl+c` / `pane close` |
| session teardown | `kill-session` | `workspace close` |
| leader pane | the invoking tmux pane | `HERDR_PANE_ID` when OMC itself runs inside Herdr, else none |
| server identity binding | socket path + pid + process start | not applicable (no identity required, like cmux) |

Engine: `src/team/herdr-session.ts` — the single module allowed to invoke the
`herdr` binary (enforced by `src/cli/__tests__/herdr-no-raw-calls.test.ts`,
mirroring the tmux centralization guard).

## Provider discrimination

The persisted `tmux_session` value is the provider marker:

- `herdr:<workspace_id>` → herdr
- `cmux:<workspace>` → cmux
- anything else → tmux

`providerForTeamTarget(sessionName, paneId)` (`src/team/tmux-session.ts`) is
the single classifier; herdr pane ids (`wN:pM`) never fall through to the cmux
branch (opaque non-`%` ids). Worker `pane_id` fields persist the Herdr pane id
unchanged.

## Design notes

- **Elected, not ambient.** cmux is detected from the running surface
  (`CMUX_SURFACE_ID`); herdr is elected through config because team leaders
  run in any terminal while workers live in the Herdr server.
- **Server bootstrap.** Herdr CLI commands fail with `server_not_running`
  when no server owns `~/.config/herdr/herdr.sock`; on the herdr backend OMC
  starts the headless `herdr server` detached and polls until it answers.
  Workers outlive the OMC process (the Herdr model); `herdr server stop` stops
  everything.
- **Failure isolation.** Every Herdr error surfaces as a typed `HerdrError`;
  the binary is trust-pinned to `HERDR_BIN_PATH` when that env var holds an
  absolute path to an existing file.
- **Verification.** Unit tests fake the CLI through an injectable exec
  (`src/team/__tests__/herdr-session.test.ts`); a self-skipping live suite
  (`herdr-session-realherdr.test.ts`) exercises workspace/tab/delivery/capture/
  teardown against a real binary, leaving the machine as found. Verified
  against Herdr v0.9.5.

## Surfaces beyond the team layer

- **Interop side-by-side** (`src/cli/interop.ts`): running inside a Herdr
  pane (HERDR_PANE_ID) or with herdr elected, `omc interop` spawns the Codex
  CLI as a tab of the SAME workspace as the invoking pane (workspace id from
  the pane id prefix) instead of a tmux split-window. No attach is attempted
  (the user is already in the Herdr TUI); tmux prerequisites are waived on
  that path. Electing herdr without being inside a Herdr pane surfaces a
  clear error instead of silently falling back to tmux.
- **Notifications & replies** (`src/notifications`): when OMC runs inside a
  Herdr pane (`HERDR_PANE_ID`, grammar-validated), pane/session detection
  returns the Herdr pane id and the `herdr:<workspace_id>` marker, so
  notification payloads and reply mappings address Herdr panes. Reply
  injection routes by pane grammar: tmux panes keep send-keys; Herdr panes
  deliver the sanitized reply through `agent prompt` (submission-verified —
  one step replaces the tmux literal+Enter pair and the ask-user-question
  Down/Enter walk). The reply listener starts on herdr-only machines when
  herdr is elected; default tmux detection is unchanged.
- **Rate-limit wait daemon** (`src/features/rate-limit-wait`): when herdr is
  elected, the daemon also scans live Herdr agent panes (`agent list` +
  `pane read`) with the same content classifiers, revalidates them against
  the live-agent inventory before resuming, and confirms the preselected
  "continue" option through `agent send-keys enter`. Tmux scanning is
  unchanged and remains pane-grammar-gated (`%N` only); herdr panes never
  reach tmux helpers.
- **`omc` launch** (`src/cli/launch.ts`): with the herdr backend selected,
  `omc` launches Claude as a tab in a fresh Herdr workspace labelled with the
  tmux session identity (`omc-<dir>-<branch>-<ts>`), reusing the same env
  forwarding and 0600 credential transport as the tmux paths. OMX prints
  attach guidance for the Herdr TUI instead of attaching (the Herdr server
  owns the pane). A Herdr failure falls back to the default tmux/direct flow.

## Limitations

- HUD watch panes, tmux layout options, and clipboard configuration are
  tmux-only concepts and are skipped on the herdr backend (the Herdr sidebar
  with per-agent working/blocked/done states replaces the HUD).
- Windows psmux paths remain tmux-specific.
