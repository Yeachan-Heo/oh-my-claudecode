---
description: "Manually trigger Claude Code context compaction with OMC pre-compact preservation."
argument-hint: "[optional compaction note]"
---

# OMC Manual Context Compaction

This command intentionally uses the plugin-scoped name `/oh-my-claudecode:compact` instead of the bare `/compact` command. Bare `/compact` is reserved for Claude Code's native compaction command and must not be shadowed by OMC.

## Dispatch

1. Treat this as a request to compact the current Claude Code conversation now. Do not create a separate OMC summarizer and do not replace existing auto-compress behavior.
2. Preserve any user note for the compaction request:

```text
$ARGUMENTS
```

3. Invoke Claude Code's native compaction capability immediately:

```text
Skill("compact")
```

4. Rely on Claude Code's normal `PreCompact` lifecycle to run OMC's existing pre-compact hooks (`pre-compact`, project memory, and wiki preservation) before the native compaction occurs.
5. If the native compact capability is unavailable in this host, tell the user to run Claude Code's built-in `/compact` command directly; do not attempt to manually summarize the session.
