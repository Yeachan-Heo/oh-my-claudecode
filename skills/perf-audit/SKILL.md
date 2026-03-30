---
name: perf-audit
description: Performance profiling workflow - bottleneck detection, benchmark regression, bundle analysis, and optimization recommendations
level: 3
aliases: [perf, performance, benchmark, profile]
argument-hint: [audit|bundle|benchmark|query] - default is audit
---

# Performance Audit Skill

Systematic performance analysis for your codebase. Detects bottlenecks, analyzes bundle sizes, runs benchmarks, profiles database queries, and provides actionable optimization recommendations.

## Usage

```
/oh-my-claudecode:perf-audit
/oh-my-claudecode:perf-audit bundle
/oh-my-claudecode:perf-audit benchmark
/oh-my-claudecode:perf-audit query
/oh-my-claudecode:perf
```

Or say: "performance audit", "why is it slow", "bundle size too large", "optimize performance", "profile this"

## Modes

| Mode | Focus | Best For |
|------|-------|----------|
| `audit` | Full performance review | Comprehensive analysis |
| `bundle` | Bundle/binary size analysis | Frontend and package size |
| `benchmark` | Run and compare benchmarks | Regression detection |
| `query` | Database query analysis | Slow queries, missing indexes |

## Workflow

### Mode: Audit (default)

#### 1. Detect Performance Context

Identify the performance domain:

```bash
# Check project type and available profiling tools
ls package.json Cargo.toml go.mod pyproject.toml Makefile 2>/dev/null

# Check for existing performance tooling
ls lighthouse.config.* .lighthouserc.* vitest.config.* jest.config.* bench/ benchmarks/ 2>/dev/null
```

Determine focus area:
- **Frontend**: Bundle size, render time, Core Web Vitals, lighthouse scores
- **Backend API**: Response time, throughput, database queries, memory usage
- **CLI/Library**: Startup time, processing speed, memory footprint
- **Full-stack**: Both frontend and backend analysis

#### 2. Static Analysis

Analyze code for performance anti-patterns:

**JavaScript/TypeScript:**
- `O(n²)` nested loops over large collections
- Missing `useMemo`/`useCallback` in render-heavy React components
- Synchronous operations that could be async
- Unbounded `Promise.all` without concurrency limits
- Large imports that could be lazy-loaded or tree-shaken
- Missing `key` props in list renders
- Re-renders caused by object/array literals in JSX props

**Python:**
- `O(n²)` patterns: nested loops, repeated list scans
- Missing generators for large data iteration
- Synchronous I/O in async contexts
- N+1 query patterns in ORM usage
- Missing `__slots__` on data-heavy classes

**Go:**
- Excessive allocations in hot paths
- Missing `sync.Pool` for frequently allocated objects
- Unbuffered channels causing goroutine blocking
- `defer` in tight loops
- String concatenation in loops (use `strings.Builder`)

**Rust:**
- Unnecessary `.clone()` calls
- Missing `#[inline]` on small hot-path functions
- Excessive allocations (`Vec::new()` in loops)
- Missing `capacity` hints for known-size collections

**General:**
- N+1 database queries (ORM patterns)
- Missing database indexes for frequent query patterns
- Uncompressed API responses
- Missing caching for repeated expensive operations
- Sequential operations that could be parallelized

#### 3. Runtime Profiling Recommendations

Based on the stack, recommend appropriate profiling:

```
[PERF AUDIT] Profiling Recommendations
═══════════════════════════════════════════

For this {stack_type} project, run these profiling tools:

Frontend:
  → npx lighthouse {url} --output=json --output-path=lighthouse.json
  → npx bundlemon (or webpack-bundle-analyzer)
  → Chrome DevTools Performance tab → Record → Analyze flame chart

Backend (Node.js):
  → node --prof app.js → node --prof-process isolate-*.log
  → clinic doctor -- node app.js
  → autocannon -c 100 -d 10 {url}

Python:
  → python -m cProfile -o profile.out app.py → snakeviz profile.out
  → py-spy top -- python app.py

Go:
  → go test -bench=. -benchmem -cpuprofile=cpu.prof
  → go tool pprof cpu.prof

Rust:
  → cargo bench
  → cargo flamegraph
```

#### 4. Generate Audit Report

```
[PERF AUDIT] Performance Report
═══════════════════════════════════════════

Performance Health Score: {score}/100

┌──────────────────────────────────────────┐
│ FINDINGS                                  │
├──────────┬───────────────────────────────┤
│ Critical │ {n} - Fix immediately          │
│ High     │ {n} - Fix this sprint          │
│ Medium   │ {n} - Plan for next cycle      │
│ Low      │ {n} - Nice to have             │
└──────────┴───────────────────────────────┘

Top Findings:

1. [CRITICAL] {finding}
   Location: {file}:{line}
   Impact: {estimated_impact}
   Fix: {recommendation}

2. [HIGH] {finding}
   Location: {file}:{line}
   Impact: {estimated_impact}
   Fix: {recommendation}

Optimization Priority (Impact vs Effort):
  ┌────────────────────────────────┐
  │ High Impact, Low Effort: DO    │
  │  → {item_1}                    │
  │  → {item_2}                    │
  │                                │
  │ High Impact, High Effort: PLAN │
  │  → {item_3}                    │
  │                                │
  │ Low Impact, Low Effort: MAYBE  │
  │  → {item_4}                    │
  └────────────────────────────────┘
```

### Mode: Bundle

Analyze JavaScript/frontend bundle sizes:

```bash
# Build with analysis
npm run build 2>&1 | tail -30

# Check bundle size if available
npx size-limit 2>/dev/null
du -sh dist/ build/ .next/ out/ 2>/dev/null
```

Analyze:
- Total bundle size (gzipped and uncompressed)
- Largest chunks/modules
- Tree-shaking effectiveness
- Duplicate dependencies
- Dynamic import opportunities

### Mode: Benchmark

Run or create benchmarks:

```bash
# Node.js
npx vitest bench 2>/dev/null || npm run bench 2>/dev/null

# Go
go test -bench=. -benchmem ./... 2>/dev/null

# Rust
cargo bench 2>/dev/null

# Python
python -m pytest --benchmark-only 2>/dev/null
```

If no benchmarks exist, offer to create them for the most performance-critical paths.

Compare results against previous runs if available.

### Mode: Query

Database query performance analysis:

- Identify ORM query patterns in the codebase
- Check for N+1 queries
- Analyze schema for missing indexes
- Review query complexity
- Check connection pooling configuration

## Agent Delegation

For deep code-level performance analysis:

```
Task(subagent_type="oh-my-claudecode:architect", model="opus", prompt="PERFORMANCE ANALYSIS:
Analyze these files for performance issues: {files}
Focus on: algorithmic complexity, memory allocation patterns, I/O efficiency, caching opportunities.
Rate each finding by estimated impact (high/medium/low) and effort to fix.")
```

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Audit complete** | Display report with prioritized findings |
| **Bundle analyzed** | Display size breakdown and optimization opportunities |
| **Benchmark complete** | Display results with comparison to baseline |
| **Query analyzed** | Display slow queries and index recommendations |
| **No performance issues** | Display clean report with current metrics |

## Notes

- **Non-destructive**: Analysis only — never modifies code without confirmation.
- **Tool-dependent**: Some analyses require tools to be installed (lighthouse, clinic, py-spy, etc.). The skill will note when tools are missing.
- **Baseline comparison**: For benchmark mode, save results to `.perf-baseline.json` for future comparison.
- **Complement to /trace**: Use `/trace` for runtime debugging of specific slow operations. Use `/perf-audit` for systematic codebase-wide analysis.
- **Profile in production-like conditions**: Profiling dev builds may show different characteristics than production.

---

Begin performance audit now. Parse the mode argument and detect the project stack.
