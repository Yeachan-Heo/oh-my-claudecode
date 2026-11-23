# Provider workers

Provider workers run Claude Code sessions and `omc team` workers against an alternative endpoint that speaks the Anthropic API. The provider is configuration: a profile in `providers.jsonc` names the base URL, the key source, the model identifiers and the limits. Nothing in the tools is tied to one provider. A preset for one provider is in `examples/provider/zai.providers.jsonc` (see the last section).

This page is the reference for the provider tools. Each part of the feature adds its own chapter below.

## Profile file

- Location: `OMC_PROVIDER_PROFILES_FILE` when set, else `$XDG_CONFIG_HOME/claude-omc/providers.jsonc`, else `$HOME/.config/claude-omc/providers.jsonc`.
- Format: JSONC (`//` and `/* */` comments). Top level: `defaultProfile` (optional) and `profiles` (object of named profiles).
- Selection: `OMC_PROVIDER_PROFILE`, else `defaultProfile`, else the only profile in the file. Otherwise the tool exits with code 2.
- Without a profiles file no provider tool changes any session or team. Nothing is created on disk.
- Environment overrides: an `OMC_PROVIDER_*` variable that is set, non-empty and valid wins over the file.

## Profile schema

Every field has a neutral default. Unknown fields are a warning on stderr, not an error. Wrong types or ranges exit with code 2 and name the field.

| Field | Type | Default | Notes |
|---|---|---|---|
| `baseUrl` | URL string | required | Endpoint of the provider: `https`, or `http` for a loopback host (`127.0.0.1`, `localhost`, `[::1]`); any other scheme or an `http` remote host is a validation error (exit 2). |
| `apiKey` | object with exactly one of `file`, `env`, `command` | required | `file`: path (`~` expanded), the file holds only the key. `env`: name of the variable; `provider-team` forwards that variable to the worker panes so that a provider role can read the key, and a worker on a Claude role does not keep it in its environment. `command`: executable run without a shell, 10 s limit. |
| `models.opus`, `models.sonnet` | `{ id, name?, description? }` | `id` required | Identifiers of the large models. |
| `models.haiku` | same | optional | When absent, `sonnet` is used for the haiku tier. |
| `models.default` | `opus`, `sonnet` or `haiku` | `sonnet` | Model of the main session. |
| `shimNames` | string[] | `[]` | Extra shim names next to `claude`. |
| `claudeBinary` | path or null | null | Real `claude` binary. |
| `stateDir` | path | `~/.omc/state/provider/<profile>` | State directory of the profile. |
| `modelIdPrefixes` | string[] | `[]` | Exported as `OMC_PROVIDER_MODEL_PREFIXES`. |
| `contextWindow` | integer | `200000` | Auto-compaction window in tokens. |
| `requestTimeoutMs`, `shellTimeoutMs` | integer | `3000000`, `660000` | Request timeout and shell-tool timeout. |
| `subagentModel` | string or null | null | Model for subagents. |
| `roles` | string[] | `["executor"]` | Roles that run on this provider. |
| `worker.model`, `worker.effort` | alias or id, `low`, `medium`, `high`, `xhigh`, `max` | `sonnet`, `high` | Model and effort of worker roles. |
| `worker.tools` | string[] | `Bash, Read, Edit, Write, Grep, Glob` | Tool list of workers. |
| `worker.maxToolCalls` | integer | `0` | `0` means no limit. |
| `worker.mcp` | `none` or `inherit` | `none` | |
| `worker.disableJev` | boolean | `true` | Sets `OMC_JEV=off` for worker environments. |
| `worker.ruleFile` | path or null | null | Rule text appended to the worker prompt. |
| `launch.disableJevInPrintMode`, `launch.jevWithoutCompaction` | boolean | `false`, `false` | Switches for print-mode sessions. |
| `envPassthrough.names`, `envPassthrough.prefixes` | string[] | `[]`, `[]` | Extra variables passed to executor environments. |
| `limits.maxSessions` | integer | `4` | Concurrent sessions on this profile. |
| `limits.slotWaitMs` | integer | `120000` | Wait for a free session slot. |
| `quota.*` | see below | adapter `none` | Quota gate, configured in its own chapter. |
| `errorCodes.quota`, `errorCodes.throttle` | integer[] | `[]`, `[]` | Provider error codes classified as quota or throttle. |
| `proxy.port`, `proxy.maxConcurrency`, `proxy.idleTimeoutSeconds`, `proxy.clientToken`, `proxy.hostCheck`, `proxy.nonRetryableBodyPatterns` | see proxy chapter | port null, `4`, `0`, `auto`, `true`, `[]` | Local proxy. |
| `proxy.retryMaxAttempts`, `proxy.retryBaseDelayMs`, `proxy.retryMaxDelayMs`, `proxy.retryAfterCapMs`, `proxy.retryJitterMs`, `proxy.maxBufferedBodyBytes`, `proxy.heldBodyCapBytes`, `proxy.connectTimeoutMs`, `proxy.responseHeaderTimeoutMs`, `proxy.stopGraceMs`, `proxy.logMaxBytes` | whole numbers (see the option table of the proxy chapter for the ranges) | `0`, `1000`, `30000`, `120000`, `0`, 64 MiB, 64 KiB, `30000`, `300000`, `2000`, 8 MiB | Tuning of the local proxy. |
| `guard.blockedCommands`, `guard.allowedCommands`, `guard.extraProtectedPatterns`, `guard.extraProtectedPaths` | string[] | `claude`, `claude-code`, `provider-launch`, `provider-worker`, `provider-team`, `provider-task`; `provider-advisor`; `[]`; `[]` | Lists of the Bash guard. A blocked name is also matched with a `.cjs` or `.mjs` extension, by path and as the script run through `node` or a shell (`node provider-launch.cjs`); the advisor file is refused unless called by its bare command name. |
| `advisor.claudeBinary`, `advisor.commandName`, `advisor.defaultModel`, `advisor.models`, `advisor.timeoutSeconds`, `advisor.roleFile` | path or null, string, string, string[], integer, path or null | null, `provider-advisor`, `opus`, `["opus","sonnet","fable"]`, `600`, null | Advisor consultation (see the advisor chapter). |
| `advisor.limits.perTask`, `advisor.limits.perGroup`, `advisor.limits.topSlots`, `advisor.limits.queueWaitMs` | integer | `4`, `4`, `2`, `15000` | Consultation limit per task and per group, top-model bucket slots and the wait in its queue. |
| `rescue.mode`, `rescue.threshold`, `rescue.advisorLimit` | `off`, `shadow`, `active`; integers | `off`, `2`, `2` | Rescue hooks. |

Key sources are read only by `provider-key-helper.cjs`, in memory, and are never printed. Error messages name fields, never key values or key file paths.

## Environment variables

One table lists every `OMC_PROVIDER_*` variable that the tools read or set. "Default" is what applies when the variable is unset. "Scope" says which tool reads it and whether the variable is meant for users, set by the tools themselves, or only for tests. An override that is set, non-empty and valid wins over the profile. An override with an invalid value ends the tool with exit code 2; the one exception is the worker wrapper, which drops an invalid value of `OMC_PROVIDER_WORKER_MODEL`, `OMC_PROVIDER_WORKER_EFFORT`, `OMC_PROVIDER_MAX_SESSIONS`, `OMC_PROVIDER_SLOT_WAIT_MS` or `OMC_PROVIDER_MAX_TOOL_CALLS` and loads the profile again, so a role that does not run on the provider is not affected; a provider role is then aborted with exit code 2 and an `aborted-bad-config` event (an invalid tool call limit counts as 0). The advisor is the second exception: a profile that cannot be loaded never blocks a consultation, and the advisor falls back to the defaults of the `advisor` section (a message names the cause on stderr unless the profile is simply missing).

| Variable | Default | Scope |
|---|---|---|
| `OMC_PROVIDER_PROFILES_FILE` | `$XDG_CONFIG_HOME/claude-omc/providers.jsonc`, else `$HOME/.config/claude-omc/providers.jsonc` | All tools: path of the profiles file. |
| `OMC_PROVIDER_PROFILE` | `defaultProfile`, else the only profile | All tools: name of the profile. |
| `OMC_PROVIDER` | unset | Set by the session settings: marker that holds the profile name. It enables the guard and the refusals inside a provider process. |
| `OMC_PROVIDER_SETTINGS_FILE` | unset | Set by the session settings: the `--settings` copy of the session. |
| `OMC_PROVIDER_STATE_DIR` | `stateDir` of the profile | All tools: state directory. Copied into the settings env block for the hooks. |
| `OMC_PROVIDER_PROFILES_FILE` (in the settings env block of a worker) | the profiles file the wrapper loaded | Set by the worker wrapper: the advisor and the rescue hook in the session load the same profile (its advisor models), not only the one at the default path. A path, never a secret. |
| `OMC_PROVIDER_SHIM_DIR` | `<stateDir>/shims`; workers `<stateDir>/shims-worker` | Launcher and worker wrapper: shim directory. |
| `OMC_PROVIDER_ROLES` | `roles` of the profile | Worker wrapper: comma-separated list of roles that run on the provider. |
| `OMC_PROVIDER_WORKER_MODEL`, `OMC_PROVIDER_WORKER_EFFORT` | `worker.model`, `worker.effort` | Worker wrapper: model and effort of provider roles. |
| `OMC_PROVIDER_MAX_TOOL_CALLS` | `worker.maxToolCalls` (`0`) | Worker wrapper and hook: tool call limit of a worker. A single `omc team api` command for a task (`claim-task`, `transition-task-status`, `release-task-claim`, `renew-task-claim`, `send-message`, `read-task`) is neither counted nor denied, so a worker can still report or hand back the task after the limit. |
| `OMC_PROVIDER_MAX_SESSIONS`, `OMC_PROVIDER_SLOT_WAIT_MS` | `limits.maxSessions` (`4`), `limits.slotWaitMs` (`120000`) | Launcher and worker wrapper: session limit and slot wait. |
| `OMC_PROVIDER_POOL_DIR`, `OMC_PROVIDER_STOP_PATTERN` | `quota.pool.dir`, `quota.stopPattern` (none) | Quota guard: pool directory and stop pattern. |
| `OMC_PROVIDER_GUARD` | built from `guard.*` | Set by the settings: JSON configuration of the Bash guard. |
| `OMC_PROVIDER_FILE_ROOT` | `OMC_TEAM_WORKTREE_PATH` | Bash guard and advisor input: base directory of file paths. |
| `OMC_PROVIDER_TASK_ID` | unset | Set for a task team: task key of the hooks (8 hex characters). |
| `OMC_PROVIDER_RESCUE`, `OMC_PROVIDER_RESCUE_THRESHOLD`, `OMC_PROVIDER_RESCUE_ADVISOR_LIMIT` | `rescue.mode` (`off`), `rescue.threshold` (`2`), `rescue.advisorLimit` (`2`) | Rescue hooks. Written to the settings env block of a worker. |
| `OMC_PROVIDER_MODEL_PREFIXES` | `modelIdPrefixes` | Set by the session settings (comma-separated): model prefixes accepted by the model gate. |
| `OMC_ALLOW_LOOPBACK_PROXY_PORT` | unset | Set by the session settings while a local proxy is used. |
| `OMC_PROVIDER_ADVISOR_COMMAND` | `advisor.commandName` (`provider-advisor`) | Set by the worker wrapper: name of the advisor command that the rescue hooks print. |
| `OMC_PROVIDER_ADVISOR_MODEL` | `advisor.defaultModel` (`opus`) | Advisor and rescue hooks: advisor model, one of `advisor.models` (`opus`, `sonnet`, `fable`). Another value is refused with exit code 2. The worker wrapper resolves the value written to the settings env block with the selected profile (its default and its list); the rescue hook and the advisor check it against the same profile. |
| `OMC_PROVIDER_ADVISOR_PROTOCOL` | unset | Advisor: role profile (`plan`, `rescue` or `final`); takes effect only with `OMC_PROVIDER_ADVISOR_INPUT=1`. |
| `OMC_PROVIDER_ADVISOR_INPUT` | off | Advisor: `1` turns on the shaped input and the verdict mode. |
| `OMC_PROVIDER_ADVISOR_JOURNAL` | off | Advisor: `1` turns on the two-row consultation journal and makes the event parameter required. |
| `OMC_PROVIDER_ADVISOR_EVENT` | unset | Advisor: event of the consultation (`plan`, `test-failure`, `final`, `other`) when `--event` is not given. |
| `OMC_PROVIDER_ADVISOR_LOG_FILE` | `<stateDir>/advisor.jsonl` | Advisor and task journal: advisor journal file. |
| `OMC_PROVIDER_ADVISOR_LIMIT` | off | Advisor: `1` turns on the consultation limit and the top-model queue. |
| `OMC_PROVIDER_ADVISOR_LIMIT_PER_TASK`, `OMC_PROVIDER_ADVISOR_LIMIT_PER_GROUP` | `advisor.limits.perTask` (`4`), `advisor.limits.perGroup` (`4`) | Advisor limit: consultations per task and per group (the team of the worker). |
| `OMC_PROVIDER_ADVISOR_TOP_SLOTS`, `OMC_PROVIDER_ADVISOR_QUEUE_WAIT_MS` | `advisor.limits.topSlots` (`2`), `advisor.limits.queueWaitMs` (`15000`) | Advisor limit: slots of the top-model bucket and the wait in its queue. |
| `OMC_PROVIDER_ADVISOR_LIMIT_FILE` | `<stateDir>/advisor-limit.json` | Advisor limit: state file. |
| `OMC_PROVIDER_ADVISOR_DIFF_BASE` | `HEAD` | Advisor input: git ref the task diff is taken against. |
| `OMC_PROVIDER_ADVISOR_CAP_INPUT` | `250000` | Advisor input: hard cap of the whole input, characters. |
| `OMC_PROVIDER_ADVISOR_CAP_FILE`, `OMC_PROVIDER_ADVISOR_CAP_FILES_TOTAL` | `50000`, `200000` | Advisor input: bytes per named file and in total. |
| `OMC_PROVIDER_ADVISOR_CAP_FILE_COUNT` | `6` | Advisor input: number of named files and of untracked files. |
| `OMC_PROVIDER_ADVISOR_CAP_DIFF_FILE` | `24000` | Advisor input: characters of the diff of one file. |
| `OMC_PROVIDER_ADVISOR_CAP_MATERIAL_HEAD`, `OMC_PROVIDER_ADVISOR_CAP_MATERIAL_TAIL` | `1800`, `1200` | Advisor input: head and tail kept of a long field. |
| `OMC_PROVIDER_ADVISOR_CAP_ADVICE` | `4000` | Advisor verdict mode: protective cap of the advice text, characters. |
| `OMC_PROVIDER_ADVISOR_CLAUDE_BIN` | `advisor.claudeBinary`, else the first `claude` on `PATH` outside generated shims | Test only: claude binary of the advisor. |
| `OMC_PROVIDER_ADVISOR_TIMEOUT_MS` | `advisor.timeoutSeconds` times 1000 (`600000`) | Test only: time limit of a consultation. |
| `OMC_PROVIDER_ADVISOR_ROLE_FILE` | `advisor.roleFile`, else `templates/provider/advisor-role.md` | Test only: plain text role file that replaces the role. |
| `OMC_PROVIDER_TASK_LOG` | on | Task journal: `off` disables `provider-task-log.cjs write`. |
| `OMC_PROVIDER_TASK_LOG_ROTATE_BYTES` | 8 MiB | Task journal: size at which `tasks.jsonl` rotates to `tasks.jsonl.1`. |
| `OMC_PROVIDER_PROXY_PROFILE` | none | Proxy: profile to read. |
| `OMC_PROVIDER_PROXY_UPSTREAM` | profile `baseUrl` | Proxy: provider base URL; from the environment it must be a loopback address. |
| `OMC_PROVIDER_PROXY_API_KEY_COMMAND`, `OMC_PROVIDER_PROXY_API_KEY_FILE`, `OMC_PROVIDER_PROXY_API_KEY_ENV` | profile `apiKey` | Proxy: key source. |
| `OMC_PROVIDER_PROXY_DIR` | `<profile stateDir>/proxy` | Proxy: state directory. |
| `OMC_PROVIDER_PROXY_PORT` | `33177` | Proxy: loopback port (`0` = a free port). |
| `OMC_PROVIDER_PROXY_MAX_CONCURRENCY` | `4` | Proxy: requests in flight to the provider. |
| `OMC_PROVIDER_PROXY_IDLE_TIMEOUT` | `0` | Proxy: seconds of idleness before the server stops (`0` = never). |
| `OMC_PROVIDER_PROXY_RETRY_MAX_ATTEMPTS`, `OMC_PROVIDER_PROXY_RETRY_BASE_DELAY_MS`, `OMC_PROVIDER_PROXY_RETRY_MAX_DELAY_MS`, `OMC_PROVIDER_PROXY_RETRY_AFTER_CAP_MS`, `OMC_PROVIDER_PROXY_RETRY_JITTER_MS` | `0`, `1000`, `30000`, `120000`, `0` | Proxy: retry tuning. |
| `OMC_PROVIDER_PROXY_MAX_BODY_BYTES`, `OMC_PROVIDER_PROXY_HELD_BODY_CAP_BYTES` | 64 MiB, 64 KiB | Proxy: request body kept for replay and held part of a 429/5xx body. |
| `OMC_PROVIDER_PROXY_CONNECT_TIMEOUT_MS`, `OMC_PROVIDER_PROXY_RESPONSE_HEADER_TIMEOUT_MS`, `OMC_PROVIDER_PROXY_STOP_GRACE_MS` | `30000`, `300000`, `2000` | Proxy: timeouts. |
| `OMC_PROVIDER_PROXY_LOG_MAX_BYTES` | 8 MiB | Proxy: size at which `proxy.log` rotates. |
| `OMC_PROVIDER_PROXY_CLIENT_TOKEN` | `auto` | Proxy: `auto`, `none` or a token of at least 8 characters. |
| `OMC_PROVIDER_PROXY_NON_RETRYABLE_PATTERNS` | none | Proxy: JSON array of regular expressions of bodies that are not retried. |
| `OMC_PROVIDER_PROXY_TEST_UPSTREAM` | none | Test only: upstream override, a loopback address. |
| `OMC_PROVIDER_BASE_URL` | none | Test only: loopback base URL (`127.0.0.1`, `localhost` or `[::1]`). Requires `OMC_PROVIDER_API_KEY_FILE`. |
| `OMC_PROVIDER_API_KEY_FILE` | none | Test only: key file read by `provider-key-helper.cjs`. Requires a loopback `OMC_PROVIDER_BASE_URL`. |
| `OMC_PROVIDER_CLAUDE_BIN` | `claudeBinary` of the profile, else the first `claude` on `PATH` outside generated shims | Test only: real or fake `claude` binary of the launcher, the wrapper and `provider-task doctor`. |
| `OMC_PROVIDER_QUOTA_URL` | none | Test only: origin of a loopback quota endpoint; the path comes from `quota.url`. |
| `OMC_PROVIDER_STOP_KILL_MS` | `10000` | Test only: delay between SIGTERM and SIGKILL of the quota guard. |
| `OMC_PROVIDER_TASK_OMC_BIN`, `OMC_PROVIDER_TASK_TEAM_BIN`, `OMC_PROVIDER_TASK_GIT_BIN` | `omc`, `provider-team`, `git` | Test only: replacements for the binaries used by `provider-task` and the task journal. |
| `OMC_PROVIDER_TASK_RESULT_MODULE`, `OMC_PROVIDER_TASK_LOG_MODULE` | `lib/task-result.cjs`, `provider-task-log.cjs` | Test only: replacements for the modules loaded by `provider-task`. |
| `OMC_PROVIDER_TASK_LOCK_LIMIT_MS`, `OMC_PROVIDER_TASK_START_LOCK_LIMIT_MS`, `OMC_PROVIDER_TASK_POLL_MS` | `10000`, `300000`, `2000` | Test only: limit of the task file lock, start-lock limit and poll interval of `_start`. |
| `OMC_PROVIDER_TASK_NOW` | the clock | Test only: clock of the grace period in `provider-task status` and `result` (milliseconds or an ISO date). |

Variables that an executor never receives: credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) and every `OMC_PROVIDER_*` variable of the parent process. The executor and its hooks receive only the names in `HOOK_ENV` from the settings env block, plus the validated advisor controls of the lead (`ADVISOR_CONTROLS` in `lib/env.cjs`: the switches `_INPUT`, `_JOURNAL` and `_LIMIT`, `_PROTOCOL`, `_EVENT`, the limits, queue wait and `_CAP_*` caps as positive integers, `_DIFF_BASE`, and `_LOG_FILE` and `_LIMIT_FILE` as absolute paths). The wrapper copies a control only when its value passes the check, and reports a rejected one by name on stderr. The test-only advisor variables are never copied. A loopback base URL is accepted only together with the key file variable, so a forgotten test variable cannot send a real key to a foreign address.

## Quota guard

Profile fields: `quota.adapter` (`monitor-limits` or `none`), `quota.url` (full endpoint URL), `quota.authScheme` (`bearer` or `raw`), `quota.thresholds` (`pause`, `stop`, `weeklyAsWindow`), `quota.exhaustedPercent`, `quota.cacheSeconds`, `quota.pool.dir`, `quota.pool.markers`, `quota.stopPattern`. With adapter `none` there is no quota gate and no guard.

- `provider-quota [--json]` prints the plan, the 5 h window and the week without starting a model. Exit 3 means the key is missing, exit 4 means the read failed.
- `provider-quota-guard.cjs --once` runs one round. Without `quota.pool.dir` or `quota.stopPattern` (or their variables) it exits with code 2 and writes nothing. The guard reads the quota every 60 s (every 20 s from 85 %). At the pause threshold it creates the `PAUSE` marker. At the stop threshold it also creates `STOP` and sends SIGTERM to processes matching `quota.stopPattern` together with their descendants; survivors get SIGKILL after `OMC_PROVIDER_STOP_KILL_MS`. Each stopped match is recorded in `aborted.tsv` (time, pid, `--settings` file, cwd, session id). The state file `QUOTA-STATE` and the log `quota-guard.log` are written next to the markers.
- The gate before a worker start refuses with code 4 when a breaker is set, when a pool marker exists, when the key is rejected, or when a window is at or above a threshold. A failed read lets the start through (fail-open), but an existing pool marker still refuses. A refusal caused by quota writes `breaker.json` in the state directory until the reset time.
- Files in the state directory: `breaker.json`, `quota-cache.json` (successful responses only, cache lifetime `quota.cacheSeconds`), `slots/` (one `slot-*.json` per running session; the lock is `slots/.lock`).

## Task result and journal

- `lib/task-result.cjs` evaluates a task result without side effects (`evaluateResult`). Three native OMC channels feed it: a worker status `blocked` with a reason, a `failed` task with an error, and a `completed` task whose result is a DoneClaim. The DoneClaim is parsed strictly: lines `Key: value` with the keys `Summary`, `Files`, `Verification`, `Risks`, `Status`, `Gaps`, `Required`, `Unverified`, `Cause`, `Evidence`, `Points`, `Subagent skip reason`, `Subagent spawn evidence`; unknown keys, duplicates and bad values give `unknown` for review. A first non-empty line `NEED: <request>` or `ESCALATE: <lane>` is a request for a decision (`blocked` with cause `needs_decision`). The announcement and permission-question heuristics match English worker output. A journal class `integrity` (the worker changed the shared part of `.git`) turns the evaluation of every channel except `killed` (a completed claim, a request for a decision, a blocked task, a task in progress) into `failed` with a handoff. The class comes from the `integrity` event row of the wrapper, and also from a live comparison of `.git` with the baseline that the wrapper wrote at the start of the worker, until the wrapper has run its own check, because a worker posts its result before `claude` exits. A verdict that was saved earlier as anything but `failed` or `killed` is turned into `failed` once, by the next `provider-task result`, when the class appears later.
- `evaluateMissingTask` decides what a missing OMC task means: start-lock queue, a 60 s grace period, a dead `_start` process, or a queue ceiling (start-lock limit plus 120 s).
- A task result is checked with one read: `provider-task status ID` shows the state and the OMC task, and `provider-task result ID` evaluates the result once (the verdict is written to the task file before printing and never overwritten). The task file lives in `<stateDir>/tasks/<id>.json` and every access takes `<id>.json.lock`. `provider-task` has no time limit of its own that ends a running task: a task that does not finish is ended with `provider-task kill ID`.
- `provider-task-log.cjs <id>` prints the journal row of a task (tokens, turns, Bash calls, window fill, consultations, warnings, branch and change counts) built from the worker transcript, `<stateDir>/workers.jsonl` and `<stateDir>/advisor.jsonl`; `provider-task-log.cjs write <id>` appends it once to `<stateDir>/tasks.jsonl`. The row reaches `tasks.jsonl` only when `provider-task-log.cjs write <id>` is called explicitly: `provider-task status`, `result` and `kill` do not append it (and `result` prints the `header` only when the journal already has a row). The row carries no task text, paths or secrets. The context window is `contextWindow` for the profile models and ids with a `[1m]` suffix, 200000 otherwise.

## Task lifecycle (`provider-task`)

`provider-task.cjs` runs one task as a team of one worker over `omc team`. The worker is `executor`, started through `provider-team`, so it runs on the provider of the profile. It does not change plain `omc team`.

| Subcommand | What it does |
|---|---|
| `start [--cwd DIR] [--brief FILE] [--max-tool-calls N] [--] TEXT` | Checks the quota gate (exit 4) and a free session slot without taking it (exit 3), writes the task file, starts a detached `_start` process and prints the 8-character id at once. The task text starts with `ptask-<id> `. With `--brief` the text says to read that file in full and carry it out. The command refuses to run inside a provider session or with a foreign `ANTHROPIC_BASE_URL` (exit 2). |
| `status ID` | One JSON line: `id`, `team`, `start`, `cwd`, `brief`, `start_exit_code`, `start_error`, `max_tool_calls`, `verdict_ts`, `status`, `worker`, `task`. A found OMC task wins over `start_exit_code` (in `status` and `result` alike: `start_failed` is a verdict only when no OMC task was found); a failed `omc team api` call shows `in_progress`; `start_failed` and `pending` come from the missing-task evaluation. |
| `result ID` | Evaluates the result (see above), writes `verdict` and `verdict_ts` before printing and never overwrites a verdict of a parallel process, then prints the evaluation with `result_raw` and, when the task journal has a row, `header`. `in_progress` is not written. |
| `kill ID` | Writes `killed`, then runs `omc team shutdown <team> --force`; the exit code is that of `omc`. A launcher that is still waiting for the start lock sees `killed` (or an already written verdict) when it takes the lock and ends without starting the team. |
| `list [--refresh]` | Statuses of all task files; `--refresh` asks `omc team api list-tasks` for each. |
| `doctor` | Smoke test: runs `claude -p "Reply with just: ok" --output-format json` with the settings of a provider worker (model and effort from `worker.model` and `worker.effort`, no MCP). Exit 0 when the answer comes from the model id of the profile (with or without the suffix `[1m]`), 4 for exhausted quota, 3 without a key, 2 for bad configuration or another model, 127 without a usable `claude` binary, 1 otherwise. |

Files (in `<stateDir>`): `tasks/<id>.json` (fields `id`, `team`, `start`, `cwd`, `brief`, `text`, `max_tool_calls`, `start_pid`, `start_pid_starttime`, `omc_started_at`, `queue_ts`, `start_exit_code`, `start_error`, `verdict`, `verdict_ts`, `killed`), `tasks/<id>.log` and `tasks/<id>.err.log` (output of `_start` and of `provider-team`), `locks/start-<hash>.lock` (one start per working directory at a time). The task file is read and written under `<id>.json.lock`. The team state directory is `<omc root>/state/team`, where the omc root is the one of `scripts/lib/state-root.cjs`, the same root that `omc team` uses.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK. |
| 1 | Execution failure. |
| 2 | Bad configuration or usage. |
| 3 | Missing key, missing session slot or missing shim target. |
| 4 | Refused by the quota gate. |
| 5 | Unknown worker role. |
| 124 | Advisor timeout. |
| 127 | Binary missing or cannot be run. |
| 128 + n | Process killed by signal n. |

## Vocabulary

Values used in state files and output. Defined in `scripts/provider/lib/vocab.cjs`; add a word there and here in the same commit.

| Area | Values |
|---|---|
| Result status | `success`, `partial_success`, `blocked`, `failed`, `capped`, `budget_stopped`, `unknown`, `in_progress` |
| Cause | `model`, `task_engine`, `environment`, `provider_429`, `quota`, `timeout`, `idle`, `no_access`, `needs_decision`, `check_failed`, `worker_dead`, `start_failed`, `empty_response`, `very_short_run` |
| Failure class | `auth`, `quota`, `throttle`, `infra`, `advisor`, `other`, `integrity` |
| Gate reason | `breaker`, `pool`, `auth`, `quota` |
| Quota level | `PAUSE`, `STOP`, `WORK` (below both thresholds; written to `QUOTA-STATE`) |
| Worker event result | `aborted-no-key`, `aborted-quota`, `aborted-bad-config`, `aborted-no-role`, `aborted-no-slot`, `end`, `integrity` |
| Advisor status | `ok`, `empty-answer-on-zero-exit`, `no-verdict`, `no-advice`, `stale`, `invalid-citations`, `stop`, `refused-limit`, `refused-task-limit`, `refused-missing-decision`, `refused-path`, `refused-env`, `refused-event`, `queue-timeout`, `timeout`, `error`, `aborted`, `empty-question`, `bad-model`, `input-error`, `start-error`, `no-binary`, `no-role`, `json-error`, `response-error`, `from-journal`, `limit-error` |
| Advisor verdict | plan `LGTM`, `CONCERNS`; rescue `proceed`, `proceed-with-changes`, `reconsider`; final `GO`, `STOP` |
| Advisor token | `ADVISOR: change`, `ADVISOR: confirm`, `ADVISOR: reject` |
| Advisor event | `plan`, `test-failure`, `final`, `other` |
| Advisor status group (summary read) | `delivered`, `advice_unavailable`, `refusals`, `errors` |
| Advisor protocol line | `TOKEN:`, `VERDICT:`, `CONCERN n:`, `SOURCE:`, `SUMMARY:`, `ACCEPTANCE CRITERIA:`, `INPUT TOKEN:` |
| Advisor parser reason | `empty`, `no-input-token`, `announcement`, `no-control-line`, `wrong-token`, `no-verdict`, `verdict-outside-dictionary`, `concerns-with-lgtm`, `wrong-concern-count`, `no-summary` |
| Advisor citation reason | `unparsed`, `file-not-shown`, `line-outside-shown` |
| Advisor question field | `DECISION`, `TRIED`, `TEST TAIL`, `HYPOTHESIS`, `EVIDENCE`, `FILES`, `QUESTION` (text before the first field) |
| Advisor role sections | `COMMON`, `PLAN`, `RESCUE`, `FINAL`, `DEFAULT` |
| Advisor limit line | `ADVISOR-LIMIT: <n> left` (`no data` when the state cannot be read) |
| Advisor journal row type | `start`, `end`, `cache`; with the journal switch off one metadata row without a `type` field is written |
| Advisor journal fields | `ts`, `type`, `consultation_id`, `job_id`, `task`, `worker`, `number`, `event`, `failure_no`, `model`, `input_hash`, `size`, `files`, `shown`, `head`, `decision_chars`, `token`, `diff_hash`, `status`, `duration_ms`, `question_chars`, `answer_chars`, `cost_usd`, `tokens_in`, `tokens_out`, `model_usage`, `advice`, `verdict`, `parser_reason`, `citations_total`, `citations_valid`, `citations_invalid`, `stale`, `token_ok`, `concerns_count`, `criteria_chars`, `cap_trimmed`, `limit_reason`, `limit_left`, `limit_error`, `retry_429`, `hit`, `source_id` |
| Advisor limit state fields (`advisor-limit.json`) | `v`, `tasks`, `groups` (entries `used`, `reserved`, `ts`), `slots` (entries `id`, `task`, `group`, `pid`, `start`, `ts`), `top`, `queue` |
| Task warning (journal) | `very_short_run`, `empty_response`, `success_without_changes`, `model_mismatch` |
| Task journal fields | `duration_s`, `window_percent`, `tokens_in`, `tokens_out`, `tokens_cache`, `turns`, `bash_calls`, `bash_failures`, `bash_last_code`, `consultations`, `warnings`, `class`, `branch`, `base_sha`, `files_changed`, `added`, `removed` |
| Task file fields | `id`, `team`, `start`, `cwd`, `brief`, `text`, `max_tool_calls`, `verdict`, `verdict_ts`, `killed`, `abandon`, `start_exit_code`, `start_error`, `start_pid`, `start_pid_starttime`, `omc_started_at`, `queue_ts` |
| `provider-task result` output | evaluation fields, `result_raw` (result of the OMC task), `header` (one line of the task journal) |
| `provider-task` OMC statuses | `pending`, `in_progress`, `blocked`, `completed`, `failed` (OMC), plus `killed` and `start_failed` |
| Rescue event (`rescue.jsonl`) | `failure`, `hint`, `denial`, `consultation`, `consultation-failure`, `reset`, `breaker`, `park` |
| Rescue counter fields (`tasks/<key>/counter.json`) | `failed_checks`, `gate_denials`, `rounds`, `repeats`, `signature`, `failures`, `failures_previous`, `consultations`, `awaiting_consultation`, `parked`, `parked_written`, `breaker`, `last_green_ts`, `last_denial_ts`, `last_error` |
| Call counter file | `tasks/<key>/calls.json` (tool calls of a worker, read by the call limit hook) |
| Task team name | `ptask-<8 hex>` optionally followed by `-` and text (`TASK_TEAM_RE`, `taskSubject` in `vocab.cjs`) |

## Settings written for a session

The session settings file (`lib/settings.cjs`, `addProvider`) carries:

- `env`: the provider environment (`providerEnv`: base URL, model identifiers and names, timeouts, flags), the markers `OMC_PROVIDER` and `OMC_PROVIDER_SETTINGS_FILE`, `PATH` with the shim directory first, and an optional token.
- `apiKeyHelper`: `node provider-key-helper.cjs --profile <name>` with the profiles file path set for the helper. Removed when a token is in the env, because Claude Code warns when both are set.
- `permissions.allow`: the worker tool list (executor roles only).
- `hooks.PreToolUse`: the Bash guard. If the guard is missing or fails, the call is denied.

Shims: each shim checks that its target exists and runs it with `node`; a missing target exits with code 3.

Copies of settings files are named `provider-*.json`, `worker-*.json`, `doctor-*.json` or `*-provider.json`; copies older than two days are removed at the next start.

## Session launcher

`provider-launch.cjs` runs `claude` on the provider. It takes the `--settings <file>` of the arguments it is given (so it can be used as the starter of a launcher that passes such a file), writes a copy named `<original name>-provider.json` next to it (0600; a repeated start overwrites the same copy) and starts the real `claude` with the copy. The copy carries the provider environment, `PATH` with the shim directory first, the Bash guard hook and, in the env block, the key as `ANTHROPIC_AUTH_TOKEN` (the apiKeyHelper entry is removed then). While the local proxy of the profile runs, the copy carries the proxy address and the client token instead, and the key stays with the proxy.

- The key is read through the key helper in memory only; without a usable key the start is aborted with exit 3 before `claude` is called. The quota gate runs after that and before the settings file is read (exit 4 on refusal).
- A session slot is taken before the start and released when the child ends (`limits.maxSessions`, `limits.slotWaitMs`). A background session returns right after its start, so the slot then counts the moment of starting.
- The child environment is built from an allow-list (session variant: the terminal and `CLAUDE_CONFIG_DIR` variables, `SSH_AUTH_SOCK`, `XDG_RUNTIME_DIR` and names with the prefix `OMC_JEV`); credentials never reach it. `SIGTERM`, `SIGINT` and `SIGHUP` are passed to the child and the launcher exits with 128 plus the signal number.
- `launch.disableJevInPrintMode` (default `false`): in print mode (`-p`, `--print`) set `OMC_JEV=off` in the copy and in the child environment, because compaction cannot run in a headless session. `launch.jevWithoutCompaction` (default `false`): an inherited `OMC_JEV` value reaches the copy with the compaction point switched off. With both at their defaults the launcher changes nothing about `OMC_JEV`.
- The real binary: `OMC_PROVIDER_CLAUDE_BIN`, then `claudeBinary` of the profile, then the first `claude` on `PATH` outside generated shims.

## Worker shim and team wrapper

`provider-worker.cjs` is the `claude` of a worker pane. `provider-team.cjs` starts `omc team` with a directory first on `PATH` whose `claude` shim runs `provider-worker.cjs`, and with `OMC_TRUSTED_CLI_DIRS` naming that directory. Plain `omc team` is unchanged.

Modes of `provider-worker.cjs`, chosen from the environment:

1. `OMC_PROVIDER_SETTINGS_FILE` is set (a child process of a provider session): `--settings <that file>` is added at the end of the arguments (before `--` when present). A missing file exits with 3.
2. `OMC_TEAM_WORKER` is set (a worker of `omc team`): a role listed in `roles` runs on the provider, every other role on Claude with the provider variables removed from the environment. The removed set also contains `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`, so a Claude worker that finds a foreign `ANTHROPIC_BASE_URL` in its environment never sends a credential to that endpoint; a worker that authenticates only through one of these variables loses that credential on purpose. Without `OMC_TEAM_ROLE` the role comes from the team state (`config.json`, then `manifest.json`); if no source names it the exit code is 5.
3. Otherwise `claude` is started with the arguments unchanged; a foreign `ANTHROPIC_BASE_URL` or a provider marker without session settings refuses (exit 3). When nothing is configured (no profiles file and no `OMC_PROVIDER_PROFILE`), the wrapper passes calls through unchanged. When a profiles file exists but no usable profile is selected (`OMC_PROVIDER_PROFILE` or `defaultProfile` names a profile that is not defined, several profiles and no selection, or `OMC_PROVIDER_PROFILE` without a profiles file), a worker exits with code 2 and does not start `claude`, because starting it would skip the credential, quota and session checks of the provider that was chosen.

A provider role gets: `--settings` from `<stateDir>/worker-settings/` (0600, no key inside, copies older than two days are removed), the tool list and `--permission-mode dontAsk` (the `--dangerously-skip-permissions` flag is dropped), `--disallowedTools AskUserQuestion`, an empty MCP configuration when `worker.mcp` is `none`, `--model` and `--effort` from `worker.model` and `worker.effort`, `--session-id`, the key as `ANTHROPIC_AUTH_TOKEN` in the process environment only (the proxy client token while the proxy runs), and a session slot. The worker rule file (`worker.ruleFile`, default `templates/provider/worker-rule.md`) is appended to the system prompt when the advisor script `provider-advisor.cjs` sits next to the wrapper; the advisor shim (named by `advisor.commandName`) is installed in the worker shim directory then.

Events go to `<stateDir>/workers.jsonl`: a start row (role, name, team, provider, `session_id`, `role_source`, `started_with`), rows for aborted starts (`aborted-*`), a slot wait of one second or more (`slot_wait_ms`), a final row with the failure `class` after a failed provider worker, and an `integrity` row with the failure `class` `integrity` when the shared part of `.git` changed (exit 1). The task journal reports that class for the task whatever rows follow it. Next to the rows, the wrapper keeps `<stateDir>/git-baseline/<team>/<worker>.json` (the digest of the shared part of `.git` at the start of the observation window, marked `checked` after the wrapper's own check).

`provider-team.cjs` refuses in a provider process or with a foreign `ANTHROPIC_BASE_URL` (exit 2). It sets `OMC_TEAM_WORKTREE_MODE=named` unless the user set a value, `OMC_TEAM_ENGAGED_PANE_RECHECK_MS=120000` when it is unset or empty, warns about dirty tracked files of the lead, passes the profile selectors and every set `OMC_PROVIDER_*` name to the pane through `OMC_TEAM_WORKER_ENV_PASSTHROUGH` (the pane has a clean environment), and runs the quota gate before the team starts (exit 4 on refusal).

## Advisor consultations

`provider-advisor.cjs` lets a provider worker ask a stronger model, running on the login of the host and not on the provider, for advice on one decision. A worker calls it by its bare command name (`advisor.commandName`, default `provider-advisor`): `provider-advisor "question with context"`, or the question on stdin. The answer goes to stdout.

The worker rule (`templates/provider/worker-rule.md`) and the advisor shim are active only when `provider-advisor.cjs` sits next to `provider-worker.cjs`; the shim is installed in the worker shim directory and the Bash guard lets exactly the bare command name through. The result format and the `NEED` and `ESCALATE` channels of the worker rule travel with the advisor script: without the script the worker starts without the rule, so those channels are not announced to it. The advisor reads its settings from the profile named by `OMC_PROVIDER`, found through the default profiles path (the worker environment does not carry `OMC_PROVIDER_PROFILES_FILE`); when no profile is found it uses the defaults of the `advisor` section.

Profile fields (`advisor.*`): `claudeBinary` (default: the first `claude` on `PATH` outside generated shims), `commandName` (`provider-advisor`), `defaultModel` (`opus`), `models` (`["opus","sonnet","fable"]`), `timeoutSeconds` (`600`), `roleFile` (`templates/provider/advisor-role.md`), `limits.perTask` (`4`), `limits.perGroup` (`4`), `limits.topSlots` (`2`), `limits.queueWaitMs` (`15000`). The model parameter is `OMC_PROVIDER_ADVISOR_MODEL`; a value outside `advisor.models` is refused with exit code 2 before anything starts. The other variables are in the environment table.

Safe call. The `claude` process of the advisor gets no tools (`--tools ""`), an empty MCP configuration, `--setting-sources ""`, `--permission-mode plan`, `--no-session-persistence`, `--disable-slash-commands` and `--output-format json`, and it starts in an empty temporary directory that is removed afterwards. Its environment is the incoming one without the provider variables, the credentials, every `ANTHROPIC_*` variable, every `OMC_PROVIDER_*` marker and override, and without the shim directories in `PATH`; a foreign `ANTHROPIC_BASE_URL` in the incoming environment is refused with exit code 2, except the address of the session of the calling provider worker itself (its settings env block sets it for every process of the session): that address is recognised by the settings file named in `OMC_PROVIDER_SETTINGS_FILE`, whose `OMC_PROVIDER` and `ANTHROPIC_BASE_URL` must equal the incoming ones, and it is cleared from the environment of the advisor like every other `ANTHROPIC_*` variable. The script sends nothing to the provider address and reads no provider key. The time limit is `advisor.timeoutSeconds` (exit 124); the advisor process stays in the process group of the worker, so a kill of the group ends it.

Role. The system prompt comes from `templates/provider/advisor-role.md`: sections `COMMON`, `PLAN`, `RESCUE`, `FINAL` and `DEFAULT`. Without the shaped input mode the `DEFAULT` section is used and the answer starts with a line `ADVISOR: change`, `ADVISOR: confirm` or `ADVISOR: reject`. With the shaped input mode and `OMC_PROVIDER_ADVISOR_PROTOCOL` set, the `COMMON` section plus the profile section is used. A missing role file or section is a refusal (exit code 2, status `no-role`), not a silent fallback.

All switches below are off by default; without them the consultation behaves as described above.

- Shaped input (`OMC_PROVIDER_ADVISOR_INPUT=1`). The question uses the fields `DECISION` (required), `TRIED`, `TEST TAIL`, `HYPOTHESIS`, `EVIDENCE` and `FILES`. The script adds the worktree diff and the untracked files, and embeds the named files with line numbers `number<TAB>code`. Long fields are cut to head plus tail on whole lines; a file over its budget is dropped whole and named in an omitted section; the markers are `[OMITTED lines a-b]` and `[TRIMMED]`. Named paths must resolve under `OMC_TEAM_WORKTREE_PATH` (or `OMC_PROVIDER_FILE_ROOT`) and must not match the credential patterns of the Bash guard, the components `.git`, `.claude` and `.omc`, or key file names; a refusal is exit code 2 with status `refused-path`, a question without `DECISION` is status `refused-missing-decision`. Diff and files with a suspected secret are left out. The caps are the `OMC_PROVIDER_ADVISOR_CAP_*` variables.
- Verdict mode (shaped input plus `OMC_PROVIDER_ADVISOR_PROTOCOL` = `plan`, `rescue` or `final`). A random token is appended to the input as `INPUT TOKEN: <token>`. The answer must start with `TOKEN: <token>` and carry a line `VERDICT: <word>` from the dictionary of the profile (`LGTM` or `CONCERNS` for plan, `proceed`, `proceed-with-changes` or `reconsider` for rescue, `GO` or `STOP` for final), optional `CONCERN n:` lines (plan: one to five), `SOURCE: <file>:<line>` lines and a closing `SUMMARY:` line; a plan may add `ACCEPTANCE CRITERIA:`. Citations are validated against the files and line ranges actually shown. The final gate is fail-closed: an answer outside the format, a mere announcement, `GO` without a valid citation or with an invalid one, or `GO` after the diff changed since the input (status `stale`) fails with exit code 3. The advisory profiles are fail-open: exit code 0 and the line `ADVICE UNAVAILABLE (<reason>): continue or report to the lead`. The printed advice is capped by `OMC_PROVIDER_ADVISOR_CAP_ADVICE`; the `TOKEN` and `VERDICT` lines are never cut.
- Journal (`OMC_PROVIDER_ADVISOR_JOURNAL=1`). `advisor.jsonl` gets a `start` row before the `claude` process is launched and an `end` row with the result (refusals and start errors have only an end row). The event is a required parameter: `--event plan|test-failure|final|other` or `OMC_PROVIDER_ADVISOR_EVENT`, with `--failure-no N` only for `test-failure`; another value is refused with exit code 2. The end row holds the advice text (redacted of secrets, removed after 30 days), cost and tokens. The file is 0600 and appends run under a lock. `node lib/advisor-journal.cjs status [--window-hours N] [--path FILE]` prints the shares of delivered, refused, failed and unavailable consultations; `purge [--days N]` removes old advice text by hand.
- Limit (`OMC_PROVIDER_ADVISOR_LIMIT=1`). The number of consultations per task and per group is limited (`advisor.limits.perTask`, `perGroup`), and a machine-wide FIFO queue limits the concurrent consultations on the top-model bucket (`topSlots`, wait `queueWaitMs`). The task is the in-progress task of the worker in the team state, qualified with the team state root and the team name (native task ids are only unique inside a team, so another team does not share the counter of the same id); the group is the team name. The key is the JSON array of state root, team name and task id, so no character inside a part can merge two tasks. A refused call exits with code 2 and prints what to do next; a delivered answer ends with `ADVISOR-LIMIT: n left`. A consultation slot is committed only after advice was delivered and is returned on every error path. One retry follows a rate-limit refusal. The same question and diff as in the last delivered consultation is answered from the journal (status `from-journal`) without a model call. `node lib/advisor-limit.cjs status` is a read-only view; the Bash guard refuses `advisor-limit` to workers.

Exit codes: 0 delivered, 1 error of `claude` or an answer without the JSON result, 2 refusal (empty question, event, model, environment, path, limit, queue, role), 3 final gate not passed, 124 time limit, 127 no `claude` binary or it cannot start.

## Model gate and loopback proxy port

Two small opt-in changes outside `scripts/provider/` let a provider session work with the rest of OMC:

- `OMC_PROVIDER_MODEL_PREFIXES` (comma-separated, case-insensitive): model ids that start with a listed prefix and end with an optional context suffix such as `[1m]` are accepted by the model gate of `scripts/pre-tool-enforcer.mjs` under forceInherit when the process talks to a non-Claude provider other than Bedrock and Vertex. The session settings set it from `modelIdPrefixes`. Without it the gate is unchanged.
- `OMC_ALLOW_LOOPBACK_PROXY_PORT` (integer 1-65535): `src/config/models.ts` accepts `http://127.0.0.1:<port>` or `http://localhost:<port>` with exactly that port as `ANTHROPIC_BASE_URL` without the SSRF Guard line on stderr. The session settings set it while the local proxy is used. Other loopback addresses, other ports, `https`, credentials in the URL and metadata paths stay blocked; `validateUrlForSSRF` is unchanged.

## Security notes

- Key values stay in memory of the helper and are never printed, logged or put in an argument list.
- Environment variables that carry credentials are not passed to executors.
- The session launcher puts the key (or, next to the local proxy, the client token) into the 0600 settings copy next to the original settings file, so a child process that inherits the session environment sends the provider key to the provider address and never a stored subscription login. A provider worker keeps the key out of its settings file and passes it only in the environment of its `claude` process; the Bash guard refuses to read the worker settings directory.
- `provider-worker.cjs` refuses to start `claude` with a foreign `ANTHROPIC_BASE_URL` in the environment when no provider settings are present (exit 3), and `provider-team.cjs` refuses to run in a provider process (exit 2): reviewers on Claude would otherwise receive the provider address without provider credentials.
- A worker's environment is built from an allow-list. Unknown variables are not passed.
- The advisor runs on the login of the host with its environment cleared of the provider variables, the credentials and every `ANTHROPIC_*` variable, in an empty temporary directory, without tools; it refuses a foreign `ANTHROPIC_BASE_URL` in the incoming environment (other than the address of the calling worker's own provider session) and never reads a provider key.
- The provider tools do not guarantee the quota or provider behavior; they only check what the profile and the responses say.

## Preset: Z.ai

`examples/provider/zai.providers.jsonc` holds the Z.ai coding endpoint: base URL `https://api.z.ai/api/anthropic`, models `glm-5.4[1m]` (opus and sonnet) and `glm-5.3-flash[1m]` (haiku), model prefix `glm-`, quota adapter `monitor-limits`, error codes 1308, 1310 (quota) and 1305 (throttle), and a 1000000-token context window. Choose the key source yourself. The preset contains no personal or machine-specific values.

## Local proxy

`scripts/provider/provider-proxy.mjs` is a small reverse proxy that sits between provider sessions and the provider. One background server runs per state directory. It never starts by itself: nothing changes until `provider-proxy.mjs start` is run, and tools that look for it (`lib/proxy-state.cjs`) use the provider directly when no live proxy exists.

What it does for every client:

1. Listens on `127.0.0.1` only. There is no option to change the interface.
2. Limits the requests in flight to the provider with one global FIFO gate. A request that waits in the queue and whose client disconnects never reaches the provider.
3. Replaces the credentials of the client with the provider key, which only the server holds. `authorization`, `x-api-key`, `proxy-authorization`, `cookie` and forwarding headers (`x-forwarded-*`, `forwarded`, `via`) are never forwarded, and redirects are not followed. `x-api-key` is sent upstream only when the client sent that header.
4. Retries HTTP 429, every 5xx and transport failures before the client sees anything. The delay is `Retry-After` (seconds or an HTTP date, clamped to `retryAfterCap`) or an exponential backoff from `retryBaseDelay` to `retryMaxDelay`. A 429 or 5xx whose body matches a non-retryable pattern is passed to the client at once; with no patterns every 429 and 5xx is retried. Compressed bodies (gzip, deflate, br) are decoded for matching only.
5. Streams everything else, including server-sent events, chunk by chunk with backpressure. If the client disconnects the upstream request is aborted; if the provider breaks after the headers were sent, the client connection is destroyed instead of being left with a truncated answer.

The permit of the gate is held for all attempts and backoff sleeps of a request and for the whole response, so requests that are being retried keep their place while the provider throttles.

### Commands

```
provider-proxy.mjs start  [options]
provider-proxy.mjs stop   [--profile NAME | --state-dir DIR]
provider-proxy.mjs status [--json] [--profile NAME | --state-dir DIR]
```

`start` validates the options and the key without side effects (exit 2 or 3 before anything is created), takes `start.lock`, starts the detached server, and waits until `proxy.pid` and `/health` answer (15 s at most). A server that is already running for the same upstream is left alone (`already running pid=... port=... limit=...`); a different limit is only reported. A running server for another upstream is stopped and replaced. `stop` sends SIGTERM, waits 3 s, then SIGKILL, and is idempotent. `status` exits 0 when running and 1 when not; `--json` prints `running`, `pid`, `port`, `upstream` and `counters`.

Exit codes: 0 ok; 1 not ready, port in use, or not running (`status`); 2 bad configuration or usage; 3 no usable key, or a start already in progress.

### Options

Precedence: command line, then the `OMC_PROVIDER_PROXY_*` variable of the option (listed in the environment variable table), then the profile named with `--profile` (or `OMC_PROVIDER_PROXY_PROFILE`), then the default. A profile supplies `baseUrl`, `apiKey` and the `proxy` fields `port`, `maxConcurrency`, `idleTimeoutSeconds`, `clientToken`, `hostCheck`, `nonRetryableBodyPatterns` and the tuning fields `retryMaxAttempts`, `retryBaseDelayMs`, `retryMaxDelayMs`, `retryAfterCapMs`, `retryJitterMs`, `maxBufferedBodyBytes`, `heldBodyCapBytes`, `connectTimeoutMs`, `responseHeaderTimeoutMs`, `stopGraceMs` and `logMaxBytes` (the option table below lists their defaults and the equivalent options). The default port `33177` is a documented constant of the proxy, not a profile default.

| Option | Default | Meaning |
|---|---|---|
| `--profile` | none | Profile to read. |
| `--upstream` | profile `baseUrl` | Provider base URL. `https`, or `http` for a loopback host. A value that comes from the environment must be a loopback address, so a stray exported variable cannot redirect the key. |
| `--api-key-command` | profile `apiKey.command` | Executable that prints the key. No shell, no arguments, 10 s limit. |
| `--api-key-file` | profile `apiKey.file` | File that holds the key. |
| `--api-key-env` | profile `apiKey.env` | Name of a variable in the server environment. |
| `--state-dir` | `<profile stateDir>/proxy` | State directory (mode 0700). Required when no profile is used. |
| `--port` | `33177` | Loopback port; `0` asks the OS for a free one. A fixed port is the default because long-lived clients cache the proxy URL. |
| `--max-concurrency` | `4` | Requests in flight to the provider. Set it to the concurrent-request allowance of your plan. |
| `--idle-timeout` | `0` | Seconds without a request in flight or arriving before the server stops; `0` = never. |
| `--retry-max-attempts` | `0` | Retries after the first attempt; `0` = unlimited while the client waits. |
| `--retry-base-delay-ms`, `--retry-max-delay-ms` | `1000`, `30000` | Exponential backoff. The base must be at least 1. |
| `--retry-after-cap-ms` | `120000` | Upper bound of a delay requested with `Retry-After`. |
| `--retry-jitter-ms` | `0` | Random jitter added to the backoff (not to `Retry-After`). |
| `--max-body-bytes` | 64 MiB | Largest request body kept for replay; larger ones get 413. |
| `--held-body-cap-bytes` | 64 KiB | Largest part of a 429/5xx body kept in memory while deciding whether to retry. |
| `--connect-timeout-ms` | `30000` | Time to open the upstream connection. |
| `--response-header-timeout-ms` | `300000` | Time between sending a request and receiving response headers. Response bodies have no total timeout. |
| `--stop-grace-ms` | `2000` | Time that requests in flight get when the server is told to stop. |
| `--log-max-bytes` | 8 MiB | Size at which `proxy.log` is rotated (one previous file is kept). |
| `--client-token` | `auto` | `auto`, `none`, or a token of at least 8 characters. See below. |
| `--non-retryable-pattern` | none | Case-insensitive regular expression, repeatable. A 429/5xx body that matches is not retried. |
| `--no-host-check` | host check on | Accept any `Host` header. |

### Protecting the key from other local users

Any local process can reach a loopback port, and the proxy attaches the real key to every request it forwards. Therefore:

- The `Host` header must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`; anything else gets 403 (defense against DNS rebinding from a web page).
- With `--client-token auto` (the default) the first `start` writes 32 random bytes as hex to `<state dir>/client-token` (mode 0600). The server requires the token as `Authorization: Bearer <token>` or `x-api-key` (constant-time comparison) before a request takes a place in the gate; otherwise 401 and the provider is not contacted. Clients read the token with `readClient` in `lib/proxy-state.cjs`. An explicit token is written to the same file. The server reads the token and the key itself, so neither appears in a command line.
- `--client-token none` is a compatibility mode: no token is required and clients send the fixed credential `provider-proxy-placeholder`. Do not use it on a machine that other users can log in to.
- The state directory is 0700, `proxy.log` and `server.out` are 0600. The key is held in memory only, and log lines pass through redaction (the key itself, credential-looking JSON fields and generic secret patterns).

### State directory

| File | Content |
|---|---|
| `proxy.pid`, `proxy.port`, `proxy.target` | Pid, port and upstream of the running server; `proxy.pid` is written last. Removed on a clean stop and only if `proxy.pid` still holds the pid of the stopping server. |
| `counters.json` | `ts`, `started_at`, `limit`, `total_requests`, `active`, `retry_attempts`, `retry_successes`, `rate_limit_429`. Rewritten after every finished request and kept after a stop. |
| `client-token` | Client token (mode 0600). Kept after a stop so clients keep working across restarts. |
| `proxy.log`, `proxy.log.1` | One line per finished request (method, path without query, wait for the permit, total time, final status, attempts) and one line per held provider answer with the first 512 bytes of the decoded body. Request and response bodies are not logged otherwise. |
| `server.out` | Standard output and error of the detached server. |
| `start.lock/` | Present while a `start` is in progress. |

`GET /health` (not counted, no permit) returns `status`, `port`, `upstream`, `limit`, `active`, `queued`, `total_requests`, `uptime_sec`, `retry_attempts`, `retry_successes` and `rate_limit_429`. It never contains the key.

A process is the proxy when `proxy.pid` and `proxy.port` hold valid numbers, signal 0 to the pid succeeds and, where `/proc` exists, its command line contains `provider-proxy` and `_serve`. A recycled pid therefore counts as not running, and stale files after SIGKILL are harmless: `start` removes them.

### Limits of what the proxy guarantees

- It cannot make the provider faster or raise a plan allowance; it only keeps the number of concurrent requests at the configured limit and hides throttling that passes.
- A provider error that means "no access" or "quota exhausted" is retried forever unless a non-retryable pattern recognizes it. Match the provider error code and not only its wording; a pattern that also matches an unrelated message just returns that answer immediately. An example set of patterns is in the example profile under `examples/provider/`.
- The quota endpoint of a provider is not proxied specially.
