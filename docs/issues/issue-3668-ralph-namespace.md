# #3668 — `ralph` vs official `ralph-loop` namespace: evaluation + owner-decision hold

Status: **owner-decision hold** (no rename/removal of bare `ralph`; no release files)
Branch: `fix/issue-3668-ralph-namespace` (dev `656d855ef`)
Date: 2026-08-10
Owner decision required: see **Recommendation**.

## Summary

omc ships the bare skill name `ralph` (`/ralph`). The official Anthropic
`claude-plugins-official` plugin ships the same technique as `ralph-loop`
(`/ralph-loop`). When both plugins are installed, a user typing `/ralph`
gets omc's loop with no indication that a second implementation is installed.
#3668 records this as a namespace/product decision for the owner.

This branch evaluates the options with exact evidence and implements the
cheapest non-breaking mitigation (Option 1: concise invocation-time notice),
leaving the rename (Option 2) as an explicit owner decision.

## Reproduced layout (both plugins installed)

```
~/.claude/plugins/cache/claude-plugins-official/ralph-loop/1.0.0/
  commands/ralph-loop.md        -> /ralph-loop   (official)
~/.claude/plugins/cache/omc/oh-my-claudecode/<version>/skills/ralph/SKILL.md
  name: ralph                   -> /ralph        (omc)
~/.claude/plugins/installed_plugins.json  (machine-readable registry)
  "ralph-loop@claude-plugins-official": [{ installPath, version, enabled }]
  "oh-my-claudecode@omc": [{ installPath, version, enabled }]
```

Before this change, the omc keyword-detector emitted `[MAGIC KEYWORD: RALPH]`
with zero mention of the official plugin.

## What OMC can reliably detect at `/ralph` invocation (no private-payload scan)

Two independent signals, both already-familiar OMC surfaces, mirroring the
installer's `hasEnabledOmcPlugin` semantics (`src/installer/index.ts`):

1. **INSTALLED** — `[$CLAUDE_CONFIG_DIR|~/.claude]/plugins/installed_plugins.json`
   (the file OMC's installer/auto-update already owns for plugin-cache
   bookkeeping) contains the exact official id `ralph-loop@claude-plugins-official`
   and `commands/ralph-loop.md` exists under the entry's `installPath`.
   The registry's own `enabled` flag is **deliberately not consulted**: it does
   not authoritatively encode enablement (a plugin disabled through canonical
   settings can still carry `enabled: true`, and vice versa).
2. **ENABLED** — `[$CLAUDE_CONFIG_DIR|~/.claude]/settings.json` lists the plugin
   in the canonical `enabledPlugins` field (legacy `plugins` field accepted for
   backward compatibility), either as an array of plugin ids or as a map whose
   value is not `false`. Missing, malformed, or field-less settings.json is
   treated as **not enabled**, exactly like the installer.

Never open any SKILL.md / command body / payload — the only file-existence
probe is `existsSync` on `commands/ralph-loop.md`.

Measured cost (invocation-time only, no startup scan): ~0.08 ms median for the
registry read + settings read + existence probes vs ~150-335 ms total hook
invocation. When the official plugin is absent or disabled the added cost is
two `existsSync` probes (~microseconds) and the output is byte-identical to
today.

## Implemented option (G002): non-breaking disambiguation notice

- Files: `scripts/keyword-detector.mjs` and `templates/hooks/keyword-detector.mjs`
  (the two packaged artifacts that are kept in lockstep — see
  `src/installer/__tests__/hook-templates.test.ts`).
- Behavior: only when `ralph` is among the routed skills (single-skill or
  multi-skill routing such as `/ralph ultrawork`) AND the official plugin is
  installed and enabled, the invocation guide gains one line:

  > Note: the official Anthropic \`ralph-loop\` plugin is also installed.
  > \`/ralph\` runs OMC's ralph; use \`/ralph-loop\` for the official plugin.

- Verified matrix (both artifacts, automated regression test A–P3):
  | Case | Outcome |
  |---|---|
  | A. installed + enabled (`enabledPlugins` map) | notice present |
  | A2. `enabledPlugins` as array of ids | notice present |
  | B. official absent from registry (settings enables) | silent (identical output) |
  | C. disabled in settings (`enabledPlugins: false`) | silent — enablement from settings, not registry flag |
  | C2. settings has neither field | silent |
  | D. registry entry, payload missing | silent (no fabrication) |
  | E. lookalike id only (`my-ralph-loop@community`) | silent (settings-side lookalike too) |
  | F. no registry | silent |
  | G. non-ralph skill (autopilot) | silent |
  | H. official `/ralph-loop` command | never routes to OMC, never carries notice |
  | I. `/omc-ralph` alias | routes to OMC ralph with notice |
  | J. registry `enabled: false` + settings enabled | notice present (settings wins) |
  | K. registry `enabled: true` + settings missing | silent (missing settings = not enabled) |
  | L. legacy `plugins` map | notice present |
  | M. malformed settings.json | silent (fail closed) |
  | N. config root via `HOME` (no `CLAUDE_CONFIG_DIR`) | notice present |
  | O. same-named community plugin enabled, official `false` | silent (ids match on the full `name@marketplace` id) |
  | O2. `enabledPlugins` array with only `ralph-loop@community` | silent |
  | O3. bare marketplace-less `ralph-loop` id | silent (not the official id) |
  | O4. canonical `enabledPlugins: false` + legacy `plugins: true` | silent (canonical field wins) |
  | P. multi-skill routing (`/ralph ultrawork`) | notice present (no multi-skill bypass) |
  | P2. multi-skill routing without ralph | silent |
  | P3. multi-skill routing, official disabled | silent |
- `/ralph` routing and the full invocation text are unchanged except the note.
- Suites: `hook-templates.test.ts` 18/18, `keyword-detector-script.test.ts`
  53/53, `skills.test.ts` 53/53, `npm run lint` (0 errors) + `tsc --noEmit` clean.

## Option comparison: notice (implemented) vs rename/alias

| Dimension | Option 1: notice (implemented) | Option 2: rename to `omc-ralph` / alias |
|---|---|---|
| Command surface delta | none | `/ralph` disappears or becomes an alias; every muscle-memory user breaks |
| Keyword activation (`ralph` / 랄프 / ラルフ) | unchanged | must be re-pointed in 3 detector copies (93 `ralph` pattern references in keyword-detector artifacts) |
| Mode/state keys (`mode="ralph"`, `ralph-state.json`) | unchanged | would orphan live session state; cancel skill's `state_read/state_clear(mode="ralph")` cascade breaks without a migration |
| Workflow-slot registry (`CANONICAL_WORKFLOW_SKILLS`, bridge slash list, workflow-stage enum) | unchanged | 14+ command-surface files must change in lockstep |
| `keywordDetector.disabled` config (`["ralph"]`) | unchanged | silently stops matching; user configs break |
| Plugin-cache upgrade | n/a | every version dir is a full payload copy; rename only applies on the *next* cache version, leaving mixed old/new names across stale-cache symlinks until purge |
| Docs surface | none required | 8+ user-facing docs must be rewritten; README command table changes |
| Owner risk | minimal, additive | high: material command-surface change |

Quantified surface for a rename: 246 non-test files reference `ralph`
(14 command-surface files, 24 mode/state-key files, 8 user docs) plus the
`skills/ralph/` directory move and the plugin.json skill entry.

## Recommendation (owner decision)

1. **Adopt Option 1** — the notice is live on this branch, non-breaking,
   and removes the silent substitution for exactly the affected population.
2. **Do not rename/remove bare `ralph`** without an explicit owner decision;
   the rename breaks keyword activation, live session state, cancel cascade,
   workflow slots, user `keywordDetector.disabled` configs, and docs — a
   material command-surface change that this branch must not merge on its own.
3. If the owner later wants Option 2, it should be a separate explicit
   migration (alias first, deprecate over ≥1 release, migrate state keys,
   update 3 detector copies + slots + docs), never a rename-only PR.

## Files changed on this branch

- `scripts/keyword-detector.mjs` — notice helper + ralph wiring
- `templates/hooks/keyword-detector.mjs` — same, lockstep artifact
- `src/installer/__tests__/hook-templates.test.ts` — regression A–G for both artifacts
