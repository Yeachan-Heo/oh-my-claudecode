---
name: build-fix
description: Fix build and TypeScript errors with minimal changes
level: 3
---

# Build Fix Skill

Fix build and compilation errors quickly with minimal code changes. Get the build green without refactoring.

## When to Use

This skill activates when:
- User says "fix the build", "build is broken"
- TypeScript compilation fails
- the build command or type checker reports errors
- User requests "minimal fixes" for errors

## What It Does

Delegates to the `build-fixer` agent (Sonnet model) to:

1. **Collect Errors**
   - Run the project's type check command (e.g., `tsc --noEmit`, `mypy`, `cargo check`, `go vet`)
   - Or run the project's build command to get build failures
   - Categorize errors by type and severity

2. **Fix Strategically**
   - Add type annotations where missing
   - Add null checks where needed
   - Fix import/export statements
   - Resolve module resolution issues
   - Fix linter errors blocking build

3. **Minimal Diff Strategy**
   - NO refactoring of unrelated code
   - NO architectural changes
   - NO performance optimizations
   - ONLY what's needed to make build pass

4. **Verify**
   - Run the project's type check command after each fix
   - Ensure no new errors introduced
   - Stop when build passes

## Agent Delegation

```
Task(
  subagent_type="oh-my-claudecode:build-fixer",
  model="sonnet",
  prompt="BUILD FIX TASK

Fix all build and TypeScript errors with minimal changes.

Requirements:
- Run tsc/build to collect errors
- Fix errors one at a time
- Verify each fix doesn't introduce new errors
- NO refactoring, NO architectural changes
- Stop when build passes

Output: Build error resolution report with:
- List of errors fixed
- Lines changed per fix
- Final build status"
)
```

## Stop Conditions

The build-fixer agent stops when:
- Type check command exits with code 0
- Build command completes successfully
- No new errors introduced

## Output Format

```
BUILD FIX REPORT
================

Errors Fixed: 12
Files Modified: 8
Lines Changed: 47

Fixes Applied:
1. src/utils/validation.ts:15 - Added return type annotation
2. src/components/Header.tsx:42 - Added null check for props.user
3. src/api/client.ts:89 - Fixed import path for axios
...

Final Build Status: ✓ PASSING
Verification: [type check command] (exit code 0)
```

## Best Practices

- **One fix at a time** - Easier to verify and debug
- **Minimal changes** - Don't refactor while fixing
- **Document why** - Comment non-obvious fixes
- **Test after** - Ensure tests still pass

## Use with Other Skills

Combine with other skills for comprehensive fixing:

**With Ultrawork:**
```
/ultrawork fix all build errors
```
Spawns multiple build-fixer agents in parallel for different files.

**With Ralph:**
```
/ralph fix the build
```
Keeps trying until build passes, even if it takes multiple iterations.

**With Pipeline:**
```
/pipeline debug "build is failing"
```
Uses: explore → architect → build-fixer workflow.
