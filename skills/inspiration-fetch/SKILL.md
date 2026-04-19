---
name: inspiration-fetch
description: Fetches structured inspiration sources from public URLs (are.na boards, Figma public files, Unsplash collections, Pinterest public boards, GitHub repos, generic web pages) via WebFetch. Produces draft entries for brand-architect --inspiration mode. MCP-independent — fallback pattern that works with any public web source
argument-hint: "<url> [<url> ...] [--axis=<list>]"
level: 4
---

# Inspiration Fetch Skill

Pulls structured inspiration data from public URLs into draft entries for `.omc/brand/inspiration/drafts/`. Designed to bridge the gap between "user has a great are.na board in their head" and "brand-architect has entries in its library".

Uses WebFetch (not MCP dependency) — resilient to community-MCP churn. If the user has installed a domain-specific MCP (e.g., Figma's official MCP), the skill prefers it when available, with graceful fallback.

## Usage

```
/oh-my-claudecode:inspiration-fetch "https://www.are.na/<user>/<board-slug>"
/inspiration-fetch "https://www.figma.com/community/file/<id>/<slug>"
/inspiration-fetch "https://unsplash.com/collections/<id>/<slug>"
/inspiration-fetch url1 url2 url3                         # multi-URL batch
/inspiration-fetch <url> --axis=visual,structural         # hint axis tags
```

### Examples

```
/inspiration-fetch "https://www.are.na/john-doe/knitting-as-craft-resistance"
/inspiration-fetch "https://www.figma.com/community/file/abc123/monochrome-editorial"
/inspiration-fetch "https://unsplash.com/@photographer/likes"
/inspiration-fetch https://are.na/xyz https://figma.com/abc --axis=visual
```

### Flags

- `--axis=<list>` — hint axis tags (visual, verbal, structural, atmospheric, narrative). Multiple allowed.
- `--merge-into-library` — after fetch, auto-invoke `/brand-architect --inspiration` to merge drafts into `.omc/brand/inspiration.md`.
- `--dry-run` — fetch and parse but don't write drafts; report what would be created.
- `--prefer-mcp` — try MCP servers first (Figma MCP for figma.com URLs, etc.) before WebFetch fallback.

<Purpose>
Lowers friction for seeding the brand inspiration library. User provides URLs of source material (moodboards, collections, design files, repos, articles) — skill fetches public metadata, structures it as inspiration source drafts with axis tagging, `extracted_quality` candidates, and `what_NOT_to_copy` templates that the user and brand-architect then refine.
</Purpose>

<Supported_Sources>

| Source | Method | Extracted |
|---|---|---|
| **are.na** public boards | WebFetch on board URL; parse HTML for block metadata | Blocks: title, description, source_url, image thumbnails, referenced blocks. Default axis: visual if image-heavy, verbal if text-heavy |
| **Figma** community files | WebFetch on file URL; optional Figma MCP if installed | File title, description, creator, tags, preview. Default axis: visual, structural |
| **Unsplash** collections | WebFetch on collection URL; parse photo metadata | Photo count, photographer tags, color palette inferred. Default axis: visual, atmospheric |
| **Pinterest** public boards | WebFetch on board URL | Pin titles, descriptions, source URLs. Default axis: visual |
| **GitHub** repos (design-system / style-guide / zine-like) | WebFetch on repo README | Repo title, description, README summary, license. Default axis: structural |
| **Generic web pages** (blog posts, essays, Colossal, It's Nice That articles) | WebFetch on URL | Title, description, key quotes (≤3), images referenced. Axis: depends on content type — user hint via `--axis` helpful |
| **Are.na channels (private)** | Requires are.na API token in env; if absent, skill reports "private channel — make public or provide ARENA_TOKEN" |

</Supported_Sources>

<Protocol>

## Phase 0 — Input Parsing

Accept 1 or more URL arguments. Validate each is a well-formed URL. Batch invalid URLs into a warnings section; proceed with valid ones.

For each URL, detect source type by domain (are.na, figma.com, unsplash.com, pinterest.com, github.com) or fall back to generic.

## Phase 1 — MCP Preference (if --prefer-mcp)

For each URL:
- figma.com → check if Figma MCP is registered in `.mcp.json`; prefer if yes.
- For others → WebFetch (no MCP fallback by default).

MCP availability is checked via OMC runtime (`state_read` for MCP registry). If MCP configured but not responsive, fall back to WebFetch with a note.

## Phase 2 — Fetch Content

For each URL:
1. WebFetch with prompt: "Extract the main content of this page suitable for inspiration library entry: title, description, creator/author, sample of key items (blocks/images/pins/etc.), any tags. Return as structured markdown."
2. Normalize response into:
   ```yaml
   source_url: <url>
   source_type: arena | figma | unsplash | pinterest | github | generic
   title: <extracted>
   description: <extracted, ≤100 words>
   creator: <author/owner if detectable>
   sample_items: [<list of 3-5 representative entries>]
   tags: <from source if present>
   ```

If fetch fails (403, 404, timeout) — log the URL in the failures section and continue with others.

## Phase 3 — Axis Inference and Enrichment

For each successfully fetched source:
- If `--axis` flag provided, use that list.
- Else infer axis from content:
  - Predominantly images → `visual`
  - Predominantly text / essays / poems → `verbal`
  - Design systems / structural patterns / architecture → `structural`
  - Mood / atmosphere / photography → `atmospheric`
  - Storytelling / narrative forms → `narrative`
- One source can have multiple axes.

Propose candidate `extracted_quality` fields based on content:
- `visual` axis → "compositional <X>", "color <Y>", "texture <Z>"
- `verbal` → "cadence of <X>", "restraint in <Y>", "register shift in <Z>"
- `structural` → "the <X> pattern of <Y>"
- `atmospheric` → "the <mood> of <situation>"
- `narrative` → "the <narrative-form> embodying <idea>"

These candidates are drafts — user and brand-architect refine in next step. Goal is to give the library population a starting structure, not to make final decisions.

Propose candidate `what_NOT_to_copy` based on the source's distinctive signature moves (e.g., a specific logo-treatment, a named photographic filter, a well-known phrase). These are anti-plagiarism boundaries.

## Phase 4 — Write Drafts

For each source, write `.omc/brand/inspiration/drafts/YYYY-MM-DD-<slug>.md`:

```markdown
---
source_type: <arena | figma | ...>
source_url: <url>
fetched_at: YYYY-MM-DD
status: draft
axis_candidates: [<inferred list>]
---

# Inspiration Draft: <title>

**Source URL:** <url>
**Fetched:** YYYY-MM-DD
**Source type:** <type>
**Creator/Author:** <if detected>

## Description
<fetched description>

## Sample Items
<3-5 representative entries from the source>

## Axis Candidates
- <axis1>: <rationale>
- <axis2>: <rationale>

## Why it might inspire (candidate)
<1-2 sentences — user/brand-architect refines>

## What to extract (candidate)
<specific extractable quality — user/brand-architect refines>

## What NOT to copy (candidate)
<anti-plagiarism boundary — user/brand-architect refines>

## User notes
<blank — for user to annotate before merging>
```

## Phase 5 — Handoff

Terminal summary:
```
Fetched: N sources (M failures)
Drafts written to: .omc/brand/inspiration/drafts/
Failed URLs:
- <url>: <reason>

Next step:
- Review drafts at .omc/brand/inspiration/drafts/
- Edit the "candidate" fields (axis, extracted_quality, what_NOT_to_copy, user notes)
- Run /brand-architect --inspiration to merge approved drafts into the main library
```

If `--merge-into-library` flag was set, auto-invoke brand-architect skill with directive to merge drafts.

</Protocol>

<Input_Contract>
1+ positional URL arguments (required).

Flags:
- `--axis=<list>` — comma-separated axis hints.
- `--merge-into-library` — auto-merge into brand-architect library after fetch.
- `--dry-run` — fetch and parse but don't write drafts.
- `--prefer-mcp` — try MCPs first for known source types.
</Input_Contract>

<Output>
- `.omc/brand/inspiration/drafts/YYYY-MM-DD-<slug>.md` — one per successfully-fetched source.
- Terminal summary with fetch results and next-step recommendation.
</Output>

<Failure_Modes_To_Avoid>
- **Fabricating content when WebFetch fails.** If fetch returns 403/404/timeout, log the failure and skip — do NOT invent content based on URL guesses.
- **Writing `extracted_quality` as final instead of candidate.** Fields are DRAFTS for user and brand-architect refinement. Label accordingly so downstream doesn't treat them as authoritative.
- **Axis inference without user signal.** Inferred axis is a candidate; user can override. Don't over-commit in the draft.
- **Auto-merging into library without user review.** Unless `--merge-into-library` is explicit, drafts stay in `drafts/` — user reviews before promotion.
- **Fetching private URLs without auth.** Are.na private channels, Figma private files, Pinterest private boards — report clearly to user; don't hang or silently fail.
- **Saving fetched images or large media locally.** Skill only saves metadata + URLs. Source-fetching is upstream's job (designer pulls assets when implementing).
- **Overloading a single user's input.** If user provides 20 URLs, fetch in parallel up to concurrency limit (default 5); report progress; don't block terminal.
- **Ignoring rate limits.** Unsplash, Figma, GitHub have rate limits; WebFetch may hit them in a large batch. Surface rate-limit errors distinctly from 404s.
</Failure_Modes_To_Avoid>

<Integration_Notes>
- Writes exclusively to `.omc/brand/inspiration/drafts/`; does not touch `.omc/brand/inspiration.md` directly.
- Feeds `brand-architect --inspiration` mode — user reviews drafts, runs brand-architect, drafts get merged into main library.
- Uses `WebFetch` and/or `mcp__linkup__linkup-fetch` as available. No community-MCP hard dependency.
- For Figma: if the official Figma MCP is installed (user-side) and `--prefer-mcp` is passed, uses that for richer extraction.
- For are.na: if `ARENA_TOKEN` env variable is set (OAuth-style personal access token from are.na), skill uses the are.na REST API for richer extraction (blocks with full metadata, connections graph). Otherwise WebFetch HTML-parsing.
- Does NOT create binary assets locally — only URLs + metadata. Asset retrieval at production time is designer's responsibility.
- Compatible with `/oh-my-claudecode:loop` for periodic re-fetch of curated are.na boards (the boards grow; skill can re-fetch monthly to pick up new entries — though tracking new vs existing requires manual review to avoid duplicates).
</Integration_Notes>
