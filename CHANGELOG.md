# oh-my-claudecode v5.7.22: Configurable quality gates for workflow stages

## Release Notes

This release adds configurable blocking and advisory quality gates for the deep-interview, ralplan, and review workflow stages, with settings in user or project OMC config and `omc quality-gates list` for inspecting gate configuration. It also prevents a stage from using its own controller skill as a gate and keeps stages without configured gates as strict no-ops. Thanks to @iyoda for #4670 and #4671, and to @iqdoctor for requesting the original port.

### New Features

- **feat(quality-gates): configure blocking and advisory custom gates for deep-interview, ralplan, and review, and inspect them with `omc quality-gates list`** (#4670; ported from oh-my-codex#3956, issue #3955; requested by @iqdoctor; @iyoda)

### Quality-Gate Safety

- **fix(quality-gates): reject a stage's own controller skill as a gate to prevent self-recursion, and skip gate lookup and prompt-spec work for unconfigured stages** (#4671; @iyoda)

### Other Changes

- **chore(sync): merge main's v5.7.21 release into dev** (#4667)
- **ci: authorize generated artifacts for main-to-dev sync PR #4667** (#4668)

### Stats

- **4 PRs merged** | **1 new feature** | **1 quality-gate safety improvement** | **2 other changes**

---

# oh-my-claudecode v5.7.21: Clearer state output and restored team missions

## Release Notes

This release bounds `state_clear` diagnostics, removes invalid agent frontmatter that caused startup warnings, and restores team mission discovery when no session snapshot exists. Thanks to @iyoda for #4654, #4657, #4661, and #4662; #4654 was reported by @conarti and #4657 by @fvegiard.

### Bug Fixes

- **fix(state): limit `state_clear` missing-state path output to the requested session, or cap checked paths with an `and N more` count** (#4654, fixes #4651; reported by @conarti)
- **fix(agents): drop the unrecognized top-level `level` frontmatter key to prevent Claude Code startup warnings** (#4657, fixes #4656; reported by @fvegiard)
- **fix(hud/cli): show team missions when no session mission snapshot exists and expire completed missions in that team-only view** (#4661, #4662; @iyoda)

### Other Changes

- **chore(sync): merge main's v5.7.20 release into dev** (#4658)
- **ci: authorize and refresh generated artifacts for main-to-dev sync PR #4658** (#4659, #4660, #4663)

### Stats

- **8 PRs merged** | **0 new features** | **4 bug fixes** | **0 performance improvements** | **4 other changes**

---

# oh-my-claudecode v5.7.20: Mission board sessions and reliable run closeouts

## Release Notes

This release makes persisted missions visible in the mission board, improves run-ledger start and resumed-run closeout tracking, and clarifies Windows release-boundary and state-migration failures. Thanks to @Jack11111eee for #4649 (first contribution), @LukeTheoJohnson for #4645 and #4646, @iyoda for #4641 and #4647, and @Yeachan-Heo for #4642 and #4650.

### New Features

- **feat(hud/cli): show persisted missions across the newest sessions by default and add `-s/--session` for an explicit session** (#4649, fixes #4648; @Jack11111eee, first contribution)

### Bug Fixes

- **fix(runs-ledger): record start edges for session-scoped runs and report unattended runs ended without a notepad closeout** (#4646; @LukeTheoJohnson)
- **fix(runs-ledger): bound a resumed run's closeout by its latest unmatched start edge, so a pre-resume notepad write no longer counts** (#4650; @Yeachan-Heo)
- **fix(release): run release-boundary checks when invoked through a Windows path** (#4645; @LukeTheoJohnson)
- **fix(state): report the specific Git metadata refusal before a generic failed-probe refusal in `state_migrate_non_git`** (#4642; @Yeachan-Heo)

### Other Changes

- **test(team): make the activation-gate and critic-verdict tests independent of the host environment** (#4641; @iyoda)
- **test(npm-package): allow the clean-tarball install test up to 120 seconds** (#4647; @iyoda)
- **chore(sync): merge main's v5.7.19 release into dev** (#4639)
- **ci: authorize generated artifacts for main-to-dev sync PR #4639** (#4640)

### Stats

- **9 PRs merged** | **1 new feature** | **4 bug fixes** | **0 security/hardening improvements** | **4 other changes**

---

# oh-my-claudecode v5.7.19: Faster reconciliation and safer reinstalls

## Release Notes

This release makes interactive updates more reliable on slow-I/O hosts, repairs reinstalls when a hook library is a dangling symlink, and reduces unnecessary work during successful update reconciliation. Thanks to @kaneyxx for #4629 and the #4630 report, and to @iyoda for #4631.

### Bug Fixes

- **fix(update): wait up to 600 seconds for interactive update reconciliation while keeping silent auto-updates bounded to 60 seconds, and name the recovery command on timeout** (#4629, fixes #4628; @kaneyxx)
- **fix(installer): replace dangling `hooks/lib/stdin.mjs` symlinks before copying so reinstalls recover hook imports** (#4631, @iyoda)

### Performance Improvements

- **perf(update): sync the plugin payload once per target during reconciliation, cutting measured reconcile time by about 67%** (#4634, fixes #4630; reported by @kaneyxx)

### Other Changes

- **ci: authorize generated files for sync PR #4632 during the superseded v5.7.18 sync attempt** (#4633)
- **chore(sync): merge main's v5.7.18 release into dev** (#4635)
- **ci: authorize generated artifacts for sync PR #4635** (#4636)

### Stats

- **6 PRs merged** | **0 new features** | **2 bug fixes** | **1 performance improvement** | **0 security/hardening improvements** | **3 other changes**

---

# oh-my-claudecode v5.7.18: Keep macOS team workers logged in

## Release Notes

This release preserves Claude Code's macOS keychain OAuth login for team workers by passing `USER` through the POSIX provider environment, preventing workers from starting logged out and being retired with `startup_dispatch_failed`. Thanks to @iyoda for #4625.

### Bug Fixes

- **fix(team): pass `USER` through the POSIX provider environment so macOS workers retain their Claude login** (#4625, @iyoda)

### Other Changes

- **chore(sync): merge main's v5.7.17 release into dev** (#4623)
- **ci: authorize generated artifacts for the v5.7.17 main-to-dev sync** (#4624)

### Stats

- **3 PRs merged** | **0 new features** | **1 bug fix** | **0 security/hardening improvements** | **2 other changes**

---

# oh-my-claudecode v5.7.16: Clearer change summaries and more reliable team startup

## Release Notes

This release preserves the first Git status entry's path in subagent file-change summaries, reports modify/delete paths in team rebase conflict messages, and detects Claude's directory-trust question when it wraps in narrow panes, so workers no longer exit on first launch. Thanks to @rudycelekli for #4607 and #4608, and @iyoda for #4611, which addresses the same symptom as #4123.

### Bug Fixes

- **fix(omc-orchestrator): keep the first git status entry's path intact in the subagent FILE CHANGES SUMMARY** (#4607, @rudycelekli)
- **fix(team): report modify/delete paths in rebase conflict messages** (#4608, @rudycelekli)
- **fix(team): detect Claude's directory-trust dialog when its question wraps in narrow panes** (#4611, fixes #4123; @iyoda)

### Other Changes

- **chore(sync): merge the v5.7.15 main release into dev** (#4609)
- **ci: authorize generated artifacts for the v5.7.15 main-to-dev sync** (#4610)

### Stats

- **5 PRs merged** | **0 new features** | **3 bug fixes** | **0 security/hardening improvements** | **2 other changes**

---

# oh-my-claudecode v5.7.15: More reliable timeouts and clearer token counts

## Release Notes

This release stops truncating whole-integer timeout settings in persistent mode and the pre-tool advisory cooldown, displays near-million HUD token counts in millions, and accepts GitHub and GitLab pull request `.diff` and `.patch` URLs. Thanks to @rudycelekli for #4599, #4600, #4601, and #4604.

### Bug Fixes

- **fix(persistent-mode): stop truncating OMC_PERSISTENT_MODE_TIMEOUT_MS** (#4599, @rudycelekli)
- **fix(pre-tool-enforcer): stop truncating OMC_PRE_TOOL_ADVISORY_COOLDOWN_MS** (#4600, @rudycelekli)
- **fix(hud): show token counts that round up to 1000k in millions** (#4601, @rudycelekli)
- **fix(teleport): read pull request patch and diff URLs** (#4604, @rudycelekli)

### Other Changes

- **chore(sync): merge the v5.7.14 main release into dev** (#4596)
- **ci: authorize generated artifacts for the v5.7.14 main-to-dev sync** (#4597)

### Stats

- **6 PRs merged** | **0 new features** | **4 bug fixes** | **0 security/hardening improvements** | **2 other changes**

---

# oh-my-claudecode v5.7.14: More reliable Stop hooks and leaner team handling

## Release Notes

This release fixes Stop-hook shadow resolver cleanup and removes the unwired team-dispatch implementation. Thanks to @iyoda for #4581 and to @rolldav for reporting #4575.

### Bug Fixes

- **fix: detach shadow Jev resolver for Stop hooks** (#4580, fixes #4575; reported by @rolldav)

### Other Changes

- **chore(hooks): remove unwired team-dispatch hook and generated artifacts** (#4581, supersedes #4566; @iyoda)
- **ci: authorize generated artifacts for the team-dispatch removal** (#4577, #4582, #4587)
- **chore(sync): merge the v5.7.13 main release into dev** (#4590)
- **ci: authorize generated artifacts for the v5.7.13 main-to-dev sync** (#4591)

---

# oh-my-claudecode v5.7.13: More reliable keyword prompts and team handling

## Release Notes

This release preserves explicit keyword invocations in reference prompts, keeps help requests informational across more prompt shapes, and corrects team and notification environment handling. Thanks to @rudycelekli and @iyoda for their fixes, and to @rolldav for reporting #4550.

### Bug Fixes

- **fix: preserve explicit keyword invocation in reference prompts** (#4551, fixes #4550; reported by @rolldav)
- **fix: resolve #4551 regressions in keyword-detector** (#4553)
- **fix(keyword-detector): keep leading help requests informational in two more shapes** (#4564)
- **fix(notifications): stop truncating OMC_NOTIFY_TMUX_TAIL_LINES** (#4556, @rudycelekli)
- **fix(team-dispatch): stop truncating cooldown environment values** (#4557, @rudycelekli)
- **fix(team): read the start-submit timeout as a whole integer** (#4558, @rudycelekli)
- **fix(team): point the pane-ready timeout hint at OMC_TEAM_READY_TIMEOUT_MS** (#4568, @iyoda)

### Other Changes

- **test: stabilize concurrent workflow-profile stops** (#4561, fixes #4560)
- **ci: authorize generated artifacts during an earlier v5.7.12 main-to-dev sync attempt** (#4563, #4565, #4567)
- **chore(sync): merge the v5.7.12 main release into dev** (#4569)
- **ci: authorize and refresh generated artifacts for the v5.7.12 main-to-dev sync** (#4570, #4573, #4574)

### Stats

- **15 merged PRs** | **7 bug fixes** | **8 other changes**

---

# oh-my-claudecode v5.7.12: More reliable URL and timeout handling

## Release Notes

This release improves parsing of provider and issue URLs ending in slashes or sub-pages, hardens environment-based timeout handling, and preserves tmux pane IDs when session names contain spaces. Thanks to @rudycelekli for contributions to #4542, #4543, #4544, #4545, #4546, #4547, and #4549.

### Bug Fixes

- **fix(teleport): read PR and issue URLs with a trailing slash or sub-page** (#4542, @rudycelekli)
- **fix(lsp): read whole-integer timeouts from the environment** (#4543, @rudycelekli)
- **fix(rate-limit-wait): keep pane IDs for tmux sessions with spaces** (#4544, @rudycelekli)
- **fix(team): read the shell-ready timeout as a whole integer** (#4545, @rudycelekli)
- **fix(team): read launch-ack timeouts as whole integers** (#4546, @rudycelekli)
- **fix(team): read the worker-ready timeout as a whole integer** (#4547, @rudycelekli)
- **fix(providers): parse remote URLs that end in a slash** (#4549, @rudycelekli)

### Other Changes

- **chore(sync): merge main's v5.7.11 release into dev** (#4540)
- **ci: authorize generated artifacts for sync PR #4540** (#4541)
- **ci: authorize generated artifacts for an earlier main-to-dev sync attempt** (#4539)

---

# oh-my-claudecode v5.7.10: Fail-closed Ralph PRD verification

## Release Notes

This release makes `omc ralph verify` fail closed when an existing PRD is invalid or unreadable, instead of incorrectly reporting that no feedback commands exist. Thanks to Get-bot for reporting #4526.

### Bug Fixes

- **fix(ralph): fail closed for invalid PRDs** (#4527, fixes #4526; reported by Get-bot)

### Other Changes

- **chore(sync): merge the v5.7.9 main release into dev** (#4524)
- **ci: authorize generated artifacts for sync PR #4524** (#4525)

---

# oh-my-claudecode v5.7.9: Safer Windows startup, Codex TOML output, and aligned Jev timeouts

## Release Notes

This release fixes Windows startup trust-prompt handling, escaping unpaired surrogates in Codex MCP TOML output, and aligning Jev active parent timeouts with resolver behavior. Thanks to @rudycelekli and @alw51307 for their contributions.

### Bug Fixes

- **fix(team): guard Windows startup trust prompts** (#4502)
- **fix(mcp-registry): escape unpaired surrogates in Codex TOML output** (#4512, @rudycelekli)
- **fix(jev): align active parent timeout with resolver** (#4515, @alw51307)

### Other Changes

- **chore(sync): merge v5.7.8 main release into dev and rebuild the inventory** (#4519)
- **ci: authorize generated artifacts for the v5.7.8 main-to-dev sync** (#4520)

---

# oh-my-claudecode v5.7.8: More reliable Windows workers and configuration handling

## Release Notes

This release improves native Windows worker supervision, JSON and JSONC parsing, numeric configuration validation, think-mode matching, diagnostic environment handling, and prerelease update ordering. Thanks to @rudycelekli for contributions to #4493, #4494, #4497, #4499, #4508, #4510, and #4511.

### Bug Fixes

- **fix(team): repair native Windows worker supervision and startup** (#4479, fixes #4386)
- **fix(team): fit the source-bound Windows supervisor invocation and reject unresolved provider executables** (#4479)
- **fix(team): submit tmux startup inboxes and shorten only overflowing Windows notifications** (#4479)
- **fix(team): recognize Codex folder-trust prompts without sending task text or granting persistent trust** (#4479)
- **fix(jsonc): accept a leading UTF-8 BOM in JSONC configuration files** (#4494)
- **fix(notifications): reject non-positive reply polling intervals and rate limits** (#4497)
- **fix(json): accept a leading UTF-8 BOM in hand-authored JSON files** (#4499)
- **fix(think-mode): match multilingual think keywords as whole words** (#4493)
- **fix(debug): read `OMC_DEBUG` through one shared convention** (#4508)
- **fix(host-load-gate): reject malformed thresholds instead of silently truncating them** (#4510)
- **fix(version): rank prereleases below their corresponding release** (#4511)

### Other Changes

- **test(ci): make SessionStart timing tests deterministic** (#4514)
- **ci:** canonicalize generated-artifact authorization timestamps and refresh authorization entries for release and sync PRs (#4480, #4504, #4507, #4509)
- **chore(inventory): rebuild generated artifacts and inventory during the v5.7.7 main-to-dev sync** (#4506)

---

# oh-my-claudecode v5.7.7: Codex hook compatibility and safer HUD loading

## Release Notes

This release includes fixes for Codex hook output, HUD fallback security and reliability, configuration parsing, team shutdown validation, and plugin-only bootstrap.

### Bug Fixes

- **fix(hooks): emit Codex-compatible PreToolUse output** (#4489, fixes #4488)
- **fix(hud): restrict npm fallback to the global prefix** (#4471, #4472)
- **fix(hooks): fall back from blank shell config directory overrides** (#4474)
- **fix(hooks): honor trailing commas in agent model JSONC** (#4473)
- **fix(installer): recognize quoted Codex MCP keys** (#4469)
- **fix(hud): report cached HUD load failures** (#4468)
- **fix(skills): align argument hints with behavior** (#4465)
- **fix(team): validate shutdown acknowledgements before consuming them** (#4462)
- **fix(ultragoal): allow plugin-only bootstrap commands** (#4459)

### Other Changes

- **test(ci): make timing regression tests deterministic** (#4464)
- **ci: canonicalize generated-artifact authorization expiry timestamps** (#4484)
- **ci: sync the v5.7.6 main release back into dev** (#4485)
- **chore(inventory): regenerate the inventory graph** (#4486)

---
# oh-my-claudecode v5.7.6: Fix plugin-mode HUD loading and tighten input validation

## Release Notes

Hotfix for v5.7.5: the plugin HUD no longer imports Zod from the plugin cache, where `node_modules` is unavailable. This release also fixes HUD estimates, frontmatter handling, command parsing, and numeric option validation.

### Bug Fixes

- **fix(hud): remove the runtime Zod dependency from plugin security config** (#4454, PR #4455)
- **fix(hud): exclude local API request records from the payload estimate** (#4437)
- **fix(featured-contributors): reject invalid `--min-stars` values** (#4439)
- **fix(session-end): prevent `OMC_DAILY_CHAIN_LIMIT` from flooring to zero** (#4440)
- **fix(autoresearch): reject invalid `--max-waves` and `--poll-interval` values** (#4441)
- **fix(team): reject non-integer numeric CLI flag values** (#4442)
- **fix(auto-slash-command): keep the plugin namespace when parsing slash commands** (#4450)
- **fix(agents): read frontmatter by line-anchored delimiters, including after a BOM** (#4451)
- **fix(autoresearch): accept a leading UTF-8 BOM in `sandbox.md` frontmatter** (#4452)

### Other Changes

- **ci:** refresh generated-artifact authorizations and inventory metadata for the main-to-dev sync (#4444, #4445, #4449, #4453)

---

# oh-my-claudecode v5.7.5: More reliable frontmatter, glob matching, and worker startup

## Release Notes

Release with **1 new feature**, **22 bug fixes**, **1 CI improvement**, and **1 retired-tools removal** across **25 merged PRs**.

### Highlights

- **feat(installer): add `claudeMdEnabled` opt-out for the global CLAUDE.md** (#4383)
- **fix(frontmatter): handle CRLF, BOMs, YAML block scalars, and quoted values across files** (#4392, #4393, #4402, #4405, #4406, #4407, #4408, #4410, #4411)
- **fix: match configured globs literally and stabilize team worker startup** (#4390, #4403, #4404, #4413, #4416, #4418)

### New Features

- **feat(installer): add `claudeMdEnabled` opt-out for the global CLAUDE.md** (#4383)
  - Lets users leave the global `CLAUDE.md` untouched when configuring the installer.

### Bug Fixes

- **fix(session-start): bound the stabilization helper lifetime and batch the Darwin identity probe** (#4384)
- **fix: ignore malformed context-guard and security configuration values** (#4388, #4389)
- **fix(state-manager): match list and cleanup glob patterns literally** (#4390)
- **fix(learner): parse block-list skill metadata in CRLF files** (#4392)
- **fix(frontmatter): preserve quoted flow values** (#4393)
- **fix(ralph): retain feedback failures when tests log ENOENT** (#4399)
- **fix(commands): parse CRLF frontmatter in command files** (#4402)
- **fix(rules-injector): support `{a,b}` brace alternation in rule globs** (#4403)
- **fix(team): align worker startup ACK and shutdown instructions** (#4404)
- **fix(frontmatter): read YAML block scalars and indented block-list values** (#4405, #4406)
- **fix(rules-injector): ignore trailing YAML comments and preserve quoted hashes in flow values** (#4407)
- **fix(frontmatter): accept a leading UTF-8 BOM in skill, command, rule, and wiki files** (#4408, #4410)
- **fix(cli): reject non-integer values for wait and session options** (#4409)
- **fix(autoresearch): keep quotes inside an unquoted `sandbox.md` value** (#4411)
- **fix(team): stabilize cmux worker startup** (#4413)
- **fix(factcheck): match strict project globs literally** (#4416)
- **fix(doctor): ignore empty `OMC_SKIP_HOOKS` entries** (#4417)
- **fix(learner): match glob triggers literally apart from `*`** (#4418)
- **fix(factory): validate `listen --port` as an integer in 0–65535** (#4420)

### Other Changes

- **test(session-end): stabilize configured process exit on CI** (#4397)
- **chore: remove retired merge-readiness MCP tools and regenerate shipped artifacts** (#4422)
- **ci: refresh inventory baselines and generated-artifact authorizations** (#4423–#4432)

### Stats

- **25 PRs merged** | **1 new feature** | **22 bug fixes** | **1 CI improvement** | **1 retired-tools removal**

---
# oh-my-claudecode v5.7.4: More reliable hooks, team workflows, HUD, and Jev planning

## Release Notes

Release with **1 new feature**, **4 bug fixes**, **1 performance improvement**, and **3 test improvements** across **9 merged PRs**.

### Highlights

- **feat(jev): add OMC_JEV_PLAN_MODE to keep Jev from deciding in plan mode** (#4395)
- **fix(team): quarantine stale Cursor verdicts and retain them on unreadable tasks** (#4380)
- **perf(hooks): launch the file-context injectors only for the tools they act on** (#4373)

### New Features

- **feat(jev): add OMC_JEV_PLAN_MODE to keep Jev from deciding in plan mode** (#4395)

### Performance Improvements

- **perf(hooks): launch the file-context injectors only for the tools they act on** (#4373)
  - File-context injectors now launch only for the tools they act on, reducing hook overhead.

### Bug Fixes

- **fix(plugin-cache): link stale plugin roots only to a real cache directory** (#4375)
- **fix(installer): log CLAUDE.md as already up to date when install leaves it unchanged** (#4377)
- **fix(team): quarantine stale Cursor verdicts and retain them on unreadable tasks** (#4380)
- **fix: scope HUD stdin cache per session using stdin.session_id** (#4398)

### Test Improvements

- **test(run-cjs): blank user-level OMC env in the worker skip-guard hook spawns** (#4376)
- **test(atomic-write): give SQLite contention timing bounds a runner margin** (#4385)
- **test: make shutdown and state-clear race checks environment-independent** (#4379)

### Stats

- **9 PRs merged** | **1 new feature** | **4 bug fixes** | **1 performance improvement** | **3 test improvements**

---
# oh-my-claudecode v5.7.3: Retire agent variant names, parallel consensus reviews

## Release Notes

Release with **2 improvements**, **1 bug fix**, **2 CI improvements** across **5 merged PRs**.

### Highlights

- **fix(#4343): Retire tiered agent variant names — use model parameter instead** (#4345)
- **fix(#4355): Enable parallel Architect/Critic reviews when both are Claude agents** (#4358)
- **fix(#4363): Ralph started through Skill tool now gets state with prd_mode and prd.json** (#4364)

### Changes

- **fix(#4343): Retire tiered agent variant names — use model parameter instead** (#4345)
  - Replaces tier-based agent selection (fast/balanced/strong) with direct `--model` parameter
  - Simplifies agent routing and removes tier-selector complexity

- **fix(#4355): Enable parallel Architect/Critic reviews when both are Claude agents** (#4358)
  - Allows concurrent Architect and Critic consensus reviews for improved workflow efficiency
  - Coordination guarantees remain for non-Claude agent roles

- **fix(#4363): Ralph started through Skill tool now gets state with prd_mode and prd.json** (#4364)
  - Skill tool invocation of ralph now properly receives planning state artifacts
  - Fixes missing PRD state when using the `skill` tool interface

### CI Improvements

- **fix(ci): restore inventory-graph drift baseline on dev** (#4360, #4365)

### Stats

- **5 PRs merged** | **0 new features** | **1 bug fix** | **2 improvements** | **2 CI improvements**

---

# oh-my-claudecode v5.7.2: add Muse and

## Release Notes

Release with **1 new feature**, **3 bug fixes**, **6 other changes** across **10 merged PRs**.

### Highlights

- **feat(ask): add Muse and fix Grok role prompt transport**

### New Features

- **feat(ask): add Muse and fix Grok role prompt transport**

### Bug Fixes

- **fix(inventory): regenerate inventory graph after #4348**
- **fix(test): set TMPDIR for grok/muse env vars test with Windows platform**
- **fix(ask): mirror Muse ask guard in standalone hook and document Muse in README**

### Documentation

- **docs: refresh inventory-graph baseline after features.md changes**
- **docs: complete ultrawork removal from features.md**
- **docs: remove retired ultrawork/web-clone references** (#4343)

### Other Changes

- **chore: rebind PR #4345 authorization to head 6d1e331a**
- **chore: update PR #4345 authorization with final rebuilt head 36b49bd13**
- **ci: rebind PR #4345 authorization to head 494758c7 and merge base 5a394754**
- **ci: rebind PR #4345 authorization for new head commit (r10)**
- **ci: rebind PR #4345 authorization for new head commit**
- **ci: authorize stale tier-selector dist removal for PR #4345**

### Stats

- **10 PRs merged** | **1 new feature** | **3 bug fixes** | **0 security/hardening improvements** | **6 other changes**
