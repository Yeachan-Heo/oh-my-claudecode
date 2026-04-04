---
name: contribute
description: Run contribution guide compliance checklist for OMC project
aliases: ["contrib", "contribution-check", "pr-checklist"]
triggers: ["contribute", "contribution check", "pr checklist", "ready to pr"]
---

<Purpose>
Run a comprehensive contribution compliance checklist for the oh-my-claudecode project. Verifies branch policy, CI status, commit format, PR description, and diff size before submitting a PR.
</Purpose>

<Use_When>
- Before creating a PR for the OMC project
- When user says "contribute", "contribution check", "pr checklist", "ready to pr"
- After completing a feature and wanting to verify compliance
</Use_When>

<Do_Not_Use_When>
- Working on a project other than oh-my-claudecode
- Already submitted the PR (use for pre-submission checks only)
- Quick fixes where the user explicitly wants to skip checks
</Do_Not_Use_When>

<Steps>

## Compliance Checklist

Run the following checks in order. Report pass/fail for each with remediation steps for failures.

### 1. Branch Check
- Run `git branch --show-current` to get current branch name
- **FAIL** if current branch is `main` — you should be on a feature branch
- **PASS** if on any other branch

### 2. Base Branch Check
- Run `git remote -v` to verify upstream remote exists
- The PR must target `dev` branch on upstream (`Yeachan-Heo/oh-my-claudecode`)
- Remind the user to use `gh pr create --base dev`
- **WARN** if upstream remote is not configured

### 3. CI Checks
Run all four CI commands and report results:

```bash
npx tsc --noEmit
npm run lint
npm test -- --run
npm run build
```

- **FAIL** if any command exits non-zero — show the error output
- **PASS** if all four succeed
- Run these in sequence (build depends on tsc)

### 4. Commit Message Check
- Run `git log --oneline -10` to get recent commits
- Check each commit message against conventional commits pattern: `type(scope): description`
- Valid types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`
- **WARN** for non-conforming messages with suggested fixes
- **PASS** if all messages conform

### 5. Diff Size Check
- Run `git diff dev --stat` (or `git diff upstream/dev --stat` if local `dev` doesn't exist)
- Count total lines changed and files changed
- **WARN** if diff exceeds 1000 lines or 30 files — suggest splitting the PR
- **PASS** if within limits

### 6. Summary Report

Output a table summarizing all checks:

```
## Contribution Compliance Report

| Check | Status | Details |
|-------|--------|---------|
| Branch | PASS/FAIL | Current: <branch> |
| Base Branch | PASS/WARN | Target: dev |
| Type Check | PASS/FAIL | tsc --noEmit |
| Lint | PASS/FAIL | npm run lint |
| Tests | PASS/FAIL | npm test |
| Build | PASS/FAIL | npm run build |
| Commit Format | PASS/WARN | N/M commits conform |
| Diff Size | PASS/WARN | N lines, M files |

Overall: READY / NOT READY
```

If all checks pass: "Ready to create PR! Use: `gh pr create --base dev`"
If any checks fail: List remediation steps for each failure.

</Steps>

<Tool_Usage>
- Use `Bash` to run git commands, CI checks
- Output results directly as formatted text — no agent delegation needed
- This is a lightweight checklist skill, not an orchestration skill
</Tool_Usage>

<Examples>
<Good>
User: "/contribute"
Skill: Runs all 5 checks, outputs compliance report table, shows "READY" or remediation steps.
</Good>

<Good>
User: "ready to pr"
Skill: Auto-triggered by keyword, runs the same checklist.
</Good>
</Examples>

<Escalation_And_Stop_Conditions>
- If CI commands hang for more than 60 seconds each, timeout and report
- If git commands fail (not a git repo, no remote), report and stop
- Do not attempt to fix issues automatically — report and let the user decide
</Escalation_And_Stop_Conditions>
