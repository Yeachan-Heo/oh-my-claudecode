---
name: omc-doctor
description: Diagnose and fix oh-my-claudecode installation issues
level: 3
---

# Doctor Skill

Note: All `~/.claude/...` paths in this guide respect `CLAUDE_CONFIG_DIR` when that environment variable is set.

## Task: Run Installation Diagnostics

You are the OMC Doctor - diagnose and fix installation issues.

### Step 1: Check Plugin Version

```bash
# Get installed and latest versions (cross-platform)
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),d=process.env.CLAUDE_CONFIG_DIR||p.join(h,'.claude'),b=p.join(d,'plugins','cache','omc','oh-my-claudecode');try{const v=f.readdirSync(b).filter(x=>/^\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));console.log('Installed:',v.length?v[v.length-1]:'(none)')}catch{console.log('Installed: (none)')}"
npm view oh-my-claude-sisyphus version 2>/dev/null || echo "Latest: (unavailable)"
```

**Diagnosis**:
- If no version installed: CRITICAL - plugin not installed
- If INSTALLED != LATEST: WARN - outdated plugin
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

For Node hooks, compare against the active plugin payload, any validated retained package under `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/omc/oh-my-claudecode/<version>/`, and the adjacent `node-hook-fingerprints.json` index. The index records SHA-256 fingerprints with exact stable release-tag provenance for every shipped Node module under `templates/hooks/**/*.mjs`, including hook helpers; search by payload path and inspect only that block rather than loading the entire index. If it is missing, malformed, or has no matching fingerprint, leave the entry for manual review. Preserve these additional trusted historical `keyword-detector.mjs` fingerprints from commits not necessarily represented by a release tag: `22d612620f54f360797e42fe608bf7f98155b92a3b0bba187fd89e216395d65a` (`fb125b37`), `180fc09840baa8ada1661bcc5a13821c9ca802f43ac52cb4e517ca2cba75838a` (`387956a4`), and `71a01806c1b0e29d8e553797de3900b7172654091980ae644d74e5e9291b8af2` (`0b46a595`).

**Diagnosis**:
- If a direct command is verified as OMC-owned and the active plugin provides the payload's canonical or specifically verified equivalent handler under the registration's event: CRITICAL - duplicate legacy hook
- If a composite or ambiguous command mentions a legacy path: WARN - manual cleanup required; never remove it automatically
- If the plugin is inactive, does not provide the event, or ownership cannot be verified: WARN - standalone hook may be active or user-owned; do not recommend removal

### Step 3: Check for Legacy Bash Hook Scripts

```bash
ls -la "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/hooks/*.sh 2>/dev/null
```

**Diagnosis**:
- If a listed script exists, call it a duplicate only when the active plugin provides the payload's canonical or specifically verified equivalent handler under the registration's event and the file matches a shipped payload or historical fingerprint; otherwise mark ownership as unknown or treat it as an active standalone hook.

### Step 4: Check CLAUDE.md

First check whether CLAUDE.md management is disabled. Read `${CLAUDE_CONFIG_DIR:-~/.claude}/.omc-config.json`; only an explicit `"claudeMdEnabled": false` disables it (missing file, missing key, or any other value means enabled).

```bash
# Check if the user opted out of global CLAUDE.md management (cross-platform; expands ~ in CLAUDE_CONFIG_DIR like getClaudeConfigDir)
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),c=(process.env.CLAUDE_CONFIG_DIR||'').trim(),d=!c?p.join(h,'.claude'):c==='~'?h:/^~[/\x5c]/.test(c)?p.join(h,c.slice(2)):c;let off=false;try{off=JSON.parse(f.readFileSync(p.join(d,'.omc-config.json'),'utf8')).claudeMdEnabled===false}catch{};console.log(off?'CLAUDE.md management disabled by claudeMdEnabled: false':'CLAUDE.md management enabled')"
```

Continue with the CLAUDE.md checks below only when the probe printed exactly `CLAUDE.md management enabled`.

- If it prints `CLAUDE.md management disabled by claudeMdEnabled: false`, report that line as INFO, skip the rest of this step and the "Fix: Missing/Outdated CLAUDE.md" fix, and never create or overwrite `CLAUDE.md` or `CLAUDE-omc.md`.
- If it prints neither line, or the command fails (for example `node` is not on `PATH`, which Step 5 diagnoses), report WARN - could not check the `claudeMdEnabled` opt-out, skip the rest of this step and the "Fix: Missing/Outdated CLAUDE.md" fix, and never create or overwrite `CLAUDE.md` or `CLAUDE-omc.md`.

```bash
# Check if CLAUDE.md exists
ls -la "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/CLAUDE.md 2>/dev/null

# Check for OMC markers (<!-- OMC:START --> is the canonical marker)
grep -q "<!-- OMC:START -->" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/CLAUDE.md" 2>/dev/null && echo "Has OMC config" || echo "Missing OMC config in CLAUDE.md"

# Check CLAUDE.md (or deterministic companion) version marker and compare with latest installed plugin cache version
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),d=process.env.CLAUDE_CONFIG_DIR||p.join(h,'.claude');const base=p.join(d,'CLAUDE.md');let baseContent='';try{baseContent=f.readFileSync(base,'utf8')}catch{};let candidates=[base];let referenced='';const importMatch=baseContent.match(/CLAUDE-[^ )]*\\.md/);if(importMatch){referenced=p.join(d,importMatch[0]);candidates.push(referenced)}else{const defaultCompanion=p.join(d,'CLAUDE-omc.md');if(f.existsSync(defaultCompanion))candidates.push(defaultCompanion);try{const others=f.readdirSync(d).filter(n=>/^CLAUDE-.*\\.md$/i.test(n)).sort().map(n=>p.join(d,n));for(const o of others){if(candidates.includes(o)===false)candidates.push(o)}}catch{}};let claudeV='(missing)';let claudeSource='(none)';for(const file of candidates){try{const c=f.readFileSync(file,'utf8');const m=c.match(/<!--\\s*OMC:VERSION:([^\\s]+)\\s*-->/i);if(m){claudeV=m[1];claudeSource=file;break}}catch{}};if(claudeV==='(missing)'&&candidates.length>0){claudeV='(missing marker)';claudeSource='scanned deterministic CLAUDE sources';};let pluginV='(none)';try{const b=p.join(d,'plugins','cache','omc','oh-my-claudecode');const v=f.readdirSync(b).filter(x=>/^\\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));pluginV=v.length?v[v.length-1]:'(none)';}catch{};console.log('CLAUDE.md OMC version:',claudeV);console.log('OMC version source:',claudeSource);console.log('Latest cached plugin version:',pluginV);if(claudeV==='(missing)'||claudeV==='(missing marker)'||pluginV==='(none)'){console.log('VERSION CHECK SKIPPED: missing CLAUDE marker or plugin cache')}else if(claudeV===pluginV){console.log('VERSION MATCH: CLAUDE and plugin cache are aligned')}else{console.log('VERSION DRIFT: CLAUDE.md and plugin versions differ')}"

# Check companion files for file-split pattern (e.g. CLAUDE-omc.md)
find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" -maxdepth 1 -type f -name 'CLAUDE-*.md' -print 2>/dev/null
while IFS= read -r f; do
  grep -q "<!-- OMC:START -->" "$f" 2>/dev/null && echo "Has OMC config in companion: $f"
done < <(find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" -maxdepth 1 -type f -name 'CLAUDE-*.md' -print 2>/dev/null)

# Check if CLAUDE.md references a companion file
grep -o "CLAUDE-[^ )]*\.md" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/CLAUDE.md" 2>/dev/null
```

**Diagnosis**:
- If CLAUDE.md missing: CRITICAL - CLAUDE.md not configured
- If `<!-- OMC:START -->` found in CLAUDE.md: OK
- If `<!-- OMC:START -->` found in a companion file (e.g. `CLAUDE-omc.md`): OK - file-split pattern detected
- If no OMC markers in CLAUDE.md or any companion file: WARN - outdated CLAUDE.md
- If `OMC:VERSION` marker is missing from deterministic CLAUDE source scan (base + referenced companion): WARN - cannot verify CLAUDE.md freshness
- If `CLAUDE.md OMC version` != `Latest cached plugin version`: WARN - version drift detected (run `omc update` or `omc setup`)

### Step 5: Check Ralph Runtime Prerequisites

Ralph is an agent-driven persistence loop, not a compiled program: its only hard runtime prerequisites are the Node runtime that executes OMC's hook scripts (`persistent-mode.mjs`, `keyword-detector.mjs`) and a writable config directory for `.omc/state/` state files such as `ralph-state.json`.

```bash
node --version || echo "Node for Ralph: MISSING"
mkdir -p "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" 2>/dev/null
touch "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.omc-write-probe" 2>/dev/null && rm -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.omc-write-probe" && echo "Config dir writable" || echo "Config dir NOT writable"
```

**Diagnosis**:
- If Node runs and prints a version: OK - Ralph runtime prerequisite present
- If `node` is missing or fails: CRITICAL - OMC hooks and Ralph cannot run without Node (see https://nodejs.org for installers; nvm/fnm users need Node on the PATH of non-interactive shells)
- If the config dir is not writable: WARN - Ralph state persistence will fail until it is writable

### Step 6: Check for Stale Plugin Cache

```bash
# Count versions in cache (cross-platform)
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),d=process.env.CLAUDE_CONFIG_DIR||p.join(h,'.claude'),b=p.join(d,'plugins','cache','omc','oh-my-claudecode');try{const v=f.readdirSync(b).filter(x=>/^\d/.test(x));console.log(v.length+' version(s):',v.join(', '))}catch{console.log('0 versions')}"
```

**Diagnosis**:
- If > 1 version: WARN - multiple cached versions (cleanup recommended)

### Step 7: Check for Legacy Curl-Installed Content

Check for legacy agents, commands, and skills installed via curl (before plugin system).
**Important**: Only flag files whose names match actual plugin-provided names. Do NOT flag user's custom agents/commands/skills that are unrelated to OMC.

```bash
# Check for legacy agents directory
ls -la "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/agents/ 2>/dev/null

# Check for legacy commands directory
ls -la "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/commands/ 2>/dev/null

# Check for legacy skills directory
ls -la "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/skills/ 2>/dev/null
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

Also enumerate every enabled or loaded plugin root, including marketplace plugins and local/inline plugins supplied through `--plugin-dir`, `--plugin-url`, or `CLAUDE_CODE_PLUGIN_DIRS`. Resolve marketplace installs through the effective plugin registry (for example, `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/installed_plugins.json` and its recorded install paths), and include active `@skills-dir` plugin roots under user or project `.claude/skills/`. Read each plugin's `.claude-plugin/plugin.json` and `hooks/hooks.json` read-only. Parse the manifest's optional `hooks` field as a `.json` path, an inline hooks object, or an array mixing paths and inline objects; resolve every declared file path relative to that plugin root and inspect the command handlers from every declared source and the default `hooks/hooks.json` for references to the candidate script, resolving config/home environment variables and platform path separators. If any enabled/loaded plugin root, manifest, or declared hook source cannot be conclusively enumerated, resolved, or read, leave the script in place; if any source references it, leave the script in place.

Claude Code retains the current session's hook snapshot after a settings file is edited. If this session removes a matching hook registration, keep its script in place until the user restarts Claude Code; never delete a target in the same session that removed its settings hook. In a later session, repeat the complete reference scan and final checks below before deleting the script.

The canonical event and equivalent-handler requirements from Step 2 also gate script deletion; an unrelated plugin handler under the same event cannot justify deleting a standalone payload.

The settings scan alone does not establish that no references remain; the active skill/subagent and enabled-plugin manifest scans above must also be complete and clean before deleting the target. A plugin manifest reference blocks deletion even when its command is registered under a different event.

After handling every relevant user/project settings file, re-check `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`, the primary working directory's `.claude/settings.json`, every applicable project-local `.claude/settings.local.json` path resolved above (main-checkout, Windows side-by-side, and legacy starting-directory paths where applicable), for references to each legacy script, including references in composite or ambiguous commands. Also inspect managed hook sources read-only: `/etc/claude-code/managed-settings.json` on Linux/WSL, `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `C:\Program Files\ClaudeCode\managed-settings.json` on Windows, and any applicable MDM, server-managed, or command-line `--settings` sources (see [Claude Code managed-settings locations](https://code.claude.com/docs/en/managed-settings#deploy-a-managed-settings-file)). Never edit those sources. Remove a script only when no configured hook references remain in any source, the active plugin provides the same event, and its content matches the shipped OMC payload already verified in Step 2. If any applicable project-local path, main checkout root, managed source, or command-line source cannot be resolved or inspected, if any source references the script, the user declined the relevant settings change, a file could not be updated, no shipped payload exists, or verification is inconclusive, leave the corresponding script in place. Never run an unconditional `rm -f` based on basename.

### Fix: Outdated Plugin
```bash
# Clear plugin cache (cross-platform)
node -e "const p=require('path'),f=require('fs'),d=process.env.CLAUDE_CONFIG_DIR||p.join(require('os').homedir(),'.claude'),b=p.join(d,'plugins','cache','omc','oh-my-claudecode');try{f.rmSync(b,{recursive:true,force:true});console.log('Plugin cache cleared. Restart Claude Code to fetch latest version.')}catch{console.log('No plugin cache found')}"
```

### Fix: Stale Cache (multiple versions)
```bash
# Keep only latest version (cross-platform)
node -e "const p=require('path'),f=require('fs'),h=require('os').homedir(),d=process.env.CLAUDE_CONFIG_DIR||p.join(h,'.claude'),b=p.join(d,'plugins','cache','omc','oh-my-claudecode');try{const v=f.readdirSync(b).filter(x=>/^\d/.test(x)).sort((a,c)=>a.localeCompare(c,void 0,{numeric:true}));v.slice(0,-1).forEach(x=>f.rmSync(p.join(b,x),{recursive:true,force:true}));console.log('Removed',v.length-1,'old version(s)')}catch(e){console.log('No cache to clean')}"
```

### Fix: Missing/Outdated CLAUDE.md
Skip this fix unless Step 4 printed `CLAUDE.md management enabled`: skip it when Step 4 reported `CLAUDE.md management disabled by claudeMdEnabled: false` or could not check the opt-out.

Fetch latest from GitHub and write to `${CLAUDE_CONFIG_DIR:-~/.claude}/CLAUDE.md`:
```
WebFetch(url: "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md", prompt: "Return the complete raw markdown content exactly as-is")
```

### Fix: Legacy Curl-Installed Content

Remove legacy agents, commands, and skills directories (now provided by plugin):

```bash
# Backup first (optional - ask user)
# mv "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/agents "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/agents.bak
# mv "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/commands "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/commands.bak
# mv "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/skills "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/skills.bak

# Or remove directly
rm -rf "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/agents
rm -rf "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/commands
rm -rf "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/skills
```

**Note**: Only remove if these contain oh-my-claudecode-related files. If user has custom agents/commands/skills, warn them and ask before removing.

---

## Post-Fix

After applying fixes, inform user:
> Fixes applied. **Restart Claude Code** for changes to take effect.
