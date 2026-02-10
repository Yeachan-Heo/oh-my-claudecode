# Issue #319 Fix: Stop Hook Freeze on Bash Errors

## Problem Summary

When bash commands encountered errors during execution, the Stop hook would trigger and cause the entire session to freeze/hang, requiring users to manually kill and restart the session.

## Root Cause Analysis

The issue was NOT that bash errors directly trigger the Stop hook. The actual problem was in the error handling of the `persistent-mode.mjs` hook:

### The Bug

```javascript
} catch (error) {
  console.error(`[persistent-mode] Error: ${error.message}`);
  console.log(JSON.stringify({ continue: true }));
}
```

**Problem:** When an error occurred in the try block, the catch block would:
1. Write to STDERR using `console.error()`
2. Write to STDOUT using `console.log()`

However, if the error was related to broken stdout/stderr streams (which can happen during bash errors or other system issues):
- The `console.error()` call would throw EPIPE
- The catch block itself would error before reaching `console.log()`
- No JSON output would reach Claude Code
- The hook would hang waiting for a response
- The session would freeze

### Why This Happens with Bash Errors

When a bash command fails:
1. Claude Code may close/reset the hook process's streams
2. The persistent-mode hook tries to process the stop event
3. If it encounters any error, the catch block tries to write to console
4. The console write throws because streams are closed
5. No JSON response is sent
6. Session hangs indefinitely

## Solution Implemented

### 1. Robust Error Handling in Catch Block

Replaced `console.log`/`console.error` with direct stream writes wrapped in try-catch:

```javascript
} catch (error) {
  try {
    process.stderr.write(`[persistent-mode] Error: ${error?.message || error}\n`);
  } catch {
    // Ignore stderr errors - we just need to return valid JSON
  }
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  } catch {
    // If stdout write fails, exit gracefully
    process.exit(0);
  }
}
```

### 2. Global Error Handlers

Added handlers for uncaught exceptions and unhandled rejections:

```javascript
process.on('uncaughtException', (error) => {
  try {
    process.stderr.write(`[persistent-mode] Uncaught exception: ${error?.message || error}\n`);
  } catch { }
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  } catch { }
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  // Similar handling
});
```

### 3. Safety Timeout

Added a 10-second timeout to force exit if the hook doesn't complete:

```javascript
const safetyTimeout = setTimeout(() => {
  try {
    process.stderr.write('[persistent-mode] Safety timeout reached, forcing exit\n');
  } catch { }
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  } catch { }
  process.exit(0);
}, 10000);

main().finally(() => {
  clearTimeout(safetyTimeout);
});
```

### 4. Early Return for Invalid JSON

Added early validation to prevent processing invalid input:

```javascript
try {
  data = JSON.parse(input);
} catch {
  // Invalid JSON - allow stop to prevent hanging
  process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  return;
}
```

## Testing

All tests pass:
- ✓ Normal empty input returns continue:true
- ✓ Empty stdin (broken pipe) returns continue:true without hanging
- ✓ Invalid JSON returns continue:true without hanging
- ✓ Hook completes within timeout (< 1 second)

## Files Changed

- `templates/hooks/persistent-mode.mjs` - Main fix
- `src/hooks/persistent-mode/__tests__/error-handling.test.ts` - Test coverage
- `CHANGELOG.md` - Documentation

## Impact

This fix ensures the Stop hook will NEVER hang the session, even under catastrophic error conditions. The hook is now resilient to:
- Broken stdout/stderr streams
- EPIPE errors
- Invalid JSON input
- Uncaught exceptions
- Unhandled promise rejections
- Any unforeseen errors (via safety timeout)

## Related Issues

- Issue #240: stdin timeout issues (related to hook hangs)
- Issue #213: Context limit stop deadlocks (different but related stop hook issue)
