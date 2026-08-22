---
name: wiki
description: LLM Wiki — persistent markdown knowledge base that compounds across sessions (Karpathy model)
triggers: ["wiki", "wiki this", "wiki add", "wiki lint", "wiki query"]
---

# Wiki

Persistent, self-maintained markdown knowledge base for project and session knowledge. Inspired by Karpathy's LLM Wiki concept.

## Operations

### Ingest
Process knowledge into wiki pages. A single ingest can touch multiple pages.

```
wiki_ingest({ title: "Auth Architecture", content: "...", tags: ["auth", "architecture"], category: "architecture" })
```

### Query
Search across all wiki pages by keywords and tags. Returns matching pages with snippets — YOU (the LLM) synthesize answers with citations from the results.

```
wiki_query({ query: "authentication", tags: ["auth"], category: "architecture" })
```

### Lint
Run health checks on the wiki. Detects orphan pages, stale content, broken cross-references, oversized pages, and structural contradictions.

```
wiki_lint()
```

### Quick Add
Add a single page quickly (simpler than ingest).

```
wiki_add({ title: "Page Title", content: "...", tags: ["tag1"], category: "decision" })
```

### List / Read / Delete
```
wiki_list()           # Show all pages (reads index.md)
wiki_read({ page: "auth-architecture" })  # Read specific page
wiki_delete({ page: "outdated-page" })    # Delete a page
```

### Log
View wiki operation history by reading `.omc/wiki/log.md`.

## Categories
Pages are organized by category: `architecture`, `decision`, `pattern`, `debugging`, `environment`, `session-log`

## Storage
- Pages: `.omc/wiki/*.md` (markdown with YAML frontmatter)
- Index: `.omc/wiki/index.md` (auto-maintained catalog)
- Log: `.omc/wiki/log.md` (append-only operation chronicle)

## Cross-References
Use `[[page-name]]` wiki-link syntax to create cross-references between pages.

## Auto-Capture
At session end, significant discoveries are automatically captured as session-log pages. Configure via `wiki.autoCapture` in `.omc-config.json` (default: enabled).

## Hard Constraints
- NO vector embeddings — query uses keyword + tag matching only
- Wiki pages are git-ignored by default (`.omc/wiki/` is project-local)

## Model Routing

- `haiku` — quick lookups, lightweight inspection, narrow docs work
- `sonnet` — standard implementation, debugging, and review
- `opus` — architecture, deep analysis, consensus planning, and high-risk review
- `fable` — Claude Fable 5 (above Opus); pass it explicitly on the Task call or pin it per agent with `agents.<name>.model`
- The session model chosen with `/model` applies to the main loop only. Delegated agents run on their pinned tier unless the Task call passes `model` explicitly or the agent is overridden via `agents.<name>.model`. To run delegated work on Fable, use one of those two surfaces; selecting Fable in `/model` alone does not change delegation.
