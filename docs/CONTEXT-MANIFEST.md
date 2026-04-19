<!-- OMC:VERSION:4.15.0 -->
# Context Manifest Standard

**Introduced:** v4.15.0
**Scope:** Convention for NEW agents; OPTIONAL for existing agents (no forced retrofit).

## Problem

Agents in OMC read from and write to `.omc/**` directories. As the framework grows, several structural problems accumulate:

1. **Context-loading explosion.** Each agent reads N directories; with 30+ agents, each invocation loads a growing fraction of `.omc/` into context even when most of it is irrelevant.
2. **Circular dependencies.** Agent A reads B's outputs; B reads A's alerts; undetected cycles cause infinite or confused workflows.
3. **Artifact lifecycle opacity.** Hundreds of dated files accumulate; which is canonical? Which is superseded? Which is abandoned?
4. **Handoff prose, not executable.** Each agent says "hand off to X" in documentation; nothing enforces it.

This standard addresses problems 1–3 by formalizing the declarations agents make about their IO. Problem 4 is addressed by a separate handoff-orchestration mechanism (future work).

## Non-Goal

This standard does NOT require retrofitting existing agents. Existing agents work as-is; the standard applies to:
- New agents created after v4.15.0.
- Existing agents when they are substantively modified for other reasons (opportunistic adoption).
- Agents authored by contributors who want the runtime-filtering benefits.

## The Manifest

Agents declare three sections in their frontmatter (YAML):

### `reads:` — declares context dependencies

Each entry has:
- `path:` — literal path OR glob pattern under `.omc/**`.
- `required:` — `true | false`. If `true`, agent HALTs when absent.
- `use:` — one-line purpose.

Example:
```yaml
reads:
  - path: ".omc/constitution.md"
    required: true
    use: "Anti-goal gating, target-user context"
  - path: ".omc/competitors/**/*.md"
    required: false
    use: "Competitive whitespace for archetype selection"
  - path: ".omc/research/**/*.md"
    required: false
    use: "User language and cultural references"
```

Guidelines:
- Prefer `required: false` over `required: true` unless the agent genuinely cannot produce useful output without the file.
- Cite the reason for each read (`use:`) so future readers understand the dependency.
- Use glob patterns for directory-level reads (`.omc/competitors/**/*.md`) to keep declarations terse.

### `writes:` — declares output paths and lifecycle semantics

Each entry has:
- `path:` — literal path OR glob under `.omc/**`. Use `{slug}` / `{date}` placeholders for dynamic paths.
- `status_field:` — enum of possible status values in the artifact's frontmatter. Empty if artifact has no status field.
- `supersession:` — `on-rewrite` | `append-only` | `none` | custom-rule-string.

Example:
```yaml
writes:
  - path: ".omc/brand/core.md"
    status_field: "draft | partial | complete"
    supersession: "on-rewrite, prior version moved to .omc/brand/archive/core-YYYY-MM-DD.md"
  - path: ".omc/brand/expressions/YYYY-MM-DD-{slug}/variation-{N}.md"
    status_field: "draft | proposed | approved | rejected"
    supersession: "new files per round; prior rounds retained for diffing"
```

Guidelines:
- Every write path SHOULD declare `status_field:` even if the artifact is simple (`active`).
- Supersession rule must be explicit — no silent overwrite behavior.
- If an artifact is never superseded (e.g., historical session records), declare `supersession: append-only` or `supersession: none`.

### (Optional) `depends_on:` — explicit handoff preconditions

When a downstream agent depends on a specific upstream agent's output, declare it:

```yaml
depends_on:
  - agent: "brand-architect"
    produces: ".omc/brand/core.md"
    ensures: "status: complete OR partial"
```

This enables future runtime handoff-orchestration to validate preconditions before invocation. Currently documentary.

## Status-Field Convention

When `status_field:` is declared, artifact frontmatter should include a `status:` key with one of the declared values.

Canonical status values (non-exhaustive):

| Status | Meaning |
|---|---|
| `draft` | Work in progress; not ready to consume |
| `partial` | Consumable but with known gaps |
| `complete` | Fully specified; ready to consume |
| `active` | Currently authoritative |
| `superseded` | Replaced by a newer version (with `superseded_by:` pointer) |
| `archived` | Historical; not for current consumption |
| `proposed` | Awaiting review/approval |
| `approved` | Passed review; ready for downstream use |
| `rejected` | Reviewed and not accepted |

Agents can declare custom status values in their `writes:` block when none of these fit.

## Supersession Protocol

When an agent rewrites a previously-written artifact:

1. **Do not edit in place.** Create a new file with current date.
2. **Move prior version to `archive/` subdirectory** of the parent. Example: `.omc/brand/core.md` → `.omc/brand/archive/core-2026-04-19.md`.
3. **Update frontmatter** of moved file: add `superseded_by: <new-path>` and set `status: superseded`.
4. **Update new file's frontmatter**: add `supersedes: <archive-path>` for traceability.

This convention is what `artifact-lifecycle` skill consumes for classification.

## Reading the Manifest at Runtime

**Currently:** The manifest is documentary. Agents still read whatever their Investigation_Protocol says to read. The manifest is for tooling (like `artifact-lifecycle`) and for future runtime filtering.

**Future:** A runtime could use `reads:` declarations to filter context passed to the agent, reducing token cost and implicit coupling. Declaring reads honestly now prepares agents for that optimization without blocking progress.

## Example: Minimal Compliant Agent Frontmatter

```yaml
---
name: example-agent
description: Short description of what this agent does (include model tier in parentheses at end)
model: sonnet
level: 3
disallowedTools: Edit
reads:
  - path: ".omc/constitution.md"
    required: true
    use: "Anti-goal check for outputs"
writes:
  - path: ".omc/example/{slug}.md"
    status_field: "draft | active | superseded"
    supersession: "on-rewrite, prior version to .omc/example/archive/{slug}-YYYY-MM-DD.md"
---
```

Existing frontmatter fields (`name`, `description`, `model`, `level`, `disallowedTools`) are unchanged. The manifest adds three OPTIONAL sections.

## Retrofit Guidance

If you are updating an existing agent for other reasons (bug fix, new protocol, new phase), add the manifest as part of that change. Do NOT open PRs that only add manifest — scoped pull requests that modify agent behavior should be preferred.

When retrofitting, include at minimum:
- `reads:` for any directory/file the Investigation_Protocol explicitly references.
- `writes:` for every path the Constraints section authorizes.
- Skip `depends_on:` if uncertain; it's optional.

## Reference Implementations

Agents introduced in v4.15.0 that follow this standard from the start:
- `agents/brand-architect.md`
- `agents/campaign-composer.md`
- `agents/creative-director.md`

Read these to see the standard applied end-to-end.

## Frequently Asked

**Q: Does this break existing agents?**
A: No. The manifest fields are OPTIONAL. Existing agents continue to work unchanged.

**Q: How do I test that the manifest is valid?**
A: Currently no automated validator. A validator skill may be added later. For now, copy structure from reference implementations.

**Q: What if my agent reads all of `.omc/`?**
A: Declare the most-specific globs you actually use. If the agent genuinely reads everything, declare `- path: ".omc/**"` with a note about the broad scope — this signals a candidate for future refactoring.

**Q: Does `artifact-lifecycle` require this standard?**
A: No. `artifact-lifecycle` uses best-effort metadata from filename dates and frontmatter `updated:` fields. Agents following this standard produce richer signal (explicit `status:` values + `supersession:` rules), but compliance is not a prerequisite.

## Versioning of This Standard

Changes to this document are versioned along with OMC releases. Breaking changes to the manifest shape (if any) will be announced via CHANGELOG and supported via a retrofit window.
