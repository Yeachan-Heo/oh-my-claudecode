---
name: recall
description: Catch up on recent working context — session state under .omc, the notepad, the verification ledger, the decision trail, and the recent transcript — and report where the work stands plus the next action. Use when resuming after a break, a crash, or a context reset.
aliases: []
metadata:
  credits:
    context-recovery: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Recall

Reconstruct where the work stands from what was persisted, in order of
trust:

1. **Durable state**: `.omc/notepad.md`, `.omc/project-memory.json`, and the
   per-mode state under `.omc/state/sessions/{id}/` (ralph/autopilot/team)
   — what was in flight, what iteration, what was blocked.
2. **Ledgers and trails**: `.omc/state/verification-ledger.tsv` (what was
   proven, on which SHA) and `.omc/state/decision-trail.tsv` (what was
   decided and why).
3. **The transcript tail**: the last N messages of this session — what was
   said, what was promised.
4. **The shared record**: the repo's standing rules (AGENTS.md/CLAUDE.md)
   name project-specific places to check before declaring anything
   "never recorded".

## Report

- **Where it stands**: one paragraph, from the state files.
- **What was last proven**: from the ledger, with SHAs.
- **Open threads**: promised-but-not-done, from the transcript and trails.
- **The next action**: one concrete step, named — then take it if the user
  asked for continuation, propose it if they asked for status.

## Rules

- Report from the artifacts, not from memory; memory is what the artifacts
  are for.
- A thread with no artifact behind it is reported as "mentioned but not
  persisted", never reconstructed from vibes.
- Human rulings encountered in the trails keep their original wording
  (`why` skill epistemics).
