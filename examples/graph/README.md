# Graph-Ralph Example: Auth Feature

This example demonstrates the graph+ralph integration: **graph defines the structure, ralph executes each node.**

## The Graph

```
explore -> plan -> implement -> test
                      ↑           |
                      └─── fix ──┘
                      ↓
                   retry (max 3)
```

## Nodes (4 agent nodes, each executed by ralph)

| Node | Title | Ralph's Job |
|------|-------|-------------|
| explore | Codebase Exploration | PRD: map architecture, find patterns, document tech stack |
| plan | Implementation Plan | PRD: design routes, middleware, token strategy, schema |
| implement | Implementation | PRD: create endpoints, JWT middleware, schema migration |
| test | Test & Verify | PRD: integration tests for all auth flows, run suite |

## Edges (5)

| Edge | Type | Purpose |
|------|------|---------|
| explore -> plan | fixed | Sequential |
| plan -> implement | fixed | Sequential |
| implement -> test | conditional (done) | Happy path |
| implement -> implement | back_edge (retry, max 3) | Retry on failure |
| test -> implement | conditional (fix) | Tests found issues |

## How to Run

```bash
# 1. Load the descriptor
/graph examples/graph/auth-feature-descriptor.json

# Or describe the goal directly
/graph "Add user authentication to the API with login, register, and token refresh"
```

## What Happens

1. **Phase 1 (Graph Engineering)**: The descriptor is loaded, validated, and presented for human approval. The SHA-256 hash is computed and sealed.

2. **Phase 2 (Loop Engineering)**: The driver loop begins:
   - Claims `explore` node -> ralph executes it (PRD -> stories -> verify -> reviewer -> done)
   - Commits result, advances to `plan`
   - Ralph executes `plan` node
   - Commits, advances to `implement`
   - Ralph executes `implement` (with retry back-edge if needed)
   - On success, advances to `test`
   - Ralph executes `test` (terminal verification)
   - If tests fail, conditional edge `fix` routes back to `implement`
   - When `test` succeeds with evidence, graph is complete

## Key Integration Points

- **Graph descriptor** defines the DAG structure (what runs, in what order)
- **Ralph** provides persistence per node (PRD, stories, verification, reviewer)
- **Back-edge** with `max_traversals: 3` bounds retries
- **Terminal verification** requires fresh evidence (test results)