---
name: ask
description: Process-first advisor routing for Claude, Codex, Gemini, Grok, or Cursor via `omc ask`, with artifact capture and no raw CLI assembly
---

# Ask

Use OMC's canonical advisor skill to route a prompt through the local Claude, Codex, Gemini, Grok, or Cursor CLI and persist the result as an ask artifact.

## Usage

```bash
/oh-my-claudecode:ask <claude|codex|gemini|grok|cursor> <question or task>
```

Examples:

```bash
/oh-my-claudecode:ask codex "review this patch from a security perspective"
/oh-my-claudecode:ask gemini "suggest UX improvements for this flow"
/oh-my-claudecode:ask claude "draft an implementation plan for issue #123"
/oh-my-claudecode:ask cursor "apply this implementation plan"
```

## Routing

**Required execution path — always use this command:**

```bash
omc ask {{ARGUMENTS}}
```

**Do NOT manually construct raw provider CLI commands.** Never run `codex`, `claude`, `gemini`, `grok`, or `cursor-agent` directly to fulfill this skill. The `omc ask` wrapper handles correct flag selection, artifact persistence, and provider-version compatibility automatically. Manually assembling provider CLI flags will produce incorrect or outdated invocations.

## Requirements

- The selected local CLI must be installed and authenticated.
- Verify availability with the matching command:

```bash
claude --version
codex --version
gemini --version
grok --version
cursor-agent --version
```

## Backend overrides (advanced)

Any provider's local CLI can be repointed via environment variables, without code changes:

| Variable | Effect |
|----------|--------|
| `OMC_ASK_<PROVIDER>_BIN` | Replace the provider's binary (e.g. `gemini` → `agy`). |
| `OMC_ASK_<PROVIDER>_ARGS` | Replace its argument list. JSON array of strings; the literal `{{prompt}}` token is substituted with the prompt (omit it to pipe the prompt over stdin). |

`<PROVIDER>` is the upper-cased provider name (`CLAUDE`, `CODEX`, `GEMINI`, `GROK`, `CURSOR`). When both are unset the built-in command is used, so default behavior is unchanged.

Example — route the Gemini axis (and therefore `/ccg`) through Antigravity's `agy` CLI, e.g. after `@google/gemini-cli` access moves to Antigravity and the `gemini` binary returns `IneligibleTier`:

```bash
export OMC_ASK_GEMINI_BIN=agy
export OMC_ASK_GEMINI_ARGS='["--print","{{prompt}}","--dangerously-skip-permissions"]'
```

## Artifacts

`omc ask` writes artifacts to:

```text
.omc/artifacts/ask/<provider>-<slug>-<timestamp>.md
```

Task: {{ARGUMENTS}}
