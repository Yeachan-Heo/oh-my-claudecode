---
name: ci-pipeline
description: Generate, debug, and optimize CI/CD pipelines (GitHub Actions, GitLab CI, CircleCI) from project context
level: 3
aliases: [ci, cd, pipeline, github-actions]
argument-hint: [generate|debug|optimize|status] - default is generate
---

# CI Pipeline Skill

Generate production-ready CI/CD workflows, debug failing pipelines, and optimize build times from your project context.

## Usage

```
/oh-my-claudecode:ci-pipeline
/oh-my-claudecode:ci-pipeline generate
/oh-my-claudecode:ci-pipeline debug
/oh-my-claudecode:ci-pipeline optimize
/oh-my-claudecode:ci
```

Or say: "create CI workflow", "fix GitHub Actions", "debug pipeline", "CI is failing", "add deployment pipeline"

## Workflow

### Mode: Generate (default)

#### 1. Detect Project Stack

Scan the repository to identify:

```bash
# Check for existing CI configs
ls -la .github/workflows/ 2>/dev/null
ls -la .gitlab-ci.yml 2>/dev/null
ls -la .circleci/ 2>/dev/null
ls -la Jenkinsfile 2>/dev/null
```

Read project configuration:
- `package.json` (Node/TypeScript): scripts for build, test, lint
- `Cargo.toml` (Rust): workspace structure, test commands
- `go.mod` (Go): module structure
- `pyproject.toml` / `setup.py` (Python): build system, test framework
- `pom.xml` / `build.gradle` (Java/Kotlin): build tool, test framework
- `Makefile`: available targets
- `Dockerfile` / `docker-compose.yml`: container builds

Identify:
- **Language/runtime** and version requirements
- **Package manager** (npm, yarn, pnpm, pip, cargo, go)
- **Test framework** (vitest, jest, pytest, cargo test, go test)
- **Lint tools** (eslint, prettier, ruff, clippy, golangci-lint)
- **Build commands** (tsc, webpack, vite, cargo build, go build)
- **Deployment target** (Vercel, Fly.io, AWS, Docker, npm registry)

#### 2. Generate Workflow

Create a CI workflow matching the detected stack. For GitHub Actions:

**Standard CI workflow** (`.github/workflows/ci.yml`):
- Trigger on: push to main, pull_request
- Matrix test across relevant versions (Node 18/20, Python 3.11/3.12, etc.)
- Steps: checkout, setup runtime, cache dependencies, install, lint, typecheck, test, build
- Fail fast on lint/typecheck, continue on test for full results
- Upload test artifacts on failure

**PR workflow** (`.github/workflows/pr.yml`):
- Trigger on: pull_request only
- Run full test suite + coverage report
- Post coverage comment on PR
- Check for breaking changes

**Release workflow** (`.github/workflows/release.yml`) if applicable:
- Trigger on: tag push or manual dispatch
- Build artifacts, run tests, publish to registry
- Create GitHub release with changelog

#### 3. Apply Best Practices

Every generated workflow includes:
- **Dependency caching** (actions/cache or setup-* cache options)
- **Concurrency control** (`concurrency: { group: ..., cancel-in-progress: true }`)
- **Timeout limits** on each job
- **Minimal permissions** (`permissions:` block)
- **Path filtering** to skip CI for docs-only changes
- **Security**: never echo secrets, use OIDC for cloud auth where possible

#### 4. Present and Confirm

Show the generated workflow(s) and ask for confirmation before writing files.

### Mode: Debug

#### 1. Identify the Failure

Ask for or detect:
- Which workflow/job failed?
- Error message or log output
- Recent changes that might have caused it

```bash
# Check recent CI runs via gh CLI
gh run list --limit 5
gh run view --log-failed 2>/dev/null | head -100
```

#### 2. Common Failure Patterns

Diagnose against known patterns:

| Pattern | Diagnosis | Fix |
|---------|-----------|-----|
| `npm ci` fails | Lock file out of sync | Run `npm install` and commit `package-lock.json` |
| Permission denied | Missing `permissions:` block | Add required permissions to workflow |
| Cache miss every run | Cache key too specific | Broaden cache key (use `hashFiles()` on lock file) |
| Timeout | Tests too slow or infinite loop | Add `timeout-minutes:`, investigate slow tests |
| Node/Python version error | Runtime version mismatch | Match CI version to local `.node-version`/`.python-version` |
| Docker build fails | Missing build context | Check `.dockerignore`, verify COPY paths |
| Secret not found | Secret not configured | Check repo Settings > Secrets, verify `${{ secrets.NAME }}` |
| Rate limiting | Too many API calls | Add retry logic, use caching, reduce matrix size |

#### 3. Propose Fix

Generate a minimal diff to fix the issue. Test the fix locally if possible:

```bash
# Validate workflow syntax
gh workflow view ci.yml 2>/dev/null
```

### Mode: Optimize

#### 1. Audit Current Pipeline

Read existing workflow files and analyze:
- Total job count and estimated runtime
- Dependency installation time (cached vs uncached)
- Test parallelization opportunities
- Redundant steps across workflows

#### 2. Optimization Recommendations

```
[CI PIPELINE] Optimization Report
═══════════════════════════════════════════

Current estimated CI time: {n} minutes

Optimization 1: Parallelize test suite (saves ~{n} min)
  → Split tests into shards using matrix strategy

Optimization 2: Improve caching (saves ~{n} min)
  → Cache node_modules, .next/cache, build artifacts

Optimization 3: Skip redundant work (saves ~{n} min)
  → Add path filters to skip CI for docs changes
  → Use concurrency groups to cancel stale runs

Optimization 4: Reduce matrix (saves ~{n} min)
  → Test on {recommended} versions instead of {current} matrix

Estimated new CI time: {n} minutes ({pct}% faster)
```

### Mode: Status

Quick check of recent CI runs:

```bash
gh run list --limit 10
```

Display a summary table of recent runs with status, duration, and trigger.

## Agent Delegation

For complex pipeline debugging, delegate to specialized agents:

```
Task(subagent_type="oh-my-claudecode:debugger", model="sonnet", prompt="DEBUG CI FAILURE:
Workflow: {workflow_name}
Error: {error_output}
Recent changes: {git_log}
Provide root cause and minimal fix.")
```

For security review of pipeline:

```
Task(subagent_type="oh-my-claudecode:security-reviewer", model="sonnet", prompt="REVIEW CI SECURITY:
Workflow files: {paths}
Check for: secret exposure, excessive permissions, untrusted input in run steps, supply chain risks.")
```

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Workflow generated** | Show workflow, confirm with user, write files |
| **Debug fix found** | Show minimal diff, apply after confirmation |
| **Optimization complete** | Show report with actionable recommendations |
| **Status checked** | Display recent runs summary |
| **No CI platform detected** | Ask user which platform to target |

## Notes

- **GitHub Actions first**: Default target is GitHub Actions. Adapts to GitLab CI or CircleCI if detected.
- **Non-destructive**: Never overwrites existing workflows without confirmation. Creates new files or shows diffs.
- **Security-conscious**: Generated workflows use minimal permissions, never expose secrets, prefer OIDC auth.
- **Requires `gh` CLI**: Debug and status modes use `gh` for API access. Install via `brew install gh`.
- **Headless mode compatible**: Generated workflows support `claude -p` for headless CI integration.

---

Begin CI pipeline workflow now. Parse arguments and detect the project stack.
