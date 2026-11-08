# ADR 03487: Named Autopilot Stage Profiles

- **Status:** Accepted for v1
- **Issue:** #3487
- **Decision scope:** Versioned named stage schedules owned by the existing autopilot lifecycle

## Decision

Add an opt-in, closed v1 profile contract selected only with:

```text
/autopilot --workflow <name> <task>
```

Profiles live in user or project JSONC at `autopilot.workflows.<slug>`. A v1 profile has exactly `version: 1` and `stages`:

```jsonc
{
  "autopilot": {
    "workflows": {
      "plan-build-qa": {
        "version": 1,
        "stages": ["ralplan", "execution", "qa"]
      }
    }
  }
}
```

The only admitted sequences are:

```text
[ralplan, execution]
[ralplan, execution, ralph]
[ralplan, execution, qa]
[ralplan, execution, ralph, qa]
```

A profile is metadata and a stage schedule within autopilot. It is never a dynamic command, keyword alias, mode, plugin, filename, state identity, or independently cancellable workflow. Legacy `/autopilot <task>` behavior remains the no-profile compatibility path.

## Drivers

1. Provide reusable, named stage schedules without expanding autopilot into a general workflow engine.
2. Preserve existing autopilot ownership of state, cancellation, resume, cleanup, HUD, and Stop continuation.
3. Admit only sequences whose stage inputs and completion semantics are self-contained and verifiable.
4. Ensure selected runs are immutable, integrity-checked, and safe across plugin and standalone-installed hook paths.
5. Avoid unsafe routing authority when workflow-generated spawns cannot yet be authenticated.

## Admission I/O and validation

`ralplan` consumes the invocation task and produces the canonical autopilot plan artifact. `execution` requires that readable plan and produces implementation changes. `ralph` requires the plan and implementation produced by `execution`; it does not manufacture missing implementation. `qa` requires implementation from `execution`, either directly or after `ralph`.

Consequently, `ralplan` and exactly one `execution` are mandatory; `ralph` and `qa` are optional only in the declared order. Reordered lists, duplicate stages, omitted prerequisites, and non-built-in stages are rejected.

Names must match `^[a-z][a-z0-9-]{0,62}$`. They are rejected when empty, uppercase, whitespace-containing, or colliding with built-in stage IDs, autopilot/canonical mode names, or deprecated aliases. V1 profile blocks reject unknown keys, require numeric `version: 1`, and accept no model fields.

User and project configuration sources are validated before composition, with source-qualified failures. Different names coexist. A project profile with the same name atomically replaces the whole user profile; profile objects are never deep-merged. Environment configuration cannot define or replace a profile. Invalid/missing/duplicate `--workflow`, an unknown profile, or a missing task fails before autopilot state is created or changed.

V1 runtime support explicitly requires Linux with the `flock` utility. The authenticated transcript boundary requires Linux no-follow file-descriptor traversal and recoverable stale-lock removal requires kernel advisory locking; unsupported environments reject explicit named-profile activation before any autopilot state mutation. Legacy autopilot remains cross-platform.

## Descriptor and integrity

After successful selection, autopilot builds and atomically writes one complete, existing session-scoped autopilot state record. It contains an immutable descriptor and selected-only `PipelineTracking`; it must not write a generic placeholder and patch it later.

```ts
interface WorkflowRunDescriptorV1 {
  readonly descriptorVersion: 1;
  readonly workflowName: string;
  readonly profileVersion: 1;
  readonly stages: readonly PipelineStageId[];
  readonly profileHash: string;
}
```

`profileHash` is lowercase SHA-256 over UTF-8 canonical compact JSON for `{descriptorVersion:1, workflowName, profileVersion:1, stages}`: recursively lexicographically sorted object keys and the validated stage order. The descriptor excludes task text, full configuration, models, and mutable status. Only pipeline tracking may change for progress.

Read, resume, and Stop recompute the hash before deriving a stage. A malformed or mismatched descriptor returns `workflow_descriptor_integrity_failed`; it does not emit a stage prompt, reload configuration, or silently repair state. A cancelled valid run resumes from its persisted descriptor and tracking, so later configuration changes cannot alter it.

## Exact-once transcript boundary

Before emitting an adapter prompt, the active stage records its activation index, timestamp, and transcript boundary. The authoritative plugin Stop hook is `hooks/hooks.json` → `scripts/persistent-mode.mjs`; the standalone installer supplies the matching `templates/hooks/persistent-mode.mjs`. Both must use the same contract.

A transition accepts only the current adapter's exact completion signal in an authorized assistant JSONL record after that boundary. Evidence must be bound to the owner session and a bounded, regular, non-symlink transcript whose basename matches the session. User records, tool records, `<local-command-stdout>`, malformed JSONL, pre-activation evidence, stale state, wrong stages, wrong sessions, and arbitrary or symlink-spoofed transcripts cannot advance a stage.

The candidate records immutable evidence metadata: stage and session IDs, exact signal, record location and content hash, transcript identity/size snapshot, activation-boundary reference, and observation time. Before mutation the Stop handler rereads authoritative state, verifies descriptor hash and ownership, and compare-before-write guards the tracking revision/transition token. One invocation completes the current stage, records the observation, activates exactly the next selected stage, and emits that adapter's exact prompt. A duplicate or concurrent loser rereads once and reports the already-current status without replaying the old candidate. Completion is therefore exactly once.

## Canonical entrypoints

| Surface | Canonical entrypoint | Responsibility |
| --- | --- | --- |
| Plugin prompt selection | `hooks/hooks.json` → `scripts/keyword-detector.mjs` | Parse selection, validate and compose sources, construct descriptor/tracking, atomically initialize or reject before state write. |
| Plugin Stop | `hooks/hooks.json` → `scripts/persistent-mode.mjs` | Authorize transcript evidence and advance selected tracking exactly once. |
| Plugin PreToolUse | `hooks/hooks.json` → `scripts/pre-tool-enforcer.mjs` | Remains unchanged for v1 model behavior; its transcript hardening informs Stop authorization. |
| Standalone installed hooks | `src/installer/hooks.ts` installing `templates/hooks/{keyword-detector,pre-tool-use,persistent-mode}.mjs` | Match plugin descriptor, lifecycle, and transition behavior. |
| Library consumers | `src/hooks/autopilot/*`, HUD, and state tools | Preserve matching state semantics and safe public presentation; not the primary installed startup path. |

## Alternatives

### Profiles plus `stageModels`

Rejected for v1. Existing prompts use explicit model selection, and no trusted marker proves that a Task/Agent call was generated by the active workflow rather than arbitrary user or nested work. A default would be inert or could affect unrelated calls.

### Active-stage global model defaults

Rejected. Applying defaults to all matching calls while a stage is active would capture manual, nested, and unrelated work without provenance.

### Dynamic workflow commands or modes

Rejected. Dynamic commands, aliases, modes, filenames, and state identities expand collision, lifecycle, shipping, and cancellation behavior beyond a stage-profile feature.

### General workflow/plugin engine

Rejected. Arbitrary stages, prompts, plugins, branches, loops, DAGs, callbacks, and providers require their own architecture and safety model.

## Why chosen

Closed profile composition provides useful reusable schedules while retaining the fixed adapter set and autopilot's established lifecycle. The four sequences are the only v1 schedules that establish their own required plan and implementation artifacts. The immutable descriptor, authenticated transcript boundary, and compare-before-write transition protect resumes and installed Stop hooks without inventing a new runtime identity.

## Consequences

The first delivery enables named, validated stage schedules but not per-workflow cost tuning, model routing, direct-task profiles, or inline token savings. Plugin and standalone templates are product surfaces and must remain parity-tested. Profile initialization and profile transitions have stricter integrity and evidence requirements than legacy no-profile behavior.

## Migration and compatibility

No migration is required for existing autopilot invocations: without `--workflow`, the legacy no-profile path remains unchanged. Existing `autopilot-state.json` remains the only state identity. Cancel marks the same state inactive while retaining private descriptor/tracking for resume; clear retains existing removal semantics. No workflow-specific cancellation, state file, or HUD identity is added.

## Public-state handling

The on-disk descriptor and transition observations are private. Public state and status previews expose only safe workflow metadata: workflow name, profile version, a 12-hex-character hash prefix plus ellipsis, stages, current stage, and status/progress. HUD renders a bounded validated name and `stage:<id> i/n`; descriptor integrity failure renders bounded `workflow:invalid`. Stop reinforcement does not expose task text, descriptor internals, plan/spec paths, transcript paths, offsets, record hashes, or future model values. Legacy autopilot output remains compatible.

## Governance

After explicit execution approval and before product-code mutation, an authenticated issue #3487 update must be posted with the exact footer:

```text
—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
```

A fetched, durable GJC receipt must bind repository, issue, actor, comment ID/URL, timestamp, exact body SHA-256, normative plan path and SHA-256, command statuses, and verification result. The adjacent parser mismatch is tracked separately and is not bundled.

## Follow-ups and explicit deferrals

The following are outside v1: `stageModels`, all model/provider/role routing and precedence changes, trusted workflow-spawn provenance, model-less profile rendering, inline/no-spawn execution, direct main-session execution, dynamic commands/modes/state files, arbitrary stages/prompts/plugins, custom retries, callbacks, branches, loops, DAGs, and environment profile definitions.

The inline-array custom-skill frontmatter parser mismatch is a separate issue. Future work may propose trusted spawn provenance and scoped model routing, true inline execution semantics, or workflow-only direct-task inputs, each with a dedicated design and verification plan.
