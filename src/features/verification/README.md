# Verification Module

Reusable verification protocol logic extracted from ralph, ultrawork, and autopilot workflows.

## Overview

This module provides a single source of truth for verification requirements and execution across all major OMC workflows. It standardizes the verification process and ensures consistent evidence collection.

## Key Features

- **Standard Checks**: Pre-defined verification checks (build, test, lint, functionality, architect approval, TODO completion, error-free)
- **Protocol Creation**: Define custom verification protocols with required checks
- **Evidence Collection**: Automated evidence gathering through command execution
- **Validation**: Validate evidence freshness and completeness
- **Reporting**: Generate human-readable verification reports in multiple formats

## Usage

### Creating a Verification Protocol

```typescript
import { createProtocol, STANDARD_CHECKS } from './verification';

// Create a protocol with standard checks
const ralphProtocol = createProtocol(
  'ralph',
  'Ralph loop verification protocol',
  [
    STANDARD_CHECKS.BUILD,
    STANDARD_CHECKS.TEST,
    STANDARD_CHECKS.LINT,
    STANDARD_CHECKS.FUNCTIONALITY,
    STANDARD_CHECKS.ARCHITECT,
    STANDARD_CHECKS.TODO,
    STANDARD_CHECKS.ERROR_FREE
  ],
  true // strict mode - all checks must pass
);
```

### Running Verification

```typescript
import { createChecklist, runVerification, formatReport } from './verification';

// Create checklist from protocol
const checklist = createChecklist(ralphProtocol);

// Run all checks
await runVerification(checklist, {
  parallel: true,      // Run checks in parallel
  failFast: false,     // Continue even if checks fail
  skipOptional: false, // Run all checks including optional
  cwd: process.cwd()   // Working directory
});

// Generate report
const report = formatReport(checklist, {
  includeEvidence: true,
  includeOutput: true,
  format: 'markdown'
});

console.log(report);
```

### Validating Evidence

```typescript
import { checkEvidence, validateChecklist } from './verification';

// Validate specific check
const check = checklist.checks.find(c => c.id === 'build');
if (check?.evidence) {
  const validation = checkEvidence(check, check.evidence);
  if (!validation.valid) {
    console.log('Issues:', validation.issues);
    console.log('Recommendations:', validation.recommendations);
  }
}

// Validate entire checklist
const validation = await validateChecklist(checklist);
if (validation.valid) {
  console.log('All verifications passed!');
} else {
  console.log('Verification failed:', validation.issues);
}
```

## Standard Checks

### BUILD
- **Type**: `build_success`
- **Command**: `npm run build`
- **Required**: Yes
- **Purpose**: Ensures TypeScript compiles without errors

### TEST
- **Type**: `test_pass`
- **Command**: `npm test`
- **Required**: Yes
- **Purpose**: Ensures all tests pass

### LINT
- **Type**: `lint_clean`
- **Command**: `npm run lint`
- **Required**: Yes
- **Purpose**: Ensures no linting errors

### FUNCTIONALITY
- **Type**: `functionality_verified`
- **Required**: Yes
- **Purpose**: Manual verification that features work as described

### ARCHITECT
- **Type**: `architect_approval`
- **Required**: Yes
- **Purpose**: Architect agent has reviewed and approved

### TODO
- **Type**: `todo_complete`
- **Required**: Yes
- **Purpose**: All TODO items are marked complete

### ERROR_FREE
- **Type**: `error_free`
- **Required**: Yes
- **Purpose**: No unaddressed errors remain

## Integration

### Ralph Loop
Ralph uses the verification protocol to ensure task completion before exiting.

```typescript
const protocol = createProtocol('ralph', 'Ralph completion verification', [
  STANDARD_CHECKS.TODO,
  STANDARD_CHECKS.BUILD,
  STANDARD_CHECKS.TEST,
  STANDARD_CHECKS.FUNCTIONALITY,
  STANDARD_CHECKS.ARCHITECT
]);

const checklist = createChecklist(protocol);
await runVerification(checklist);

if (checklist.summary?.verdict === 'approved') {
  // All checks passed - use cancel to cleanly exit
  console.log('[RALPH VERIFIED] Run /oh-my-claudecode:cancel to exit.');
}
```

### Ultrawork
Ultrawork uses verification to check completion criteria:

```typescript
const protocol = createProtocol('ultrawork', 'Ultrawork verification', [
  STANDARD_CHECKS.TODO,
  STANDARD_CHECKS.FUNCTIONALITY,
  STANDARD_CHECKS.ERRORS
]);

const checklist = createChecklist(protocol);
await runVerification(checklist, { parallel: true });

const report = formatReport(checklist, { format: 'markdown' });
```

### Autopilot
Autopilot uses verification in both QA and Validation phases:

```typescript
// QA Phase
const qaProtocol = createProtocol('autopilot-qa', 'QA verification', [
  STANDARD_CHECKS.BUILD,
  STANDARD_CHECKS.LINT,
  STANDARD_CHECKS.TEST
]);

// Validation Phase
const validationProtocol = createProtocol('autopilot-validation', 'Final validation', [
  STANDARD_CHECKS.BUILD,
  STANDARD_CHECKS.TEST,
  STANDARD_CHECKS.FUNCTIONALITY,
  STANDARD_CHECKS.ARCHITECT
]);
```

## Evidence Freshness

Evidence is considered stale if older than 5 minutes. The `checkEvidence` function will flag stale evidence and recommend re-running verification.

## Report Formats

### Markdown
Human-readable format with clear sections for summary and checks:

```markdown
# Verification Report: ralph

**Status:** complete
**Started:** 2026-01-23T15:00:00.000Z
**Completed:** 2026-01-23T15:05:00.000Z

## Summary

- **Total Checks:** 7
- **Passed:** 7
- **Failed:** 0
- **Skipped:** 0
- **Verdict:** APPROVED
```

### JSON
Machine-readable format for programmatic access:

```json
{
  "protocol": {...},
  "startedAt": "2026-01-23T15:00:00.000Z",
  "completedAt": "2026-01-23T15:05:00.000Z",
  "checks": [...],
  "status": "complete",
  "summary": {...}
}
```

### Text
Simple text format for logs:

```
Verification Report: ralph
Status: complete
Started: 2026-01-23T15:00:00.000Z
Completed: 2026-01-23T15:05:00.000Z

Summary:
  Total Checks: 7
  Passed: 7
  Failed: 0
  Skipped: 0
  Verdict: APPROVED
```

## Error Handling

The verification module handles errors gracefully:

- Command failures are captured as evidence with `passed: false`
- Timeouts are enforced per check (default: 60 seconds)
- Parallel execution uses `Promise.allSettled` to collect all results
- Failed checks include error messages and output for debugging

## Best Practices

1. **Always use STANDARD_CHECKS**: Don't create custom checks unless necessary
2. **Enable parallel execution**: Set `parallel: true` for faster verification
3. **Keep evidence fresh**: Re-run verification before final approval
4. **Include architect approval**: Always require architect verification for critical workflows
5. **Check TODO completion**: Ensure all tasks are marked complete before verification
