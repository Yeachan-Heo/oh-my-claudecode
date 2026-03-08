---
name: ask-codex
description: Ask Codex via local CLI and capture a reusable artifact
---

# Ask Codex

Use Codex as an external advisor through OMC's ask command.

## Usage

```bash
/oh-my-claudecode:ask-codex <question or task>
```

## Routing

Preferred path:

```bash
omc ask codex "{{ARGUMENTS}}"
```

Wrapper alias (compatibility):

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/ask-codex.sh" "{{ARGUMENTS}}"
```

## Requirements

- Local Codex CLI must be installed and authenticated.
- Verify with:

```bash
codex --version
```

## Artifacts

`omc ask` writes artifacts to:

```text
.omc/artifacts/ask/codex-<slug>-<timestamp>.md
```

Task: {{ARGUMENTS}}
