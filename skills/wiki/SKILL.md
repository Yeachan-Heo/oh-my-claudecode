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
Pages are organized by 7 orthogonal categories — each answers a different question:

| Category | Question | Examples |
|----------|----------|---------|
| `architecture` | What IS the system? | Component design, data models, module boundaries |
| `decision` | WHY was it built this way? | ADRs, tradeoffs, rejected alternatives |
| `guide` | HOW do you work with it? | Patterns, conventions, coding standards, workflows |
| `setup` | HOW do you run/configure it? | Environment, dependencies, onboarding |
| `finding` | WHAT was learned empirically? | Bugs, gotchas, experiments, perf observations |
| `reference` | WHERE is external knowledge? | Third-party docs, specs, links |
| `log` | WHAT happened? (auto) | Session logs, incident records |

## Storage
- Pages: `.omc/wiki/*.md` (markdown with YAML frontmatter)
- Index: `.omc/wiki/index.md` (auto-maintained catalog)
- Log: `.omc/wiki/log.md` (append-only operation chronicle)

## Cross-References
Use `[[page-name]]` wiki-link syntax to create cross-references between pages.

## Auto-Capture
At session end, significant discoveries are automatically captured as `log` category pages. Configure via `wiki.autoCapture` in `.omc-config.json` (default: enabled).

## Hard Constraints
- NO vector embeddings — query uses keyword + tag matching only
- Wiki pages are git-ignored by default (`.omc/wiki/` is project-local)
