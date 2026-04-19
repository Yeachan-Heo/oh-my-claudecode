---
name: digest-maintain
description: Generates and maintains .omc/digests/ — short-form summaries of constitution, competitors landscape, research highlights, brand core. Agents read the digest (~300 tokens) instead of the full file (~3K tokens), cutting repeat-read token cost by ~90%
argument-hint: "[--regenerate-all | --watch=<path> | --status]"
level: 4
---

# Digest Maintain Skill

Framework efficiency utility. Produces condensed digests of frequently-read `.omc/` artifacts so agents consume ~300 tokens per artifact instead of ~3K+. Reduces context-loading cost by ~90% for commonly-referenced foundational artifacts.

Can run manually (full regeneration) or via PostToolUse hook (incremental — regenerates only the digest for the watched file that was just written).

## Usage

```
/oh-my-claudecode:digest-maintain                        # default: regenerate any stale digests
/digest-maintain --regenerate-all                         # rebuild all digests from scratch
/digest-maintain --watch=.omc/constitution.md             # regen a specific digest (hook-triggered form)
/digest-maintain --status                                 # report digest health without modifying
```

### Examples

```
/digest-maintain                                          # smart-refresh — only regenerate stale digests
/digest-maintain --regenerate-all                         # full rebuild (after major constitution or competitor shift)
/digest-maintain --watch=.omc/brand/core.md               # triggered by hook after brand-architect writes
/digest-maintain --status                                 # audit — which digests exist, freshness, size
```

<Purpose>
Generates and maintains a cache of short-form digests for foundational artifacts. Agents read digests by default; agents fall back to full artifacts only when they need specifics (e.g., verbatim anti-goal quotes). Saves ~90% of tokens on repeat reads across agents in a session and across sessions over time.
</Purpose>

<Watched_Artifacts>

Maintained digests by default:

| Digest | Source artifacts | Target size | Refresh trigger |
|---|---|---|---|
| `.omc/digests/constitution.md` | `.omc/constitution.md` | ≤300 tokens | PostToolUse on write to constitution |
| `.omc/digests/competitors-landscape.md` | `.omc/competitors/landscape/*.md` (latest) + watchlist | ≤500 tokens | PostToolUse on write to competitors/** |
| `.omc/digests/research-highlights.md` | `.omc/research/**/*.md` (top convergent findings) | ≤500 tokens | PostToolUse on write to research/** |
| `.omc/digests/brand-core.md` | `.omc/brand/core.md` + `.omc/brand/grammar.md` | ≤400 tokens | PostToolUse on write to brand/** |
| `.omc/digests/ideas-shortlist.md` | `.omc/ideas/*.md` (latest shortlist) | ≤400 tokens | PostToolUse on write to ideas/** |
| `.omc/digests/classification.md` | `.omc/classification/features-core-context.md` | ≤200 tokens | PostToolUse on write |

Digest size targets are rough; actual output may be 20–30% over if essential information demands it. The goal is ~10× reduction vs full file.

</Watched_Artifacts>

<Protocol>

## Phase 0 — Mode Detection

- `--watch=<path>` → single-digest refresh mode. Regenerate the digest whose source matches `<path>`.
- `--regenerate-all` → full rebuild.
- `--status` → report mode; no writes.
- Default (no flag) → stale detection: regenerate any digest whose source has been modified since the digest was last written.

## Phase 1 — Stale Detection

For each watched artifact:
1. Check if source exists.
2. Check if digest exists at target path.
3. Compare mtimes:
   - Source mtime > digest mtime → stale; queue for regeneration.
   - Digest missing → queue for initial generation.
4. Also check content hash if available (prevents unnecessary regen when source touched but not changed).

## Phase 2 — Regeneration

For each digest to regenerate, apply the digest-specific protocol below.

### Constitution digest

Source: `.omc/constitution.md`. Output: `.omc/digests/constitution.md`.

Extract:
- Target user (1 sentence, verbatim if possible)
- Mission (1 sentence, verbatim if possible)
- Top 3 principles (bullet, ≤10 words each)
- ALL anti-goals (verbatim — these are load-bearing for product-strategist; cannot be paraphrased)
- Scope boundaries (1 line summary)
- Voice-of-tone hints (1 line)
- `status` field of constitution

Format:
```markdown
---
digest_of: ".omc/constitution.md"
source_mtime: <source mtime>
digest_mtime: <now>
status: <from source>
---

# Constitution Digest

**Target user:** <verbatim>
**Mission:** <verbatim>

## Principles (ordered)
1. ...
2. ...
3. ...

## Anti-goals (verbatim — do not paraphrase)
- ...
- ...

## Scope
<1-line summary>

## Tone of voice
<1-line summary>

---
**Agents consuming this digest:** product-strategist (anti-goal gating), ideate (Problem Contract), brand-architect (archetype rationale), creative-director (invariant cross-check). For verbatim reading of full constitution, consume `.omc/constitution.md` directly.
```

### Competitors landscape digest

Source: `.omc/competitors/landscape/<latest>.md` + `.omc/competitors/watchlist.md`. Output: `.omc/digests/competitors-landscape.md`.

Extract:
- Top 5 competitors by threat_score (from watchlist, recency-first)
- Archetype map (competitor → inferred archetype)
- JTBD coverage heatmap summary (who covers which job)
- White space (jobs no competitor addresses)
- Recent alerts (last 14 days, max 5)

Format:
```markdown
---
digest_of: ".omc/competitors/landscape/<latest>.md, watchlist.md"
source_mtime: <max mtime across sources>
digest_mtime: <now>
---

# Competitors Landscape Digest

## Top 5 by threat_score (recency-first)
| slug | recency | threat | archetype |
|---|---|---|---|

## Archetype map
- <competitor>: <archetype> (evidence: <1 line>)

## JTBD coverage
- <job>: covered by [<competitors>]
- White space: <job>

## Recent alerts (last 14d)
- <date> | <slug> | <event>

---
**Full detail at:** `.omc/competitors/landscape/`, `.omc/competitors/watchlist.md`, `.omc/competitors/alerts/`
```

### Research highlights digest

Source: `.omc/research/**/*.md`. Output: `.omc/digests/research-highlights.md`.

Extract:
- Top 5 convergent findings (flagged in ≥2 research artifacts)
- Top 3 user verbatim quotes (most load-bearing)
- Outcome-importance-satisfaction ranking (if ODI data available)
- Open research questions (top 3)

### Brand core digest

Source: `.omc/brand/core.md` + `.omc/brand/grammar.md`. Output: `.omc/digests/brand-core.md`.

Extract:
- Archetype (primary + secondary if any)
- Core metaphor (1 sentence)
- Top 3 narrative invariants
- Voice ladder summary (4 axes, primary positions)
- Grammar invariants count + variables count
- Anti-template forbidden_patterns top 10 (critical — composer needs these)

### Ideas shortlist digest

Source: `.omc/ideas/*.md` (most recent). Extract shortlist with score vectors (not full prose).

### Classification digest

Source: `.omc/classification/features-core-context.md`. Extract slug → class mapping table.

## Phase 3 — Validation

After write, verify:
- Digest size is within target bounds (warn if >150% of target).
- Required sections are present.
- Frontmatter is valid.

## Phase 4 — Report

Emit terminal summary:
```
Digests updated: <n>
Digests skipped (fresh): <n>
Digests failed: <n>

Size summary:
- constitution.md: 287 tokens (target 300) — ok
- competitors-landscape.md: 612 tokens (target 500) — warn
...
```

</Protocol>

<Hook_Configuration>

To enable auto-refresh, add to OMC hooks config (see `hooks/hooks.json`):

```json
{
  "PostToolUse": [
    {
      "matcher": "Write|Edit",
      "hooks": [
        {
          "type": "command",
          "command": "node $CLAUDE_PLUGIN_ROOT/scripts/digest-hook.mjs",
          "timeout": 10,
          "conditions": {
            "path_matches": [
              ".omc/constitution.md",
              ".omc/competitors/**",
              ".omc/research/**",
              ".omc/brand/core.md",
              ".omc/brand/grammar.md",
              ".omc/ideas/*.md",
              ".omc/classification/*.md"
            ]
          }
        }
      ]
    }
  ]
}
```

The hook script (`scripts/digest-hook.mjs`) receives the written path and invokes `/digest-maintain --watch=<path>` via OMC's internal skill dispatch.

Hook installation is optional — users can run `/digest-maintain` manually if they prefer not to enable automated hooks.

</Hook_Configuration>

<Input_Contract>
Flags:
- `--regenerate-all` — full rebuild, regenerate every digest.
- `--watch=<path>` — single-digest refresh for the digest whose source matches the path.
- `--status` — report only, no writes.

Default (no flag): stale detection + regenerate-if-stale.
</Input_Contract>

<Output>
- Digest files under `.omc/digests/` with per-digest frontmatter tracking source mtime.
- Terminal summary of refresh results.
</Output>

<Failure_Modes_To_Avoid>
- **Writing digest where essential information is paraphrased.** Anti-goals in particular are VERBATIM-only — paraphrasing them breaks product-strategist's gating. Same for mission statement and core metaphor.
- **Digest size exceeding 2× target.** If essential content doesn't fit, raise the target or split the digest — don't truncate arbitrarily.
- **Regenerating without checking staleness.** Waste of cycles; stale detection via mtime is the default.
- **Silent failures on malformed sources.** If `.omc/constitution.md` is malformed, the digest step reports the malformation; doesn't produce a broken digest.
- **Hook spinning on writes to digest itself.** The hook must exclude `.omc/digests/**` from its path_matches (only the sources trigger; the digest writes do not).
- **Treating digest as authoritative.** Agents that need verbatim content or full section depth MUST read the source, not the digest. Digest is a cost-saver, not a substitute.
</Failure_Modes_To_Avoid>

<Integration_Notes>
- Agents following the Context-Manifest standard can declare `reads:` entries pointing to digest paths by default (runtime filter passes the digest instead of the full file).
- Users who don't enable hooks can run `/digest-maintain` manually as needed; also pairs with `/loop 24h /digest-maintain` for daily refresh.
- Does NOT retroactively modify existing agents to read digests — that's per-agent opt-in. New agents in v4.16+ should reference digest paths where appropriate in their `reads:` frontmatter.
- Compatible with `artifact-lifecycle` — digests for archived sources are archived together; the lifecycle skill respects the `digest_of:` frontmatter field.
</Integration_Notes>
