---
name: security-audit
description: Proactive security scanning - threat model, permissions validation, secret detection, dependency audit, sandbox recommendations
level: 3
aliases: [sec-audit, security-scan, threat-model]
argument-hint: [full|quick|secrets|deps|permissions] - default is full
---

# Security Audit Skill

Proactive security assessment for your project and Claude Code environment. Covers threat modeling, secret detection, dependency supply chain, permission validation, and sandbox recommendations.

## Usage

```
/oh-my-claudecode:security-audit
/oh-my-claudecode:security-audit quick
/oh-my-claudecode:security-audit secrets
/oh-my-claudecode:security-audit deps
/oh-my-claudecode:sec-audit
```

Or say: "security scan", "check for secrets", "audit dependencies", "threat model", "is my setup secure"

## Audit Modes

| Mode | Scope | Duration |
|------|-------|----------|
| `full` | All 6 checks below | ~5 min |
| `quick` | Secrets + permissions only | ~1 min |
| `secrets` | Secret/credential detection only | ~1 min |
| `deps` | Dependency supply chain only | ~2 min |
| `permissions` | Claude Code permissions only | ~30 sec |

## Workflow

### 1. Secret Detection

Scan for leaked credentials, API keys, and sensitive data:

```bash
# Search for common secret patterns in tracked files
git ls-files | head -500
```

Use Grep to search for patterns:
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `API_KEY=`, `SECRET_KEY=`
- `sk-ant-`, `sk-`, `ghp_`, `gho_`, `github_pat_`, `xoxb-`, `xoxp-`
- `password\s*=\s*["']`, `token\s*=\s*["']`, `secret\s*=\s*["']`
- `BEGIN RSA PRIVATE KEY`, `BEGIN OPENSSH PRIVATE KEY`
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- Base64-encoded strings that look like credentials (40+ chars)

Check these files specifically:
- `.env`, `.env.local`, `.env.production` (should be in `.gitignore`)
- `docker-compose.yml` (hardcoded secrets)
- CI workflow files (secrets in plain text vs `${{ secrets.* }}`)
- `CLAUDE.md` (sometimes contains API keys by accident)
- `settings.json` (MCP server configs with credentials)

**CRITICAL**: If secrets are found in git history:
```
[SECURITY AUDIT] CRITICAL: Secret found in git history
  File: {path}
  Pattern: {type}
  Action Required: Rotate the credential immediately, then use git-filter-repo to purge history
```

### 2. Permission Validation

Check Claude Code's permission configuration:

```bash
# Check settings files
cat ~/.claude/settings.json 2>/dev/null
cat .claude/settings.json 2>/dev/null
```

Evaluate:
- **Overly permissive Bash**: Are dangerous commands allowed? (`rm -rf`, `docker`, `kubectl`, `sudo`)
- **Write scope too broad**: Can Claude write to system directories?
- **MCP server permissions**: Do connected MCP servers have appropriate access?
- **Network access**: Is outbound network access appropriately restricted?

Flag and recommend:
```
[PERMISSIONS] Review
  ✅ Bash: Restricted to project directory
  ⚠️ Warning: `rm` is allowed without path restriction
  ❌ Critical: `sudo` commands are permitted — restrict immediately
  ✅ MCP: Filesystem server scoped to project root
```

### 3. Dependency Supply Chain

Audit dependencies for known vulnerabilities:

```bash
# Node.js
npm audit --json 2>/dev/null | head -50
# or
yarn audit --json 2>/dev/null | head -50

# Python
pip audit 2>/dev/null || safety check 2>/dev/null

# Rust
cargo audit 2>/dev/null

# Go
govulncheck ./... 2>/dev/null
```

Check for:
- **Known CVEs** in direct and transitive dependencies
- **Outdated dependencies** with security patches available
- **Suspicious packages** (typosquatting, unmaintained with high downloads)
- **Lock file integrity** (package-lock.json, yarn.lock present and committed)

### 4. Threat Model Assessment

Analyze the project's attack surface:

**Data Flow Analysis:**
- Where does user input enter the system? (API endpoints, forms, file uploads)
- Where is sensitive data stored? (database, files, environment)
- What external services are called? (APIs, databases, cloud services)
- What authentication/authorization is in place?

**STRIDE Analysis:**
| Threat | Check | Status |
|--------|-------|--------|
| **S**poofing | Auth mechanisms, session management | {status} |
| **T**ampering | Input validation, data integrity | {status} |
| **R**epudiation | Logging, audit trails | {status} |
| **I**nformation Disclosure | Error handling, data exposure | {status} |
| **D**enial of Service | Rate limiting, resource limits | {status} |
| **E**levation of Privilege | Authorization checks, role management | {status} |

### 5. Claude Code Environment Security

Check the Claude Code setup itself:

- **CLAUDE.md injection risk**: Could a malicious PR modify CLAUDE.md to inject prompts?
- **Hook security**: Are hooks loading from trusted sources? Could hook scripts be tampered with?
- **MCP server trust**: Are all MCP servers from trusted sources? Any custom servers with broad access?
- **Skill supply chain**: Are installed skills from trusted publishers?
- **Session data**: Is session history stored securely? Any sensitive data in `.omc/` state files?

### 6. Sandbox Recommendations

Based on findings, recommend appropriate isolation:

**For development:**
```
[SANDBOX] Development Recommendations
  → Use Docker containers for running untrusted code
  → Restrict Bash permissions to project directory only
  → Use environment variables (not files) for secrets
  → Enable git hooks for pre-commit secret scanning
```

**For CI/CD:**
```
[SANDBOX] CI/CD Recommendations
  → Use OIDC authentication instead of long-lived secrets
  → Pin action versions to SHA (not tags)
  → Use minimal permissions in workflow files
  → Enable Dependabot or Renovate for dependency updates
```

## Agent Delegation

For deep code-level security analysis, delegate:

```
Task(subagent_type="oh-my-claudecode:security-reviewer", model="opus", prompt="SECURITY REVIEW:
Project: {project_path}
Focus areas: {findings_from_threat_model}
Check OWASP Top 10, input validation, auth/authz, and data handling.
Provide severity-rated findings with remediation guidance.")
```

## Report Format

```
[SECURITY AUDIT] Report
═══════════════════════════════════════════

Overall Risk Score: {score}/10 ({LOW|MEDIUM|HIGH|CRITICAL})

┌──────────────────────────────────────────┐
│ FINDINGS SUMMARY                          │
├────────┬─────────────────────────────────┤
│ 🔴 Critical │ {n} findings                │
│ 🟠 High     │ {n} findings                │
│ 🟡 Medium   │ {n} findings                │
│ 🔵 Low      │ {n} findings                │
│ ✅ Passed   │ {n} checks                  │
├────────┴─────────────────────────────────┤
│ DETAILS                                   │
├──────────────────────────────────────────┤
│ 1. [CRITICAL] {finding}                  │
│    File: {path}:{line}                   │
│    Fix: {remediation}                    │
│                                          │
│ 2. [HIGH] {finding}                      │
│    File: {path}:{line}                   │
│    Fix: {remediation}                    │
└──────────────────────────────────────────┘

Next Steps:
  1. {highest priority action}
  2. {second priority action}
  3. Schedule follow-up audit in {timeframe}
```

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Audit complete** | Display report with findings and remediation |
| **Critical finding** | Highlight immediately, recommend blocking deploy |
| **Clean audit** | Display passing checks and healthy status |
| **Tool missing** | Note which audit tools need installation |

## Notes

- **Non-destructive**: This skill only reads and analyzes — it never modifies code or configuration.
- **Complement to code-reviewer**: This skill audits infrastructure and environment; `security-reviewer` agent audits code-level security.
- **Pre-commit hook**: Consider adding `detect-secrets` or `gitleaks` as a pre-commit hook for ongoing protection.
- **Audit frequency**: Run `quick` mode before each PR, `full` mode weekly or before releases.
- **OWASP alignment**: Threat model follows STRIDE methodology; code findings map to OWASP Top 10.

---

Begin security audit now. Parse the mode argument and start scanning.
