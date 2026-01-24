---
name: security-review
description: Run a comprehensive security review on code
---

# Security Review Skill

Conduct a thorough security audit checking for OWASP Top 10 vulnerabilities, hardcoded secrets, and unsafe patterns.

## When to Use

This skill activates when:
- User requests "security review", "security audit"
- After writing code that handles user input
- After adding new API endpoints
- After modifying authentication/authorization logic
- Before deploying to production
- After adding external dependencies

## What It Does

Delegates to the `security-reviewer` agent (Opus model) for deep security analysis:

1. **OWASP Top 10 Scan**
   - A01: Broken Access Control
   - A02: Cryptographic Failures
   - A03: Injection (SQL, NoSQL, Command, XSS)
   - A04: Insecure Design
   - A05: Security Misconfiguration
   - A06: Vulnerable and Outdated Components
   - A07: Identification and Authentication Failures
   - A08: Software and Data Integrity Failures
   - A09: Security Logging and Monitoring Failures
   - A10: Server-Side Request Forgery (SSRF)

2. **Secrets Detection**
   - Hardcoded API keys
   - Passwords in source code
   - Private keys in repo
   - Tokens and credentials
   - Connection strings with secrets

3. **Input Validation**
   - All user inputs sanitized
   - SQL/NoSQL injection prevention
   - Command injection prevention
   - XSS prevention (output escaping)
   - Path traversal prevention

4. **Authentication/Authorization**
   - Proper password hashing (bcrypt, argon2)
   - Session management security
   - Access control enforcement
   - JWT implementation security

5. **Dependency Security**
   - Run `npm audit` for known vulnerabilities
   - Check for outdated dependencies
   - Identify high-severity CVEs

## Agent Delegation

```
Task(
  subagent_type="oh-my-claudecode:security-reviewer",
  model="opus",
  prompt="SECURITY REVIEW TASK

Conduct comprehensive security audit of codebase.

Scope: [specific files or entire codebase]

Security Checklist:
1. OWASP Top 10 scan
2. Hardcoded secrets detection
3. Input validation review
4. Authentication/authorization review
5. Dependency vulnerability scan (npm audit)

Output: Security review report with:
- Summary of findings by severity (CRITICAL, HIGH, MEDIUM, LOW)
- Specific file:line locations
- CVE references where applicable
- Remediation guidance for each issue
- Overall security posture assessment"
)
```

## Output Format

```
SECURITY REVIEW REPORT
======================

Scope: Entire codebase (42 files scanned)
Scan Date: 2026-01-24T14:30:00Z

CRITICAL (2)
------------
1. src/api/auth.ts:89 - Hardcoded API Key
   Finding: AWS API key hardcoded in source code
   Impact: Credential exposure if code is public or leaked
   Remediation: Move to environment variables, rotate key immediately
   Reference: OWASP A02:2021 – Cryptographic Failures

2. src/db/query.ts:45 - SQL Injection Vulnerability
   Finding: User input concatenated directly into SQL query
   Impact: Attacker can execute arbitrary SQL commands
   Remediation: Use parameterized queries or ORM
   Reference: OWASP A03:2021 – Injection

HIGH (5)
--------
3. src/auth/password.ts:22 - Weak Password Hashing
   Finding: Passwords hashed with MD5 (cryptographically broken)
   Impact: Passwords can be reversed via rainbow tables
   Remediation: Use bcrypt or argon2 with appropriate work factor
   Reference: OWASP A02:2021 – Cryptographic Failures

4. src/components/UserInput.tsx:67 - XSS Vulnerability
   Finding: User input rendered with dangerouslySetInnerHTML
   Impact: Cross-site scripting attack vector
   Remediation: Sanitize HTML or use safe rendering
   Reference: OWASP A03:2021 – Injection (XSS)

5. src/api/upload.ts:34 - Path Traversal Vulnerability
   Finding: User-controlled filename used without validation
   Impact: Attacker can read/write arbitrary files
   Remediation: Validate and sanitize filenames, use allowlist
   Reference: OWASP A01:2021 – Broken Access Control

...

MEDIUM (8)
----------
...

LOW (12)
--------
...

DEPENDENCY VULNERABILITIES
--------------------------
Found 3 vulnerabilities via npm audit:

CRITICAL: axios@0.21.0 - Server-Side Request Forgery (CVE-2021-3749)
  Installed: axios@0.21.0
  Fix: npm install axios@0.21.2

HIGH: lodash@4.17.19 - Prototype Pollution (CVE-2020-8203)
  Installed: lodash@4.17.19
  Fix: npm install lodash@4.17.21

...

OVERALL ASSESSMENT
------------------
Security Posture: POOR (2 CRITICAL, 5 HIGH issues)

Immediate Actions Required:
1. Rotate exposed AWS API key
2. Fix SQL injection in db/query.ts
3. Upgrade password hashing to bcrypt
4. Update vulnerable dependencies

Recommendation: DO NOT DEPLOY until CRITICAL and HIGH issues resolved.
```

## Security Checklist

The security-reviewer agent verifies:

### Authentication & Authorization
- [ ] Passwords hashed with strong algorithm (bcrypt/argon2)
- [ ] Session tokens cryptographically random
- [ ] JWT tokens properly signed and validated
- [ ] Access control enforced on all protected resources
- [ ] No authentication bypass vulnerabilities

### Input Validation
- [ ] All user inputs validated and sanitized
- [ ] SQL queries use parameterization (no string concatenation)
- [ ] NoSQL queries prevent injection
- [ ] File uploads validated (type, size, content)
- [ ] URLs validated to prevent SSRF

### Output Encoding
- [ ] HTML output escaped to prevent XSS
- [ ] JSON responses properly encoded
- [ ] No user data in error messages
- [ ] Content-Security-Policy headers set

### Secrets Management
- [ ] No hardcoded API keys
- [ ] No passwords in source code
- [ ] No private keys in repo
- [ ] Environment variables used for secrets
- [ ] Secrets not logged or exposed in errors

### Cryptography
- [ ] Strong algorithms used (AES-256, RSA-2048+)
- [ ] Proper key management
- [ ] Random number generation cryptographically secure
- [ ] TLS/HTTPS enforced for sensitive data

### Dependencies
- [ ] No known vulnerabilities in dependencies
- [ ] Dependencies up to date
- [ ] No CRITICAL or HIGH CVEs
- [ ] Dependency sources verified

## Severity Definitions

**CRITICAL** - Exploitable vulnerability with severe impact (data breach, RCE, credential theft)
**HIGH** - Vulnerability requiring specific conditions but serious impact
**MEDIUM** - Security weakness with limited impact or difficult exploitation
**LOW** - Best practice violation or minor security concern

## Remediation Priority

1. **Rotate exposed secrets** - Immediate (within 1 hour)
2. **Fix CRITICAL** - Urgent (within 24 hours)
3. **Fix HIGH** - Important (within 1 week)
4. **Fix MEDIUM** - Planned (within 1 month)
5. **Fix LOW** - Backlog (when convenient)

## Use with Other Skills

**With Pipeline:**
```
/pipeline security "review authentication module"
```
Uses: explore → security-reviewer → executor → security-reviewer-low (re-verify)

**With Swarm:**
```
/swarm 4:security-reviewer "audit all API endpoints"
```
Parallel security review across multiple endpoints.

**With Ralph:**
```
/ralph security-review then fix all issues
```
Review, fix, re-review until all issues resolved.

## Best Practices

- **Review early** - Security by design, not afterthought
- **Review often** - Every major feature or API change
- **Automate** - Run security scans in CI/CD pipeline
- **Fix immediately** - Don't accumulate security debt
- **Educate** - Learn from findings to prevent future issues
- **Verify fixes** - Re-run security review after remediation
