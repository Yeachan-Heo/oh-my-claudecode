# Security Checklist

Perform a security audit on the current codebase based on OWASP Top 10 and common vulnerability patterns.

## When to Use

- Before deploying code to production
- After implementing authentication, authorization, or data handling features
- When reviewing code that handles user input, API calls, or file operations
- When you want a quick security health check of your project

## When NOT to Use

- For compliance audits requiring certified tools
- For runtime/dynamic security testing (use dedicated scanners instead)

## Process

### Step 1: Scan the Codebase

Read the project structure and identify security-relevant files:
- Authentication/authorization modules
- API endpoints and route handlers
- Database queries and ORM usage
- File upload/download handlers
- Configuration files (.env, config, secrets)
- Dependency files (package.json, requirements.txt, go.mod)

### Step 2: Check OWASP Top 10 (2021)

Evaluate each category and report findings:

| # | Category | What to Look For |
|---|----------|-----------------|
| A01 | Broken Access Control | Missing auth checks, IDOR, privilege escalation |
| A02 | Cryptographic Failures | Hardcoded secrets, weak hashing, HTTP instead of HTTPS |
| A03 | Injection | SQL injection, XSS, command injection, template injection |
| A04 | Insecure Design | Missing rate limiting, no input validation architecture |
| A05 | Security Misconfiguration | Debug mode on, default credentials, verbose errors |
| A06 | Vulnerable Components | Outdated dependencies with known CVEs |
| A07 | Auth Failures | Weak password policy, missing MFA, session issues |
| A08 | Data Integrity Failures | Unsigned updates, insecure deserialization, no CI/CD checks |
| A09 | Logging Failures | No audit logs, sensitive data in logs, no alerting |
| A10 | SSRF | Unvalidated URLs, internal network access from user input |

### Step 3: Check Common Patterns

- [ ] No secrets/API keys hardcoded in source code
- [ ] Environment variables used for sensitive configuration
- [ ] Input validation on all user-facing endpoints
- [ ] Parameterized queries (no string concatenation for SQL)
- [ ] CORS properly configured
- [ ] Rate limiting on authentication endpoints
- [ ] Error messages don't leak internal details
- [ ] Dependencies are up to date (no known CVEs)
- [ ] HTTPS enforced
- [ ] Security headers set (CSP, X-Frame-Options, etc.)

### Step 4: Generate Report

Output a summary in this format:

```
## Security Audit Report

**Project**: {project name}
**Date**: {date}
**Risk Level**: Critical / High / Medium / Low

### Findings

| Severity | Issue | File | Line | Recommendation |
|----------|-------|------|------|----------------|
| ...      | ...   | ...  | ...  | ...            |

### Summary
- Critical: {n} | High: {n} | Medium: {n} | Low: {n} | Info: {n}
- Top priority: {most critical finding}
```

## Options

- `/security-checklist` — Full audit (all categories)
- `/security-checklist --quick` — Quick scan (secrets + injection + auth only)
- `/security-checklist --deps` — Dependencies only (CVE check)
