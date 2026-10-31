# Quality Gates Configuration

Quality gates add skill-based reviews to three OMC workflow stages. Configure them in the normal merged OMC configuration; the stage names are exactly `deep-interview`, `ralplan`, and `omc-review`.

## Configuration

Project config is `.claude/omc.jsonc`; user config is `~/.config/claude-omc/config.jsonc` (or the configured XDG config directory). The standard loader merges user config first and project config second. A project stage list replaces the user list for that stage.

```jsonc
{
  "qualityGates": {
    "deep-interview": [
      { "skill": "requirements-audit", "mode": "blocking" }
    ],
    "ralplan": [
      "architecture-audit",
      { "skill": "security-audit", "mode": "blocking", "model": "claude-opus" }
    ],
    "omc-review": [
      { "skill": "performance-audit", "mode": "advisory" }
    ]
  }
}
```

A string or object without `mode` defaults to `advisory`. `blocking` gates must return `VERDICT: PASS` before handoff; `VERDICT: BLOCK` feeds the workflow's existing revision path. `model` is an optional Task model override.

Only those three stage keys are accepted. Legacy keys are validation errors, not aliases:

| Invalid key | Use |
| --- | --- |
| `code-review`, `codeReview` | `omc-review` |
| `interview` | `deep-interview` |
| `plan` | `ralplan` |

Retired OMC skill names are also rejected with a replacement hint: `pipeline`, `ultraqa`, `merge-readiness`, `deep-dive`, `sciomc`, `ccg`, `omc-teams`, `setup`, `mcp-setup`, `omc-reference`, `learner`, `writer-memory`, `local-build-reminder`, `understanding-gate`, `swarm`, `cancel-autopilot`, `cancel-ultrawork`, `cancel-ultraqa`, `omc-default`, `omc-default-global`, and `planner`. These retired names are documented in OMC migration/alias-retirement sources; `cancel-ralph` is not reserved because it remains an active alias.

The workflow-controller skills `deep-interview`, `ralplan`, and `omc-review` are reserved and cannot be configured as gates for any stage; invoking them from a gate could recursively re-enter a workflow.

## Skill resolution and CLI

`omc quality-gates list --stage <deep-interview|ralplan|omc-review> [--json]` prints normalized gates, model overrides, resolved `SKILL.md` paths, warnings, and validation errors. Resolution follows OMC's discovery roots: project `.claude/skills`, project `.omc/skills`, project `.agents/skills`, user `~/.claude/skills`, the active plugin, bundled OMC skills, and the working directory `skills` root. The Claude config directory honors `CLAUDE_CONFIG_DIR`.

An unresolved skill is reported as `status: "gate_unavailable"` with a visible warning. It is never treated as a pass and does not itself fail the workflow stage. Validation errors, including legacy stage keys, are printed in both human and JSON output.

## Workflow behavior and receipts

When a stage has no configured gates, it skips quality-gate listing, task invocation, and gate output entirely.

- **deep-interview:** run configured gates on the crystallized final spec before handoff. Record `{gate, mode, verdict}` for completed gates and `{gate, mode, status: "gate_unavailable"}` for unresolved skills. A blocking `BLOCK` requires clarification and a revised spec before handoff.
- **ralplan:** review the same draft snapshot with Architect, Critic, and one independent Task per available gate on each iteration. Reuse each gate's lane across revisions. A blocking `BLOCK` enters the existing Critic revision loop, bounded by its five-iteration cap; advisory results never block. Record gate results in the plan receipt/output.
- **omc-review:** run each configured gate as an independent Task on the reviewed changes. Blocking `BLOCK` makes the review request changes; advisory results are informational. Record each gate result with the review output.

Each gate Task loads the configured skill, reviews only its stage artifact/snapshot, and returns `VERDICT: PASS` or `VERDICT: BLOCK` with findings. Gate verdicts and unavailability are recorded per gate; they do not replace Architect, Critic, or the standard review lanes.
