---
name: omc-doctor
description: Diagnose and fix oh-my-claudecode installation issues
level: 3
---

# Doctor Skill

Note: All `~/.claude/...` paths in this guide respect `CLAUDE_CONFIG_DIR` when that environment variable is set. Surrounding spaces are ignored and an empty value means `~/.claude`. A value that is `~`, or starts with `~/` or `~\`, means the home directory (OMC's runtime reads it that way; the shell does not expand a `~` stored in a variable), and a `~` anywhere else is literal. The checks that read the plugin installation are commands of one script that ships with the plugin, `scripts/omc-doctor.mjs`, which expands the variable with one expression, and each shell block that does not run it starts with the same expansion line; expand a path you read or write yourself the same way. Run every shell block whole, in one Bash call: the tool keeps no variable from one call to the next, so a line that uses `$C` or `$S` alone, without the first line of its block that sets it, sees an empty value. How a `..` in the value is folded and how the locator line of a block finds the script: guide section `paths-and-locator`.

## Task: Run Installation Diagnostics

You are the OMC Doctor - diagnose and fix installation issues.

### Guide: the details on request

This text leaves out the details of the rarer cases. They are in `scripts/omc-doctor-guide.md`, beside the script, one section per name: `channel-unknown`, `channel-plugin-dir`, `latest-grammar`, `versions-order` and `paths-and-locator` (read one when a rule below sends you there and you need the reason or the exact rule) and `cache-guard` (read before every cache repair command, see "Fix: Outdated Plugin"). Print a section by running this block with the name in place of `SECTION`; it ends with exit code 1 and a message when the file is missing, and with exit code 2 for a name that is no section:

```bash
# Print one section of the guide (cross-platform)
S=; for R in "${CLAUDE_PLUGIN_ROOT}" "${OMC_PLUGIN_ROOT:-}"; do [ "${R#*[![:space:]]}" != "$R" ] && [ -f "$R/scripts/omc-doctor.mjs" ] && { S="$R/scripts/omc-doctor.mjs"; break; }; done; [ -n "$S" ] || { R=$(node -p '(require("child_process").spawnSync("npm root -g",{encoding:"utf8",timeout:5000,shell:true}).stdout||"").trim()' 2>/dev/null)/oh-my-claude-sisyphus; [ -f "$R/scripts/omc-doctor.mjs" ] && S="$R/scripts/omc-doctor.mjs"; }; [ -n "$S" ] || { echo "omc-doctor: plugin files not found: scripts/omc-doctor.mjs is missing under CLAUDE_PLUGIN_ROOT, under OMC_PLUGIN_ROOT and in the global npm package, or the variables are unset. Reinstall or update the plugin (omc update, or claude plugin update oh-my-claudecode), restart Claude Code and run the doctor again"; exit 1; }
node "$S" guide SECTION
```

### Step 1: Check Plugin Version

```bash
# Get the plugin ID, install channel (marketplace, plugin-dir or npm), installed version, the channel's latest version and its updater (cross-platform)
S=; for R in "${CLAUDE_PLUGIN_ROOT}" "${OMC_PLUGIN_ROOT:-}"; do [ "${R#*[![:space:]]}" != "$R" ] && [ -f "$R/scripts/omc-doctor.mjs" ] && { S="$R/scripts/omc-doctor.mjs"; break; }; done; [ -n "$S" ] || { R=$(node -p '(require("child_process").spawnSync("npm root -g",{encoding:"utf8",timeout:5000,shell:true}).stdout||"").trim()' 2>/dev/null)/oh-my-claude-sisyphus; [ -f "$R/scripts/omc-doctor.mjs" ] && S="$R/scripts/omc-doctor.mjs"; }; [ -n "$S" ] || { echo "omc-doctor: plugin files not found: scripts/omc-doctor.mjs is missing under CLAUDE_PLUGIN_ROOT, under OMC_PLUGIN_ROOT and in the global npm package, or the variables are unset. Reinstall or update the plugin (omc update, or claude plugin update oh-my-claudecode), restart Claude Code and run the doctor again"; exit 1; }
node "$S" step1
# npm latest: for a Channel: npm install only; a marketplace channel's latest is its own Latest: line above, never this one
node "$S" npm-latest
```

**Diagnosis**:
- If a block of this step printed `omc-doctor: plugin files not found`, no root variable and no global npm package names a directory that holds `scripts/omc-doctor.mjs`: the plugin install is incomplete, or the install is too old to ship the script. That is the diagnosis: CRITICAL - plugin files missing (reinstall or update the plugin with the line the message names, then run the doctor again). Name no channel, version or updater, and do not run the other script commands (Steps 4 and 6 and the cache fixes print the same line)
- Read the `Channel:` line of each plugin before any rule below: it decides what that plugin's other lines mean, and a rule that reads `Installed:`, `Latest:` or `Updater:` applies only to the channels it names. `Channel: unknown` prints none of the three lines (none of them is missing). `Channel: plugin-dir` is a loaded checkout: it has no install record and no update channel, its `Installed:` is whatever version the checkout's own files hold, and `Latest: (unavailable)` and `Updater: none` are fixed answers, not failed checks. `Channel: npm` and `Channel: marketplace` are installs: `Installed: (none)` means nothing is installed (only `Channel: npm` prints it), and `Installed: (unknown)` means an install is there whose version cannot be established
- If no version installed (`Installed: (none)` under `Channel: npm`, never under `Channel: marketplace`, where a registry entry is an install whose version may be unknown (next rule), and never under `Channel: plugin-dir`): CRITICAL - plugin not installed
- If `Installed: (unknown)` under `Channel: marketplace` or `Channel: npm`: WARN - an install is there (a registry entry, or the root the session runs) but its version cannot be established, which is not a missing install and never CRITICAL. A `Registry mismatch:` line names the two versions an entry gives (its `version` and the one its `installPath` names: neither is the code, and no manifest of the running root settles it); a `Note:` line says why when nothing names a version (an entry with only an `installPath` that names none, a manifest of the running root without a usable version, a plugin cache that cannot be read). Recommend the `Updater:` line, compare nothing with `Latest:` and report no outdated WARN
- If `Channel: unknown`: CRITICAL - the install channel cannot be established, so the install cannot be diagnosed. Say so, name no updater and do not compare versions (what makes a channel unknown: guide section `channel-unknown`)
- If `Channel: plugin-dir`: the session loads the checkout named by `OMC_PLUGIN_ROOT` (or `CLAUDE_PLUGIN_ROOT`). `Installed:` is the version in that checkout's `package.json` or `.claude-plugin/plugin.json` (`(none)` means it has neither, or that the version it holds is not a semantic version of that grammar, or that reading it failed), there is no channel latest, so no outdated WARN, and the `npm latest:` line is ignored. `Installed: (none)` here is an unknown version of a checkout the session is running, not a missing install: it is never `CRITICAL - plugin not installed`, the Plugin Version check is OK with the detail `plugin-dir checkout, version unknown`, and the report names the checkout (`Plugin root:`) and does not call the plugin absent (how a checkout becomes the install, and which roots are ignored: guide section `channel-plugin-dir`)
- LATEST comes from the install channel the registry records, never from a fixed source: for `Channel: marketplace` it is the `Latest:` line the command prints (the version in that marketplace clone, accepted only when it is a semantic version in the grammar of the runtime's `parseSemver` in `scripts/session-start.mjs`: optional leading `v`, three numeric parts without leading zeros, optional prerelease and build metadata; Step 1 drops the `v`, and anything else, such as `999x.0.0`, `1.2`, `1.2.3.4` or `01.2.3`, is `Latest: (unavailable)`, which no update is recommended from), and `npm view` (the `npm latest:` line, printed by a command of its own that gives npm 20 seconds) is consulted only for `Channel: npm`, so ignore that line for a marketplace install. A marketplace install is never compared with an npm-only release, because the marketplace update cannot install one. If Step 1 lists several plugin IDs, judge each against its own `Latest:` line (the version grammar and what counts as a version: guide section `latest-grammar`)
- Order versions as semantic versions, never as text: numeric parts compare as numbers of any size (`5.10.0` is newer than `5.9.0`, and `5.1000000000000000000000.0` is newer than `5.999999999999999999999.0`: the commands compare digit strings, leading zeros dropped, the longer one is the larger number and equal lengths compare as text, because a number past 2^53 is not exact) and a prerelease is older than the stable release it precedes (`5.9.0-beta` is older than `5.9.0`, `5.9.0-beta.2` is older than `5.9.0-beta.10`). `Installed:` is the highest version in that order, among the registry entries of a plugin ID (among the cache versions of its marketplace when no entry of it names a version) or, for the npm channel, among the cache versions, and the `Latest cached plugin version` of Step 4 is chosen the same way. When that root holds a `package.json` or `.claude-plugin/plugin.json` with a semantic version, `Installed:` is that version (the code the session loads) and a different recorded version is printed on a `Registry mismatch:` line: WARN - registry and loaded code disagree (a partial update or a damaged registry), update or reinstall through the `Updater:` line; a manifest without a usable version leaves the registry's version and prints a `Note:` line (INFO); no manifest changes nothing, except that an entry whose `version` and `installPath` version (its last component if that is a version name, else the manifest under it) differ, build metadata and a leading `v` aside, gives `Installed: (unknown)` and a `Registry mismatch:` line, no `Note:`. (the cache read by Steps 4 and 6, scopes, a `v` prefix and ties: guide section `versions-order`)
- If INSTALLED is older than LATEST on the channel's own latest (same order): WARN - outdated plugin (it is updated through the `Updater:` line Step 1 printed for that plugin ID, see "Fix: Outdated Plugin"; the cache commands only clean up and never update it). If INSTALLED equals the channel's latest, there is no WARN, and there is none when it is newer than that latest either. If `Latest: (unavailable)` on a marketplace channel or `npm latest: (unavailable)` on the npm channel: report that the latest version could not be checked, not a WARN
- If multiple versions exist: WARN - stale cache

### Step 2: Check for Legacy Hooks in settings files

Read the profile-level `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` and the primary working directory's `.claude/settings.json`, then resolve every project-local settings file Claude Code may read before checking hooks. In a normal checkout, inspect the repository-root `.claude/settings.local.json`. In a linked Git worktree, inspect the main checkout root's `.claude/settings.local.json`, not just the linked worktree's file; identify the main checkout with `git worktree list --porcelain`. On Windows, and whenever Claude Code keeps the local file beside the shared `.claude/settings.json`, inspect `.claude/settings.local.json` beside that shared settings file, including in a worktree. Also inspect any starting-directory `.claude/settings.local.json` left by Claude Code versions before 2.1.211; Claude Code can still read it alongside the root file. Deduplicate identical paths. If the main checkout root or any applicable local settings file cannot be resolved or read, treat settings and script references as inconclusive and do not remove hooks or scripts. Check whether any applicable file has a `"hooks"` key with entries like:
- `bash ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/keyword-detector.sh`
- `bash ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/persistent-mode.sh`
- `bash ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/session-start.sh`
- `bash ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/stop-continuation.sh`
- `bash ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/silent-auto-update.sh`

Also recognize standalone Node hook registrations under the active config directory's `hooks/` folder: `.mjs` files named `keyword-detector`, `persistent-mode`, `session-start`, `session-end`, `pre-tool-use`, `post-tool-use`, `post-tool-use-failure`, `code-simplifier`, or `stop-continuation`. For the historical `keyword-detector`, `persistent-mode`, `session-start`, and `stop-continuation` basenames, `.cjs` and `.js` variants are legacy too. For example, `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/keyword-detector.mjs"` is a legacy registration. On Windows, recognize paths such as `node "%USERPROFILE%\.claude\hooks\keyword-detector.mjs"` and `%CLAUDE_CONFIG_DIR%\hooks\<filename>` (or their expanded absolute equivalents) with backslash separators as the same active config directory. Match only exact listed filenames invoked with `node` from that directory; do not match plugin-root commands or similarly named scripts in other directories.

A command is an auto-fix candidate only when it is a plain direct invocation of exactly one listed file: `bash <exact .sh path>`, `node <exact Node path>`, or the exact executable script path alone when the target has execute permission (for example, `$HOME/.claude/hooks/keyword-detector.sh`). No form may include extra arguments, shell operators, or other commands. If a command merely mentions the path, adds custom behavior (for example, `bash legacy.sh && run-my-check`), or cannot be parsed unambiguously, report it for manual cleanup and leave the hook object unchanged.

Before diagnosing a standalone registration as a duplicate, resolve plugin enablement with the runtime's precedence: managed and command-line settings first (read-only), then every applicable project-local settings file resolved above, then the primary working directory's `./.claude/settings.json`, then `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`. Include the main-checkout, Windows side-by-side, and legacy starting-directory local paths when they apply. For duplicate keys between the root local file and a pre-2.1.211 starting-directory file, the root local value wins; never ignore a `false` from the effective local file or fall through to a project/profile `true`. The first scope that explicitly mentions any supported OMC ID decides; unmentioned scopes are transparent. The supported marketplace IDs are `oh-my-claudecode`, `oh-my-claudecode@omc`, and `oh-my-claudecode@oh-my-claudecode`. When the current session loads OMC from an inline source such as `--plugin-dir`, `--plugin-url`, or `CLAUDE_CODE_PLUGIN_DIRS`, also consider `oh-my-claudecode@inline` only after the active root's `.claude-plugin/plugin.json` has `"name": "oh-my-claudecode"` and the session source confirms that root is loaded. Treat that inline plugin as active for the session unless its manifest sets `"defaultEnabled": false` or an applicable settings source disables it; an explicit applicable `true` overrides the manifest default. `CLAUDE_PLUGIN_ROOT` is only a locator, not proof that a plugin is enabled; an explicit effective `false` always blocks automatic removal. Within each scope, `enabledPlugins` is canonical, and legacy `plugins` is consulted only if `enabledPlugins` does not mention any supported OMC ID. Thus a canonical `false` overrides a stale legacy `true`, and a higher-precedence `false` overrides any lower-precedence `true`. If applicable local sources conflict and the effective value cannot be determined, supported IDs in the winning field conflict, a relevant file is unreadable or malformed, or no effective enabled result can be established, treat plugin activity as inconclusive and do not auto-remove. Inspect every hook source for the active root read-only: the optional `.claude-plugin/plugin.json` `hooks` field accepts a path, an inline hooks object, or an array mixing paths and inline objects; resolve declared file paths relative to the plugin root and include `hooks/hooks.json` when present. A malformed, unreadable, or unresolved declared source makes event ownership inconclusive. A cached plugin version is insufficient. Also resolve the standalone script file and compare its bytes or SHA-256 with the shipped OMC payload for that exact filename; for historical `.sh` files, use the versioned fingerprints below. A matching name or path alone does not prove ownership. If the plugin is inactive, does not provide that event, no payload or fingerprint exists, the target cannot be read, or the content differs, treat the entry as potentially user-owned and do not recommend removal.

For known standalone payloads, verify the expected plugin event as well as the payload identity. The known OMC filename-to-event mapping is:

| Standalone payload basename | Canonical plugin event |
|---|---|
| `keyword-detector` | `UserPromptSubmit` |
| `session-start` | `SessionStart` |
| `session-end` | `SessionEnd` |
| `pre-tool-use` | `PreToolUse` |
| `post-tool-use` | `PostToolUse` |
| `post-tool-use-failure` | `PostToolUseFailure` |
| `persistent-mode`, `stop-continuation`, `code-simplifier` | `Stop` |

For a historical payload, verify its event mapping from that version's trusted manifest or installer source; if unavailable, leave it for manual review. The active plugin must provide the canonical or specifically verified equivalent handler under the registration's event, and that handler must replace the payload's behavior. Merely finding any plugin handler for that event is insufficient. For example, a `session-start` script registered under `Stop` is not a duplicate even if the active plugin defines unrelated `Stop` handlers. If event or behavior equivalence is uncertain, preserve the hook and script.

The tracked historical OMC Bash-hook payload fingerprints (SHA-256) are:
- `keyword-detector.sh`: `abe4dd5e4b16231060166264d271a51e781f08a31c6aa402b26976f9c40d424e` (`96266316`), `748463911b2a8b7fffed51137c9731c962b656d490a1e4b27ef7ab10dbbbaff5` (`3a02feb1`), `1eaced21774916c31bec5b149a87009d014ffd8027ecf8e9d6ae6a36bdd79a40` (`bef486f1`)
- `persistent-mode.sh`: `c131c6846573f0f69b6e39aed1e6db8f05279131a8976f604c1511a46f564ce5` (`96266316`), `219e50bf42b7a7a0e52fb142844dce21faca7c327d9acf346fa70f074ac982ac` (`3a02feb1`), `02f4d0d63a9ce092fe5be02ce6e79f275710b773d4b8d75ff33f272540451eff` (`bef486f1`)
- `session-start.sh`: `d87571c326c43cc43b6948aca661a9616faa6943cfe1d1131f482bd30f638134` (`96266316`), `a9607c64a14d9f8e9fa990b9f38879ef095d85652f548b1232e28d14641214eb` (`3a02feb1`), `cf7aa2b008829784c8942766c3f00d348ef33a1aab66dd3f96536e95560fd56b` (`bef486f1`)
- `stop-continuation.sh`: `f74deb67479c7861b0966bc959ffd3917152b8872ac83d9243a03c7cb707b51f` (`96266316`)

No tracked OMC payload fingerprint is available for `silent-auto-update.sh` or historical `.js`/`.cjs` variants. Treat those files as ownership-inconclusive; do not automatically remove their hook registrations or files.

For Node hooks, compare against the active plugin payload, any validated retained package under `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/omc/oh-my-claudecode/<version>/` (`omc` is the marketplace of the legacy and the bare plugin ID; for another supported ID it is the part after the `@`, as Step 1 derives it), and the adjacent `node-hook-fingerprints.json` index. The index records SHA-256 fingerprints with exact stable release-tag provenance for every shipped Node module under `templates/hooks/**/*.mjs`, including hook helpers; search by payload path and inspect only that block rather than loading the entire index. If it is missing, malformed, or has no matching fingerprint, leave the entry for manual review. Preserve these additional trusted historical `keyword-detector.mjs` fingerprints from commits not necessarily represented by a release tag: `22d612620f54f360797e42fe608bf7f98155b92a3b0bba187fd89e216395d65a` (`fb125b37`), `180fc09840baa8ada1661bcc5a13821c9ca802f43ac52cb4e517ca2cba75838a` (`387956a4`), and `71a01806c1b0e29d8e553797de3900b7172654091980ae644d74e5e9291b8af2` (`0b46a595`).

**Diagnosis**:
- If a direct command is verified as OMC-owned and the active plugin provides the payload's canonical or specifically verified equivalent handler under the registration's event: CRITICAL - duplicate legacy hook
- If a composite or ambiguous command mentions a legacy path: WARN - manual cleanup required; never remove it automatically
- If the plugin is inactive, does not provide the event, or ownership cannot be verified: WARN - standalone hook may be active or user-owned; do not recommend removal

### Step 3: Check for Legacy Bash Hook Scripts

```bash
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; C=${C#"${C%%[![:space:]]*}"}; C=${C%"${C##*[![:space:]]}"}; case "$C" in '') C=$HOME/.claude;; '~') C=$HOME;; '~/'*|'~\'*) C=$HOME/${C#??};; esac; case $C in [A-Za-z]:[/\\]*|\\*|//[!/]*);; *) case $C in /*);; *) L=$(pwd -P 2>/dev/null) || { echo "omc-doctor: current directory no longer exists" >&2; exit 1; }; C=$L/$C;; esac; O=; R=$C; while [ -n "$R" ]; do P=${R%%/*}; case $R in */*) R=${R#*/};; *) R=;; esac; case $P in ''|.);; ..) case $O in ''|*/..) case $C in /*);; *) O=$O/..;; esac;; *) O=${O%/*};; esac;; *) O=$O/$P;; esac; done; case $C in /*) C=${O:-/};; *) C=${O#/}; C=${C:-.};; esac;; esac
ls -la "$C"/hooks/*.sh 2>/dev/null
```

**Diagnosis**:
- If a listed script exists, call it a duplicate only when the active plugin provides the payload's canonical or specifically verified equivalent handler under the registration's event and the file matches a shipped payload or historical fingerprint; otherwise mark ownership as unknown or treat it as an active standalone hook.

### Step 4: Check CLAUDE.md

First check whether CLAUDE.md management is disabled. Read `${CLAUDE_CONFIG_DIR:-~/.claude}/.omc-config.json`; only an explicit `"claudeMdEnabled": false` disables it (missing file, missing key, or any other value means enabled; a file that cannot be used is unknown, see below).

```bash
# Check if the user opted out of global CLAUDE.md management (cross-platform; expands ~ in CLAUDE_CONFIG_DIR like getClaudeConfigDir)
S=; for R in "${CLAUDE_PLUGIN_ROOT}" "${OMC_PLUGIN_ROOT:-}"; do [ "${R#*[![:space:]]}" != "$R" ] && [ -f "$R/scripts/omc-doctor.mjs" ] && { S="$R/scripts/omc-doctor.mjs"; break; }; done; [ -n "$S" ] || { R=$(node -p '(require("child_process").spawnSync("npm root -g",{encoding:"utf8",timeout:5000,shell:true}).stdout||"").trim()' 2>/dev/null)/oh-my-claude-sisyphus; [ -f "$R/scripts/omc-doctor.mjs" ] && S="$R/scripts/omc-doctor.mjs"; }; [ -n "$S" ] || { echo "omc-doctor: plugin files not found: scripts/omc-doctor.mjs is missing under CLAUDE_PLUGIN_ROOT, under OMC_PLUGIN_ROOT and in the global npm package, or the variables are unset. Reinstall or update the plugin (omc update, or claude plugin update oh-my-claudecode), restart Claude Code and run the doctor again"; exit 1; }
node "$S" claude-md-optout
```

Continue with the CLAUDE.md checks below only when the probe printed exactly `CLAUDE.md management enabled`.

- If it prints `CLAUDE.md management disabled by claudeMdEnabled: false`, report that line as INFO, skip the rest of this step and the "Fix: Missing/Outdated CLAUDE.md" fix, and never create or overwrite `CLAUDE.md` or `CLAUDE-omc.md`.
- If it prints neither line, or the command fails (for example `node` is not on `PATH`, which Step 5 diagnoses, or the plugin files are missing, which the message `omc-doctor: plugin files not found` reports), report WARN - could not check the `claudeMdEnabled` opt-out, skip the rest of this step and the "Fix: Missing/Outdated CLAUDE.md" fix, and never create or overwrite `CLAUDE.md` or `CLAUDE-omc.md`. A third line, `CLAUDE.md management unknown: could not read .omc-config.json (<reason>)`, is such a case: the file is there and cannot be used (<reason> is an error code for a link to nothing or no permission, `not a regular file`, `has a byte order mark` (the runtime cannot read such a file either; it is to be saved without one) or `not valid JSON` for an empty file too), so the opt-out may be in it.

```bash
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; C=${C#"${C%%[![:space:]]*}"}; C=${C%"${C##*[![:space:]]}"}; case "$C" in '') C=$HOME/.claude;; '~') C=$HOME;; '~/'*|'~\'*) C=$HOME/${C#??};; esac; case $C in [A-Za-z]:[/\\]*|\\*|//[!/]*);; *) case $C in /*);; *) L=$(pwd -P 2>/dev/null) || { echo "omc-doctor: current directory no longer exists" >&2; exit 1; }; C=$L/$C;; esac; O=; R=$C; while [ -n "$R" ]; do P=${R%%/*}; case $R in */*) R=${R#*/};; *) R=;; esac; case $P in ''|.);; ..) case $O in ''|*/..) case $C in /*);; *) O=$O/..;; esac;; *) O=${O%/*};; esac;; *) O=$O/$P;; esac; done; case $C in /*) C=${O:-/};; *) C=${O#/}; C=${C:-.};; esac;; esac
# Check if CLAUDE.md exists
ls -la "$C"/CLAUDE.md 2>/dev/null

# Check for OMC markers (<!-- OMC:START --> is the canonical marker); only a regular file is read, as grep on a FIFO never returns
if [ -f "$C/CLAUDE.md" ]; then grep -q "<!-- OMC:START -->" "$C/CLAUDE.md" 2>/dev/null; case $? in 0) echo "Has OMC config";; 1) echo "Missing OMC config in CLAUDE.md";; *) echo "Could not read CLAUDE.md";; esac
elif [ -e "$C/CLAUDE.md" ] || [ -L "$C/CLAUDE.md" ]; then echo "Could not read CLAUDE.md"; else echo "Missing OMC config in CLAUDE.md"; fi

# Check companion files for file-split pattern (e.g. CLAUDE-omc.md)
find -L "$C" -maxdepth 1 -type f -iname 'CLAUDE-*.md' -print 2>/dev/null
while IFS= read -r f; do
  grep -q "<!-- OMC:START -->" "$f" 2>/dev/null && echo "Has OMC config in companion: $f"
done < <(find -L "$C" -maxdepth 1 -type f -iname 'CLAUDE-*.md' -print 2>/dev/null)

# Check if CLAUDE.md references a companion file
[ -f "$C/CLAUDE.md" ] && grep -o "CLAUDE-[^ )]*\.md" "$C/CLAUDE.md" 2>/dev/null
```

```bash
# Check CLAUDE.md (or deterministic companion) version marker and compare with latest installed plugin cache version
S=; for R in "${CLAUDE_PLUGIN_ROOT}" "${OMC_PLUGIN_ROOT:-}"; do [ "${R#*[![:space:]]}" != "$R" ] && [ -f "$R/scripts/omc-doctor.mjs" ] && { S="$R/scripts/omc-doctor.mjs"; break; }; done; [ -n "$S" ] || { R=$(node -p '(require("child_process").spawnSync("npm root -g",{encoding:"utf8",timeout:5000,shell:true}).stdout||"").trim()' 2>/dev/null)/oh-my-claude-sisyphus; [ -f "$R/scripts/omc-doctor.mjs" ] && S="$R/scripts/omc-doctor.mjs"; }; [ -n "$S" ] || { echo "omc-doctor: plugin files not found: scripts/omc-doctor.mjs is missing under CLAUDE_PLUGIN_ROOT, under OMC_PLUGIN_ROOT and in the global npm package, or the variables are unset. Reinstall or update the plugin (omc update, or claude plugin update oh-my-claudecode), restart Claude Code and run the doctor again"; exit 1; }
node "$S" claude-md-version
```

**Diagnosis**:
- If CLAUDE.md missing: CRITICAL - CLAUDE.md not configured
- If `<!-- OMC:START -->` found in CLAUDE.md: OK
- If `<!-- OMC:START -->` found in a companion file (e.g. `CLAUDE-omc.md`): OK - file-split pattern detected
- If no OMC markers in CLAUDE.md or any companion file: WARN - outdated CLAUDE.md; `Could not read CLAUDE.md`: WARN, it is there and unreadable
- If `OMC:VERSION` marker is missing from deterministic CLAUDE source scan (base + referenced companion): WARN - cannot verify CLAUDE.md freshness
- If `CLAUDE.md OMC version` != `Latest cached plugin version`: WARN - version drift detected (run `omc update` or `omc setup`); the verdict line of the command decides: a CLAUDE.md marker the runtime cannot read (written with a leading `v`, without the single spaces, or in another letter case) is `VERSION DRIFT`, a leading `v` on the cached version is ignored, and a half-written cache directory (its `package.json` does not name that version) is no cached version; no drift is claimed when the command printed `VERSION CHECK SKIPPED` (`(none)`, `(unknown)` and `(unreadable)` are no versions). `(unreadable)` as the CLAUDE.md version or a `Note:` about an unreadable plugin cache or an unusable `installed_plugins.json`: WARN - name the file or directory; it is there, not missing

### Step 5: Check Ralph Runtime Prerequisites

Ralph is an agent-driven persistence loop, not a compiled program: its only hard runtime prerequisites are the Node runtime that executes OMC's hook scripts (`persistent-mode.mjs`, `keyword-detector.mjs`) and a writable config directory for `.omc/state/` state files such as `ralph-state.json`.

```bash
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; C=${C#"${C%%[![:space:]]*}"}; C=${C%"${C##*[![:space:]]}"}; case "$C" in '') C=$HOME/.claude;; '~') C=$HOME;; '~/'*|'~\'*) C=$HOME/${C#??};; esac; case $C in [A-Za-z]:[/\\]*|\\*|//[!/]*);; *) case $C in /*);; *) L=$(pwd -P 2>/dev/null) || { echo "omc-doctor: current directory no longer exists" >&2; exit 1; }; C=$L/$C;; esac; O=; R=$C; while [ -n "$R" ]; do P=${R%%/*}; case $R in */*) R=${R#*/};; *) R=;; esac; case $P in ''|.);; ..) case $O in ''|*/..) case $C in /*);; *) O=$O/..;; esac;; *) O=${O%/*};; esac;; *) O=$O/$P;; esac; done; case $C in /*) C=${O:-/};; *) C=${O#/}; C=${C:-.};; esac;; esac
node --version || echo "Node for Ralph: MISSING"
mkdir -p "$C" 2>/dev/null
touch "$C/.omc-write-probe" 2>/dev/null && rm -f "$C/.omc-write-probe" && echo "Config dir writable" || echo "Config dir NOT writable"
```

**Diagnosis**:
- If Node runs and prints a version: OK - Ralph runtime prerequisite present
- If `node` is missing or fails: CRITICAL - OMC hooks and Ralph cannot run without Node (see https://nodejs.org for installers; nvm/fnm users need Node on the PATH of non-interactive shells)
- If the config dir is not writable: WARN - Ralph state persistence will fail until it is writable

### Step 6: Check for Stale Plugin Cache

```bash
# Count versions in cache (cross-platform)
S=; for R in "${CLAUDE_PLUGIN_ROOT}" "${OMC_PLUGIN_ROOT:-}"; do [ "${R#*[![:space:]]}" != "$R" ] && [ -f "$R/scripts/omc-doctor.mjs" ] && { S="$R/scripts/omc-doctor.mjs"; break; }; done; [ -n "$S" ] || { R=$(node -p '(require("child_process").spawnSync("npm root -g",{encoding:"utf8",timeout:5000,shell:true}).stdout||"").trim()' 2>/dev/null)/oh-my-claude-sisyphus; [ -f "$R/scripts/omc-doctor.mjs" ] && S="$R/scripts/omc-doctor.mjs"; }; [ -n "$S" ] || { echo "omc-doctor: plugin files not found: scripts/omc-doctor.mjs is missing under CLAUDE_PLUGIN_ROOT, under OMC_PLUGIN_ROOT and in the global npm package, or the variables are unset. Reinstall or update the plugin (omc update, or claude plugin update oh-my-claudecode), restart Claude Code and run the doctor again"; exit 1; }
node "$S" cache-versions
```

**Diagnosis**:
- If > 1 version (on any line when several marketplaces are printed): WARN - multiple cached versions (cleanup recommended)
- If a line says `could not read <directory> (<code>)`: WARN - the plugin cache cannot be read (name the directory and the code); `0 versions` is printed only for a directory that is not there

### Step 7: Check for Legacy Curl-Installed Content

Check for legacy agents, commands, and skills installed via curl (before plugin system).
**Important**: Only flag files whose names match actual plugin-provided names. Do NOT flag user's custom agents/commands/skills that are unrelated to OMC.

```bash
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; C=${C#"${C%%[![:space:]]*}"}; C=${C%"${C##*[![:space:]]}"}; case "$C" in '') C=$HOME/.claude;; '~') C=$HOME;; '~/'*|'~\'*) C=$HOME/${C#??};; esac; case $C in [A-Za-z]:[/\\]*|\\*|//[!/]*);; *) case $C in /*);; *) L=$(pwd -P 2>/dev/null) || { echo "omc-doctor: current directory no longer exists" >&2; exit 1; }; C=$L/$C;; esac; O=; R=$C; while [ -n "$R" ]; do P=${R%%/*}; case $R in */*) R=${R#*/};; *) R=;; esac; case $P in ''|.);; ..) case $O in ''|*/..) case $C in /*);; *) O=$O/..;; esac;; *) O=${O%/*};; esac;; *) O=$O/$P;; esac; done; case $C in /*) C=${O:-/};; *) C=${O#/}; C=${C:-.};; esac;; esac
# Check for legacy agents directory
ls -la "$C"/agents/ 2>/dev/null

# Check for legacy commands directory
ls -la "$C"/commands/ 2>/dev/null

# Check for legacy skills directory
ls -la "$C"/skills/ 2>/dev/null
```

**Diagnosis**:
- If `~/.claude/agents/` exists with files matching plugin agent names: WARN - legacy agents (now provided by plugin)
- If `~/.claude/commands/` exists with files matching plugin command names: WARN - legacy commands (now provided by plugin)
- If `~/.claude/skills/` exists with files matching plugin skill names: WARN - legacy skills (now provided by plugin)
- If custom files exist that do NOT match plugin names: OK - these are user custom content, do not flag them

**Known plugin agent names** (check agents/ for these):
`architect.md`, `document-specialist.md`, `explore.md`, `executor.md`, `debugger.md`, `planner.md`, `analyst.md`, `critic.md`, `verifier.md`, `test-engineer.md`, `designer.md`, `writer.md`, `qa-tester.md`, `scientist.md`, `security-reviewer.md`, `code-reviewer.md`, `git-master.md`, `code-simplifier.md`

**Known plugin skill names** (check skills/ for these):
`ai-slop-cleaner`, `ask`, `autopilot`, `cancel`, `configure-notifications`, `deep-interview`, `deepinit`, `external-context`, `hud`, `omc-doctor`, `omc-setup`, `plan`, `project-session-manager`, `ralph`, `ralplan`, `release`, `skill`, `team`, `visual-verdict`, `wiki`

**Known plugin command names** (check commands/ for these):
`deepsearch.md`

---

## Report Format

After running all checks, output a report:

```
## OMC Doctor Report

### Summary
[HEALTHY / ISSUES FOUND]

### Checks

| Check | Status | Details |
|-------|--------|---------|
| Plugin Version | OK/WARN/CRITICAL | ... |
| Legacy Hooks (settings.json) | OK/WARN/CRITICAL | ... |
| Legacy Scripts (~/.claude/hooks/) | OK/WARN | ... |
| CLAUDE.md | OK/INFO/WARN/CRITICAL | ... |
| Ralph Runtime Prerequisites (Node, config dir) | OK/CRITICAL | ... |
| Plugin Cache | OK/WARN | ... |
| Legacy Agents (~/.claude/agents/) | OK/WARN | ... |
| Legacy Commands (~/.claude/commands/) | OK/WARN | ... |
| Legacy Skills (~/.claude/skills/) | OK/WARN | ... |

### Issues Found
1. [Issue description]
2. [Issue description]

### Recommended Fixes
[List fixes based on issues]
```

---

## Auto-Fix (if user confirms)

If issues found, ask user: "Would you like me to fix these issues automatically?"

If yes, apply fixes. For each affected profile-level, project-level, or project-local settings file, approval of this general question is not enough to authorize removing hooks: show the exact matching hook objects and the non-OMC entries/groups that will remain, then ask for explicit confirmation of that scoped change. Include every applicable project-local file in the proposal, including main-checkout, Windows side-by-side, and legacy starting-directory files when present; changes to the main checkout's local file affect its linked worktrees. Before writing, verify the target is a regular non-symlink file. Create a timestamped backup beside the original with exclusive, no-follow semantics (for example, an `open` using `wx`), without overwriting an existing path. Give the backup permissions no broader than the source (for example, use `0600` for a `0600` source, and retain any stricter mode or ACL); do not rely on the process umask or default file mode. Write the replacement through a same-directory exclusive/no-follow temporary file and atomic replacement, preserving the original mode and restrictive ACLs or applying stricter protections. On Windows, preserve the source ACLs using platform-appropriate operations. If the backup or replacement cannot be kept no broader than the original, leave the settings file untouched and do not apply cleanup. Never edit managed settings or MDM/server policy. If no legacy entries match, leave the file untouched.

### Fix: Legacy Hooks in settings.json
For each affected profile-level, project-level, or project-local settings file:
1. Remove a hook only when all Step 2 checks pass: the command is a plain direct invocation (including the direct executable-path form only when the target has execute permission), the active plugin provides the payload's canonical or specifically verified equivalent handler under the registration's event, and the target file matches a shipped or trusted versioned OMC payload. A same-event handler that implements unrelated behavior does not qualify. Do not match other scripts merely because they are under a `hooks/` directory, plugin-root commands, or similarly named scripts in other directories.
2. Remove only those matching objects from their `hooks.<event>[].hooks[]` arrays. Preserve every unmatched hook object and every matcher group that still has hooks, including user and third-party hooks. If a command is composite or ambiguous, leave it unchanged and report it for manual cleanup. If removing matched objects leaves a matcher group with no hooks, remove that now-empty group; remove an event key when no groups remain and remove the top-level `"hooks"` key when no events remain. Leave all other settings unchanged.

### Fix: Legacy Script Files
Before deleting any script, inspect active session-scoped hook references in skill and subagent frontmatter, enabled plugin manifests, and settings sources. Skill frontmatter hooks remain active for the rest of the session after invocation; subagent frontmatter hooks remain active while that subagent runs. Inspect the source frontmatter of every active skill and running subagent for commands referencing the candidate script. If an active hook references the script, keep it until that skill or subagent is no longer active, then repeat the reference check. If active skill/subagent sources cannot be conclusively enumerated or read, leave the script in place.

Also enumerate every enabled or loaded plugin root, including marketplace plugins and local/inline plugins supplied through `--plugin-dir`, `--plugin-url`, or `CLAUDE_CODE_PLUGIN_DIRS`. Resolve marketplace installs through the effective plugin registry (for example, `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/installed_plugins.json` and its recorded install paths), and include active `@skills-dir` plugin roots under user or project `.claude/skills/`. Read each plugin's `.claude-plugin/plugin.json` and `hooks/hooks.json` read-only. Parse the manifest's optional `hooks` field as a `.json` path, an inline hooks object, or an array mixing paths and inline objects; resolve every declared file path relative to that plugin root and inspect the command handlers from every declared source and the default `hooks/hooks.json` for references to the candidate script, resolving config/home environment variables and platform path separators. A registry entry under any plugin ID, also an unrelated one, that is not an object, has neither a `version` nor an `installPath`, or has one that is not a non-blank string cannot be read, so it counts as not conclusively enumerated (an entry with only a `version` names no root to read). If any enabled/loaded plugin root, manifest, or declared hook source cannot be conclusively enumerated, resolved, or read, leave the script in place; if any source references it, leave the script in place.

Claude Code retains the current session's hook snapshot after a settings file is edited. If this session removes a matching hook registration, keep its script in place until the user restarts Claude Code; never delete a target in the same session that removed its settings hook. In a later session, repeat the complete reference scan and final checks below before deleting the script.

The canonical event and equivalent-handler requirements from Step 2 also gate script deletion; an unrelated plugin handler under the same event cannot justify deleting a standalone payload.

The settings scan alone does not establish that no references remain; the active skill/subagent and enabled-plugin manifest scans above must also be complete and clean before deleting the target. A plugin manifest reference blocks deletion even when its command is registered under a different event.

After handling every relevant user/project settings file, re-check `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`, the primary working directory's `.claude/settings.json`, every applicable project-local `.claude/settings.local.json` path resolved above (main-checkout, Windows side-by-side, and legacy starting-directory paths where applicable), for references to each legacy script, including references in composite or ambiguous commands. Also inspect managed hook sources read-only: `/etc/claude-code/managed-settings.json` on Linux/WSL, `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `C:\Program Files\ClaudeCode\managed-settings.json` on Windows, and any applicable MDM, server-managed, or command-line `--settings` sources (see [Claude Code managed-settings locations](https://code.claude.com/docs/en/managed-settings#deploy-a-managed-settings-file)). Never edit those sources. Remove a script only when no configured hook references remain in any source, the active plugin provides the same event, and its content matches the shipped OMC payload already verified in Step 2. If any applicable project-local path, main checkout root, managed source, or command-line source cannot be resolved or inspected, if any source references the script, the user declined the relevant settings change, a file could not be updated, no shipped payload exists, or verification is inconclusive, leave the corresponding script in place. Never run an unconditional `rm -f` based on basename.

### Fix: Outdated Plugin
**Update first**: moving cache directories does not update the plugin, and the installed version is normally pinned in `installed_plugins.json`, so the command below often has nothing to move. Tell the user to run the `Updater:` line that Step 1 printed for the active plugin ID, then restart Claude Code. The line is derived from the registry entry of that install (for a marketplace install it refreshes the marketplace clone named in the entry and then updates that plugin ID; for a `Channel: npm` install it is `omc update`), so do not substitute a fixed marketplace or plugin ID. If Step 1 printed `Channel: unknown`, say so and do not guess an updater; for `Channel: plugin-dir` there is no updater line to run, so tell the user to update and rebuild that checkout and run `omc setup --plugin-dir-mode`, and the cache command cannot update it (it only cleans up the other cached versions and keeps that directory when it lies in the cache); if it listed several plugin IDs, update the one that is enabled (resolved with the precedence rules of Step 2). Do not report the plugin as fixed until a later run of Step 1 shows INSTALLED equal to that channel's `Latest:`. The cache command below is only the cleanup of old cached versions afterwards.

**Cache guard**: Diagnostics do not authorize removal or setup changes. Do not prune cache versions by age, lexical/version order, or presence of a newer version. A cache version is protected and must never be moved aside when it is pinned in `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/installed_plugins.json` (by `version` or by `installPath`, under any supported OMC plugin ID: `oh-my-claudecode@omc`, `oh-my-claudecode` or `oh-my-claudecode@oh-my-claudecode`, in any letter case; the registry is read like the installer reads it, from its `plugins` object or, when there is none, from its top level), when the `installPath` of any other plugin or `OMC_PLUGIN_ROOT` or `CLAUDE_PLUGIN_ROOT` points into it, or when a running session occupies it (a record in `${CLAUDE_CONFIG_DIR:-~/.claude}/.omc/cache-occupancy/` whose plugin root is that version or inside it; a record is ignored only when its owner is proven gone: the process id no longer exists, on Linux the process start time differs from the recorded one, or the record is dated more than 5 minutes in the future (a record that names another host or PID namespace in its `host` field is never judged by a local process probe, so its owner is not proven gone, and the place of a machine without a machine id file is its operating system and host name, so two such machines of one host name on a shared profile are taken for one; a record without a `host` field, written by an older plugin version, is treated the same way (never judged by a local process probe, and it does not expire by itself), so when the session that wrote it no longer runs, delete its file `<hash>.json` from `<config>/.omc/cache-occupancy/` (`<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`; the JSON has no `host` key and its `pid` does not run on the machine that wrote it) to free the version; a record of another place whose plugin root lies in no cache of this system (a profile mounted under another path on that host) stops the command before anything is moved; a record of another place does not expire by itself: when that machine no longer exists, deleting its file from `<config>/.omc/cache-occupancy/` by hand frees the version); an old date alone never ignores a record, and this command never deletes one). Every refusal (`Nothing moved: ... could not be read completely`, `identity unavailable`, `could not read <directory>`) and a failed move (`Cache move failed`) ends the command with exit code 1, so that it cannot be taken for a success; a finished move, `Nothing to move`, `Nothing moved: no pinned ...` and a missing cache end with 0. If every cached version is protected, move nothing and report the protection instead of running the command below. Backups go to `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/backups/oh-my-claudecode/`, outside `plugins/cache/`: OMC's stale cache purge can remove any cache directory that is not the active version, so a backup left inside the cache may not survive. The command resolves that directory through every link on the way before the first move and refuses (exit code 1, nothing moved) when it is, lies inside or contains a cache, marketplace, plugin root, occupancy or registered install tree, or cannot be resolved; a link that leads elsewhere is allowed and the `Moved` line then names the real directory. The rest of the guard (how paths are compared and by which identity, what makes the registry, a record or a path unreadable, the freshness rule and its limits, the cache directories and the names that are not versions, the trees the backup directory must lie outside) is in the guide section `cache-guard`: before the command below, run the Guide block above with `cache-guard` in place of `SECTION` and read all of it; if that block fails or prints nothing, do not run the command below and tell the user the guide is missing (reinstall or update the plugin).
```bash
# Move unprotected cache versions to plugins/backups (cross-platform); keep versions pinned in installed_plugins.json; never delete
S=; for R in "${CLAUDE_PLUGIN_ROOT}" "${OMC_PLUGIN_ROOT:-}"; do [ "${R#*[![:space:]]}" != "$R" ] && [ -f "$R/scripts/omc-doctor.mjs" ] && { S="$R/scripts/omc-doctor.mjs"; break; }; done; [ -n "$S" ] || { R=$(node -p '(require("child_process").spawnSync("npm root -g",{encoding:"utf8",timeout:5000,shell:true}).stdout||"").trim()' 2>/dev/null)/oh-my-claude-sisyphus; [ -f "$R/scripts/omc-doctor.mjs" ] && S="$R/scripts/omc-doctor.mjs"; }; [ -n "$S" ] || { echo "omc-doctor: plugin files not found: scripts/omc-doctor.mjs is missing under CLAUDE_PLUGIN_ROOT, under OMC_PLUGIN_ROOT and in the global npm package, or the variables are unset. Reinstall or update the plugin (omc update, or claude plugin update oh-my-claudecode), restart Claude Code and run the doctor again"; exit 1; }
node "$S" guide cache-guard >/dev/null || exit 1
node "$S" cache-outdated
```

### Fix: Stale Cache (multiple versions)
**Stale cache guard**: Diagnostics do not authorize removal or setup changes. Do not prune cache versions by age, lexical/version order, or presence of a newer version. Everything the **Cache guard** of "Fix: Outdated Plugin" above says applies to the command below unchanged: the protection sources (the pins in `installed_plugins.json`, the `installPath` of other plugins, the plugin root variables, the occupancy records, every link on the way), the fail-closed refusals with exit code 1, the 10-minute freshness rule with its other limits, the unreadable and missing cache directories, the names that are not versions and the backups in `plugins/backups/oh-my-claudecode/`, outside `plugins/cache/` and resolved before the first move. Move aside only unprotected versions, and report the protected versions kept. Before the command below, run the Guide block above with `cache-guard` in place of `SECTION`, as for the command of "Fix: Outdated Plugin", and do not run the command below if that block fails.
```bash
# Keep protected versions; never prune by age, lexical/version order, or presence of a newer version; move only unprotected versions to plugins/backups
S=; for R in "${CLAUDE_PLUGIN_ROOT}" "${OMC_PLUGIN_ROOT:-}"; do [ "${R#*[![:space:]]}" != "$R" ] && [ -f "$R/scripts/omc-doctor.mjs" ] && { S="$R/scripts/omc-doctor.mjs"; break; }; done; [ -n "$S" ] || { R=$(node -p '(require("child_process").spawnSync("npm root -g",{encoding:"utf8",timeout:5000,shell:true}).stdout||"").trim()' 2>/dev/null)/oh-my-claude-sisyphus; [ -f "$R/scripts/omc-doctor.mjs" ] && S="$R/scripts/omc-doctor.mjs"; }; [ -n "$S" ] || { echo "omc-doctor: plugin files not found: scripts/omc-doctor.mjs is missing under CLAUDE_PLUGIN_ROOT, under OMC_PLUGIN_ROOT and in the global npm package, or the variables are unset. Reinstall or update the plugin (omc update, or claude plugin update oh-my-claudecode), restart Claude Code and run the doctor again"; exit 1; }
node "$S" guide cache-guard >/dev/null || exit 1
node "$S" cache-stale
```

### Fix: Missing/Outdated CLAUDE.md
Skip this fix unless Step 4 printed `CLAUDE.md management enabled`: skip it when Step 4 reported `CLAUDE.md management disabled by claudeMdEnabled: false` or could not check the opt-out, and when it printed `Could not read CLAUDE.md` or the version `(unreadable)`: write nothing through a file that cannot be read.

Fetch latest from GitHub and write to `${CLAUDE_CONFIG_DIR:-~/.claude}/CLAUDE.md`. If CLAUDE.md is a link that leads into `plugins/cache` or `plugins/marketplaces` of the configuration directory, write nothing and say where it leads: the cache cleanup and the marketplace update remove or replace what lies there. When that file exists, first copy it (`cp -n -p`) to a new `CLAUDE.md.bak-<UTC time>-<pid>` beside it and write only after the copy succeeded; if it fails, leave CLAUDE.md as it is and say so. The copy is a new regular file in the configuration directory itself, also when CLAUDE.md is a link:
```
WebFetch(url: "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md", prompt: "Return the complete raw markdown content exactly as-is")
```

### Fix: Legacy Curl-Installed Content

**Legacy content guard**: Diagnostics do not authorize deletion or setup changes. Before moving anything, record the exact target, its ownership evidence, and its contents (a file list of what is being moved and why).
Do not move entire `agents/`, `commands/`, or `skills/` roots to resolve a mixed installation. Never touch `agents/` or `skills/` roots containing any file that is not a verified OMC payload (those roots hold user custom agents and skills); with any such file present, report the mixed installation instead of fixing it.
The only allowed cleanup is a reversible move (`mv`) to a sibling backup that does not exist yet, `<name>.bak-<UTC time>-<pid>`, made by `K` below, which stops when that name exists (a fixed `.bak` name is replaced or nested into by a second run); deletion (`rm -rf`, `rm`) is never allowed. Move a whole root only when every file inside matches a name shipped in the active plugin's own `agents/`, `commands/`, or `skills/` directory. A `commands/` root that also holds a custom (non-OMC) file is not moved as a whole: move only the individually verified OMC-owned files into one new backup directory (`K commands <file>...`) and leave every other file in place. An `agents/` or `skills/` root that holds a custom file is only reported, as stated above: nothing in it is moved.

```bash
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; C=${C#"${C%%[![:space:]]*}"}; C=${C%"${C##*[![:space:]]}"}; case "$C" in '') C=$HOME/.claude;; '~') C=$HOME;; '~/'*|'~\'*) C=$HOME/${C#??};; esac; case $C in [A-Za-z]:[/\\]*|\\*|//[!/]*);; *) case $C in /*);; *) L=$(pwd -P 2>/dev/null) || { echo "omc-doctor: current directory no longer exists" >&2; exit 1; }; C=$L/$C;; esac; O=; R=$C; while [ -n "$R" ]; do P=${R%%/*}; case $R in */*) R=${R#*/};; *) R=;; esac; case $P in ''|.);; ..) case $O in ''|*/..) case $C in /*);; *) O=$O/..;; esac;; *) O=${O%/*};; esac;; *) O=$O/$P;; esac; done; case $C in /*) C=${O:-/};; *) C=${O#/}; C=${C:-.};; esac;; esac
# Backup first (optional - ask user): K moves "$C/<name>", or only the files listed after it, to a new "$C/<name>.bak-<UTC time>-<pid>" (a name that is a link is moved as the link, and refused when files are listed)
K() { D="$C/$1.bak-$(date -u +%Y%m%d%H%M%S)-$$"; [ ! -e "$D" ] && [ ! -L "$D" ] || { echo "Nothing moved: $D exists" >&2; return 1; }; if [ $# -eq 1 ]; then mv -- "$C/$1" "$D"; else N=$1; shift; [ ! -L "$C/$N" ] || { echo "Nothing moved: $C/$N is a link, so the files in it are not in this configuration directory" >&2; return 1; }; mkdir -- "$D" && ( cd -- "$C/$N" && mv -n -- "$@" "$D"/ ); fi; }
# K agents
# K commands
# K skills
# K commands deepsearch.md
# Never rm -rf here: the only allowed form is the reversible move above, after the guards above
```

**Note**: Only move (never delete) if these contain oh-my-claudecode-related files. If user has custom agents/commands/skills, warn them and ask before moving.

---

## Post-Fix

After applying fixes, inform user:
> Fixes applied. **Restart Claude Code** for changes to take effect.
