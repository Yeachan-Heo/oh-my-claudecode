# Script-side judgment channel: subprocess over stdin JSON

Plain-Node hook scripts (workflow-drift-guard, post-tool-verifier) deliberately cannot import TypeScript — they must run before a build. To let them consult the judgment resolver without breaking that invariant, the resolver is invoked through a one-shot child process that reads a JSON request from stdin and writes a JSON result to stdout. Rejected: in-process TS imports (breaks the pre-build invariant); long-lived local daemon (operational surface a hook layer should not own). Latency budget (owner to confirm): detector-type calls 0ms — fire-and-record from the script, never blocking the tool path; the gate-type ceiling is still open. The originally proposed ≤250ms gate budget cannot be met by a real call: measured single-question round-trips against the live API are 465-605ms (#4091), which is why OMC_JEV_TIMEOUT_MS now defaults to 2000ms. A gate that blocks for ≤250ms therefore means "always degrade to the twin on the gate path", which is a product decision, not a tuning constant. Status: the channel is implemented (scripts/jev-resolve.mjs); the gate-type latency budget remains proposed — awaiting the owner decision.

## Plugin hook reachability (#4120)

Plugin `hooks/hooks.json` invokes the plain-Node scripts rather than the
TypeScript hook bridge. Those scripts share the opt-in and secure request-file
spawn path in `scripts/lib/jev-shadow.mjs`. The registered points reach it at
these existing event/twin sites:

- `intent`, `skill-trigger`, and `task-size`: `scripts/keyword-detector.mjs`
  (`UserPromptSubmit`)
- `model-routing` and `slop-warning`: `scripts/pre-tool-enforcer.mjs`
  (`PreToolUse`)
- `loop-continuation`, `ralph-verdict`, and `learner-extraction`:
  `scripts/persistent-mode.mjs` (`Stop`); learner detection uses the event's
  `last_assistant_message`. The plugin's minimal Ralph Stop hook has no PRD
  verifier, so its verdict twin is conservatively false and is marked
  `verification_available: false` in the recorded state.
- `context-pruning`: `scripts/post-tool-verifier.mjs` (`PostToolUse`), where the
  existing context-usage threshold and tool-result candidate are available;
  `PreCompact` only preserves state and has no pruning candidate/twin.
- `simplifier-trigger`: `scripts/code-simplifier.mjs` (`Stop`)

These calls are fire-and-record, matching the slop-warning integration. The
script hooks do not consume the resolver's child-process result: the existing
hook heuristic remains authoritative, including when a request is logged with
`mode: "active"`. Active decision application is therefore not implied by
plugin-script reachability.
