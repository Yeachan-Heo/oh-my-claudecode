---
name: no-no-debug
description: >
  Self-evolution system for AI coding assistants. Six integrated mechanisms:
  (1) Real-time logging of errors, corrections, and failures to error_log.md,
  (2) Silent 3-gate checkpoint before every code change, (3) periodic error review
  that scans error_log.md and updates a categorized tracker, (4) rule accumulation
  loop that adds new error types automatically and marks cured ones, (5) confirmation
  gate requiring user approval before new features, DB/env/deploy changes, external
  publishing, or new directions, (6) auto hooks configured on install for passive
  capture. Triggers on "error review", "错误追踪", "进化报告", "evolution report",
  or automatically when review interval has elapsed.
user-invocable: true
---

# no-no-debug — Self-Evolution System for AI Coding Assistants

## Overview

Six mechanisms work together to eliminate repeated mistakes permanently:

- **Mechanism 1**: Real-time logging — errors, corrections, and failures auto-appended to `~/.claude/memory/error_log.md`
- **Mechanism 2**: Silent 3-gate checkpoint before every code change (no output when all clear)
- **Mechanism 3**: Periodic review that reads error_log.md, classifies errors, updates a persistent tracker
- **Mechanism 4**: Rule accumulation — new error types auto-added, repeat offenses strengthen gates, 4 clean periods = cured
- **Mechanism 5**: Confirmation gate — must ask user before new features, DB/env/deploy changes, external publishing, or new directions
- **Mechanism 6**: Auto hooks — passive capture configured at install time

---

## Configuration

| Setting | Default | Options |
|---------|---------|---------|
| Log file | `~/.claude/memory/error_log.md` | Any writable path |
| Tracker file | `~/.claude/memory/error_tracker.md` | Any writable path |
| Review frequency | 3 days | 1 / 3 / 7 days |
| Language | Auto-detected | zh / en |

To change review frequency, add a comment to the top of `error_tracker.md`:
```
<!-- review_frequency: 1 -->
```

---

## Mechanism 1 — Real-time Logging

**Always active. Runs passively. No user action required.**

Append a line to `~/.claude/memory/error_log.md` whenever any of the following occur:

### Trigger conditions

| Event | Log type |
|-------|----------|
| Bash command exits with non-zero status | `BUILD_FAIL` or `RUNTIME_ERROR` |
| Deploy or publish action fails | `DEPLOY_FAIL` |
| Test run has failures | `TEST_FAIL` |
| User corrects the AI ("不对", "错了", "为什么又", "wrong", "that's not right", "you already did this") | `USER_CORRECTION` |
| Same fix applied more than once | `REPEATED_FIX` |
| Network or API connection times out | `CONNECTION_FAIL` |
| Login or authentication fails | `AUTH_FAIL` |

### Log format

```
[YYYY-MM-DD HH:MM] TYPE | description
```

Examples:
```
[2024-04-08 14:32] BUILD_FAIL | npm run build failed — cannot find module './utils/auth'
[2024-04-08 15:01] USER_CORRECTION | User said "wrong" — had used cached data instead of live fetch
[2024-04-08 16:45] REPEATED_FIX | Applied the same null-check fix to userProfile.ts for the second time
[2024-04-09 09:12] AUTH_FAIL | Login redirect broken after updating next.config.js
```

### File initialization

If `~/.claude/memory/error_log.md` does not exist, create the directory and file with this header:

```markdown
# Error Log
<!-- Auto-maintained by no-no-debug -->
<!-- Format: [YYYY-MM-DD HH:MM] TYPE | description -->

```

---

## Mechanism 2 — Three-Gate Checkpoint (Silent)

**Always active. No output when all gates pass.**

Before ANY code change, file edit, configuration update, or deployment action, silently verify all three gates:

### Gate 1 — Before Making the Change
- What exactly does this change affect?
- Could authentication or login break?
- Does this touch `.env`, database schema, connection strings, or credentials?
- Does this modify shared infrastructure used by other features?
- Is this a new feature or a bug fix? (If new feature → trigger Mechanism 5 first)

### Gate 2 — After Making the Change
- Did I actually verify the result, or just check that a command ran without error?
- Did I walk the flow as a real user would, end to end?
- Did I check the failure path, not just the success path?
- Does the output shown to the user match what is actually in the code?

### Gate 3 — Before Deploying or Publishing
- Did I test with a non-admin account?
- Is the permission table complete for all new routes and actions?
- Are all required database migrations included?
- Are there cache invalidation requirements?
- Does this publish to an external platform? (If yes → trigger Mechanism 5 first)

**Output rule**: Stay completely silent when all gates pass. When any gate raises a concern, surface it to the user before proceeding.

---

## Mechanism 3 — Periodic Review

### Auto-trigger condition
At the start of each session, read `~/.claude/memory/error_tracker.md` for `Last Review Date`. If elapsed days since that date are greater than or equal to the configured review frequency (default: 3), run the review automatically.

### Manual trigger
User says any of: `error review`, `错误追踪`, `进化报告`, `evolution report`

### Step 1 — Initialize files if missing

If `~/.claude/memory/error_log.md` does not exist, create it (see Mechanism 1 initialization).

If `~/.claude/memory/error_tracker.md` does not exist:

1. Create the directory `~/.claude/memory/` if needed
2. Write the following template to `~/.claude/memory/error_tracker.md`:

```markdown
# Error Tracker
<!-- review_frequency: 3 -->

Last Review Date: {TODAY}
Review Count: 0
Total Lifetime Errors: 0

## Active Dimensions

| Dimension | Total | Last Seen | Clean Periods | Status |
|-----------|-------|-----------|---------------|--------|
| 数据准确性 / Data Accuracy | 0 | — | 0 | Active |
| 环境安全 / Environment Safety | 0 | — | 0 | Active |
| 预见性 / Foresight | 0 | — | 0 | Active |
| 用户视角 / User Perspective | 0 | — | 0 | Active |
| 验证完整性 / Verification | 0 | — | 0 | Active |
| 记忆一致性 / Memory Consistency | 0 | — | 0 | Active |
| 工具判断 / Tool Judgment | 0 | — | 0 | Active |
| 审查覆盖 / Review Completeness | 0 | — | 0 | Active |
| 操作精准 / Operational Precision | 0 | — | 0 | Active |
| 先查后做 / Check Before Doing | 0 | — | 0 | Active |
| 简洁性 / Conciseness | 0 | — | 0 | Active |
| 回归意识 / Regression Awareness | 0 | — | 0 | Active |
| 风格一致性 / Style Consistency | 0 | — | 0 | Active |
| 独立判断 / Independent Judgment | 0 | — | 0 | Active |
| 人类将要犯的蠢 / Dumb things humans will do | 0 | — | 0 | Active |
| AI 将要犯的蠢 / Dumb things AI will do | 0 | — | 0 | Active |

## Cured Dimensions (4+ consecutive clean periods)

_None yet_

## Prevention Rules

_Auto-populated as errors are discovered_

## History

| Period | Date Range | New Errors | Notes |
|--------|------------|------------|-------|
```

3. Output the first-run message (see First-Run Output section below)

### Step 2 — Read error_log.md

Read `~/.claude/memory/error_log.md` and collect all entries from `Last Review Date` to today.

If the file is empty or has no entries in the review window, note that and proceed with zero counts.

If a session search tool (e.g. claude-mem) is also available, supplement with a search for:
```
correction mistake wrong error broken fix failed incorrect fabricated
```

If both the log file has no entries and no search tool is available, ask the user:
> "Can you briefly describe any mistakes or corrections from this review period? (Or say 'none' to skip.)"

### Step 3 — Classify each entry

Map each log entry or incident to one of the active dimensions:

| Dimension | Detection Criteria |
|-----------|-------------------|
| **数据准确性 / Data Accuracy** | Numbers, formulas, or values shown to user that don't match actual code; config values stated without checking the source |
| **环境安全 / Environment Safety** | Any change that broke login, corrupted `.env`, dropped DB connection, or altered environment in an unintended way |
| **预见性 / Foresight** | Problem only discovered after deploy: missing permissions, missing migrations, cache staleness, missing env vars |
| **用户视角 / User Perspective** | Feature works technically but user cannot complete the intended workflow from their account |
| **验证完整性 / Verification** | Claimed "fixed" or "done" without performing an end-to-end test; only checked status codes or build output |
| **记忆一致性 / Memory Consistency** | Asked user for information that was already recorded in memory or a previous session |
| **工具判断 / Tool Judgment** | Continued using a failing or unreliable tool instead of switching to a working alternative |
| **审查覆盖 / Review Completeness** | Items missed in a review or summary; user had to follow up on overlooked things |
| **操作精准 / Operational Precision** | A change produced unintended side effects on unrelated content or functionality |
| **先查后做 / Check Before Doing** | Used an unfamiliar tool, version, or API without checking documentation first |
| **简洁性 / Conciseness** | Wrote significantly more code than the problem required; over-engineered a simple fix |
| **回归意识 / Regression Awareness** | Fixing one bug introduced a new bug or broke existing behavior |
| **风格一致性 / Style Consistency** | New code does not follow the project's existing naming, formatting, or architecture conventions |
| **独立判断 / Independent Judgment** | Blindly executed a user instruction when the underlying premise was incorrect |
| **人类将要犯的蠢 / Dumb things humans will do** | Predictable user mistakes not yet made but worth guarding against |
| **AI 将要犯的蠢 / Dumb things AI will do** | Predictable AI failure modes not yet triggered but worth guarding against |

If an entry does not match any existing dimension, treat it as a new dimension (see Mechanism 4).

### Step 4 — Update the tracker

For each dimension:
- **Errors found this period**: increment Total, reset Clean Periods to 0, update Last Seen to today
- **No errors this period**: increment Clean Periods by 1
- **Clean Periods reaches 4**: move dimension row to "Cured Dimensions" section

Update:
- `Last Review Date` to today
- `Review Count` + 1
- `Total Lifetime Errors` + sum of new errors this period
- Add a row to the History table

Write all changes to disk before reporting.

### Step 5 — Output the report

Detect language from conversation context. Use the matching format:

**Chinese format:**
```
进化报告 R{N}（{开始日期} – {结束日期}）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

维度                  本期    累计    状态
──────────────────────────────────────────
数据准确性              {n}     {total}   {status}
环境安全                {n}     {total}   {status}
预见性                  {n}     {total}   {status}
用户视角                {n}     {total}   {status}
验证完整性              {n}     {total}   {status}
记忆一致性              {n}     {total}   {status}
工具判断                {n}     {total}   {status}
审查覆盖                {n}     {total}   {status}
操作精准                {n}     {total}   {status}
先查后做                {n}     {total}   {status}
简洁性                  {n}     {total}   {status}
回归意识                {n}     {total}   {status}
风格一致性              {n}     {total}   {status}
独立判断                {n}     {total}   {status}
人类将要犯的蠢          {n}     {total}   {status}
AI 将要犯的蠢           {n}     {total}   {status}

合计: {sum} | 已根治: {cured}/{total_dimensions}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

重灾区: {top dimension}({n}) > {second}({n})
下次审查: {date}
```

**English format:**
```
Evolution Report R{N} ({start date} – {end date})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Dimension                    This period  Total   Status
─────────────────────────────────────────────────────────
Data Accuracy                    {n}      {total}  {status}
Environment Safety               {n}      {total}  {status}
Foresight                        {n}      {total}  {status}
User Perspective                 {n}      {total}  {status}
Verification                     {n}      {total}  {status}
Memory Consistency               {n}      {total}  {status}
Tool Judgment                    {n}      {total}  {status}
Review Completeness              {n}      {total}  {status}
Operational Precision            {n}      {total}  {status}
Check Before Doing               {n}      {total}  {status}
Conciseness                      {n}      {total}  {status}
Regression Awareness             {n}      {total}  {status}
Style Consistency                {n}      {total}  {status}
Independent Judgment             {n}      {total}  {status}
Dumb things humans will do       {n}      {total}  {status}
Dumb things AI will do           {n}      {total}  {status}

Total: {sum} | Cured: {cured}/{total_dimensions}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Hot spots: {top dimension}({n}) > {second}({n})
Next review: {date}
```

Show cured dimensions separately at the end of the report with `Moved to Cured: {dimension name}` when a new one crosses the threshold this period.

---

## Mechanism 4 — Rule Accumulation and Self-Evolution

### New error type discovered

When an entry cannot be classified into any existing dimension:

1. Add a new row to the "Active Dimensions" table with:
   - A short descriptive name (bilingual if possible)
   - Total: 1, Last Seen: today, Clean Periods: 0, Status: Active

2. Add a new entry to the "Prevention Rules" section of the tracker:
   ```markdown
   ### {Dimension Name}
   - **What it is**: {one-sentence description}
   - **How to detect**: {observable signal}
   - **Prevention**: {specific check to add to Gate 1, 2, or 3}
   - **Added**: {today}
   - **Occurrences**: 1
   ```

3. Include in the report: `New dimension added: {name}`

### Repeat offense — rule strengthening

When any dimension records 3 or more total errors:

- Review the Prevention Rule for that dimension
- Add one specific, concrete check to the appropriate Gate in Mechanism 2
- Note the strengthening in the tracker's "Prevention Rules" section

### Cured status

When a dimension reaches 4 consecutive clean periods:

- Move the row from "Active Dimensions" to "Cured Dimensions"
- Add a note: `Cured after {N} total errors over {M} periods`
- The dimension's Gate check remains active — cured means the habit is formed, not that the check is removed

---

## Mechanism 5 — Confirmation Gate

Before taking any of the following actions, stop and ask the user to confirm intent. Do not proceed until confirmation is received.

**Requires confirmation:**
- Starting development of a new feature (not a bug fix or improvement to existing functionality)
- Any change to database schema, connection config, environment variables, or deployment pipeline
- Any action that publishes content to an external platform (social media, app stores, APIs, email campaigns)
- When the user raises a new idea or new direction mid-task that would change the current plan

**Confirmation format** (adapt to language):
> "Before I proceed — this looks like [new feature / DB change / external publish / new direction]. Can you confirm you want me to start on this now?"

**Does not require confirmation:**
- Bug fixes within the existing scope
- Refactoring or performance improvements with no behavior change
- Documentation updates
- Continuing work already confirmed in the same session

---

## Mechanism 6 — Auto Hooks

The following hooks should be configured in `~/.claude/settings.json` at install time. They enable passive capture without any user action.

### Hook definitions

**PostToolUse:Bash — log command failures**

Trigger: any Bash tool call that exits with a non-zero status code.

Action: append to `~/.claude/memory/error_log.md`:
```
[{timestamp}] BUILD_FAIL | {command} exited with code {exitCode} — {stderr first line}
```

**PostToolUse:Edit — remind to verify**

Trigger: any Edit or Write tool call that modifies a source file (not markdown, not config-only).

Action: silently note the file path. If Gate 2 has not been completed for this edit in the current session, surface:
> "Edit complete. Have you verified the result end-to-end?"

Only prompt once per file per session. Do not prompt for documentation files.

**UserPromptSubmit — detect corrections**

Trigger: user message contains any of these signals:
- Chinese: `不对`, `错了`, `为什么又`, `你已经`, `重复了`, `说过了`, `再一次`
- English: `wrong`, `that's not right`, `you already`, `again`, `again?`, `repeated`, `told you`

Action: append to `~/.claude/memory/error_log.md`:
```
[{timestamp}] USER_CORRECTION | User said: "{first 80 chars of message}"
```

### Settings.json format

```json
{
  "hooks": {
    "PostToolUseFailure": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "echo \"[$(date '+%Y-%m-%d %H:%M')] TOOL_FAIL | $CLAUDE_TOOL_NAME failed\" >> ~/.claude/memory/error_log.md"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "echo \"$CLAUDE_USER_PROMPT\" | grep -qE '不对|错了|为什么又|wrong|that.s not right|you already' && echo \"[$(date '+%Y-%m-%d %H:%M')] USER_CORRECTION | $(echo $CLAUDE_USER_PROMPT | head -c 80)\" >> ~/.claude/memory/error_log.md || true"
          }
        ]
      }
    ]
  }
}
```

---

## First-Run Output

When the tracker file does not exist and is being created for the first time, output exactly this (in detected language):

**English:**
```
no-no-debug initialized.
Tracker created at: ~/.claude/memory/error_tracker.md
Log file created at: ~/.claude/memory/error_log.md

This system will automatically log errors and corrections (Mechanism 1),
silently guard every code change (Mechanism 2), review errors every 3 days
(Mechanism 3), build prevention rules automatically (Mechanism 4), confirm
scope before new work (Mechanism 5), and capture mistakes passively via
hooks (Mechanism 6).

If this helps you make fewer repeated mistakes, please star the repo:
https://github.com/summerliuuu/no-no-debug

Running first review now...
```

**Chinese:**
```
no-no-debug 已初始化。
追踪文件创建于：~/.claude/memory/error_tracker.md
日志文件创建于：~/.claude/memory/error_log.md

系统将自动记录错误和纠正（机制 1），静默守护每次代码改动（机制 2），
每 3 天审查一次错误（机制 3），自动沉淀预防规则（机制 4），
在开始新工作前先确认范围（机制 5），通过 hook 被动捕获失误（机制 6）。

如果这个系统帮你减少了重复犯错，欢迎给 repo 点 Star：
https://github.com/summerliuuu/no-no-debug

开始首次审查...
```

---

## Constraints

- Never fabricate log entries or session history — if the log is empty and no search tool is available, ask the user
- Report every active dimension in the review, even those with zero new errors this period
- The review process must not itself commit the errors it tracks
- Applies to all projects and languages, not just the current one
- If a memory/search tool is unavailable, fall back to reading error_log.md directly
- Always write tracker changes to disk before outputting the report
- Never skip Mechanism 5 for new features or deployment actions, even when the user seems to be in a hurry
- Real-time logging (Mechanism 1) must be fast and non-blocking — a single append, never a read-modify-write of the whole file
- Do not log noise: only log genuine failures or genuine corrections, not routine tool calls
