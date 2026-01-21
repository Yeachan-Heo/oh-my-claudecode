/**
 * Python REPL Tool - Main handler implementation
 *
 * Provides a persistent Python REPL environment for code execution.
 * JSON-RPC 2.0 over Unix socket with session locking and timeout escalation.
 *
 * Actions:
 * - execute: Run Python code in the persistent environment
 * - interrupt: Send interrupt to running code with signal escalation
 * - reset: Clear the execution namespace
 * - get_state: Get memory usage and variable list
 *
 * @module python-repl/tool
 */

import { z } from 'zod';
import type {
  PythonReplInput,
  ExecuteResult,
  StateResult,
  ResetResult,
  InterruptResult,
} from './types.js';
import { validatePathSegment } from './paths.js';
import { SessionLock, LockTimeoutError } from './session-lock.js';
import { sendSocketRequest, SocketConnectionError, SocketTimeoutError, JsonRpcError } from './socket-client.js';
import { ensureBridge, killBridgeWithEscalation, spawnBridgeServer } from './bridge-manager.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_EXECUTION_TIMEOUT_MS = 300000; // 5 minutes
const DEFAULT_QUEUE_TIMEOUT_MS = 30000; // 30 seconds

// JSON-RPC error codes
const ERROR_INVALID_ACTION = -32600;
const ERROR_QUEUE_TIMEOUT = -32004;
const ERROR_BRIDGE_FAILED = -32005;

// =============================================================================
// ZOD SCHEMA
// =============================================================================

/**
 * Input schema for the Python REPL tool.
 * Validates and types all input parameters.
 */
export const pythonReplSchema = z.object({
  action: z
    .enum(['execute', 'interrupt', 'reset', 'get_state'])
    .describe(
      'Action to perform: ' +
        'execute (run Python code), ' +
        'interrupt (stop running code), ' +
        'reset (clear namespace), ' +
        'get_state (memory and variables)'
    ),

  researchSessionID: z
    .string()
    .min(1, 'researchSessionID is required')
    .describe('Unique identifier for the research session'),

  code: z
    .string()
    .optional()
    .describe('Python code to execute (required for "execute" action)'),

  executionLabel: z
    .string()
    .optional()
    .describe(
      'Human-readable label for this code execution. ' +
        'Examples: "Load dataset", "Train model", "Generate plot"'
    ),

  executionTimeout: z
    .number()
    .positive()
    .default(DEFAULT_EXECUTION_TIMEOUT_MS)
    .describe('Timeout for code execution in milliseconds (default: 300000 = 5 min)'),

  queueTimeout: z
    .number()
    .positive()
    .default(DEFAULT_QUEUE_TIMEOUT_MS)
    .describe('Timeout for acquiring session lock in milliseconds (default: 30000 = 30 sec)'),

  projectDir: z
    .string()
    .optional()
    .describe('Project directory containing .venv/. Defaults to current working directory.'),
});

export type PythonReplSchemaInput = z.infer<typeof pythonReplSchema>;

// =============================================================================
// EXECUTION COUNTER
// =============================================================================

const executionCounters = new Map<string, number>();

/**
 * Get and increment the execution counter for a session.
 * Used for tracking execution order in a session.
 */
function getNextExecutionCount(sessionId: string): number {
  const current = executionCounters.get(sessionId) || 0;
  const next = current + 1;
  executionCounters.set(sessionId, next);
  return next;
}

// =============================================================================
// OUTPUT FORMATTING
// =============================================================================

/**
 * Format execution result into a readable string for Claude.
 */
function formatExecuteResult(
  result: ExecuteResult,
  sessionId: string,
  executionLabel?: string,
  executionCount?: number
): string {
  const lines: string[] = [];

  lines.push('=== Python REPL Execution ===');
  lines.push(`Session: ${sessionId}`);
  if (executionLabel) {
    lines.push(`Label: ${executionLabel}`);
  }
  if (executionCount !== undefined) {
    lines.push(`Execution #: ${executionCount}`);
  }
  lines.push('');

  // Output section
  if (result.stdout) {
    lines.push('--- Output ---');
    lines.push(result.stdout.trimEnd());
    lines.push('');
  }

  // Errors section
  if (result.stderr) {
    lines.push('--- Errors ---');
    lines.push(result.stderr.trimEnd());
    lines.push('');
  }

  // Markers section (scientific findings, statistics, etc.)
  if (result.markers && result.markers.length > 0) {
    lines.push('--- Markers ---');
    for (const marker of result.markers) {
      const subtypeStr = marker.subtype ? `:${marker.subtype}` : '';
      lines.push(`[${marker.type}${subtypeStr}] ${marker.content}`);
    }
    lines.push('');
  }

  // Timing section
  if (result.timing) {
    lines.push('--- Timing ---');
    const durationSec = (result.timing.duration_ms / 1000).toFixed(3);
    lines.push(`Duration: ${durationSec}s`);
    lines.push(`Started: ${result.timing.started_at}`);
    lines.push('');
  }

  // Memory section
  if (result.memory) {
    lines.push('--- Memory ---');
    lines.push(`RSS: ${result.memory.rss_mb.toFixed(1)} MB`);
    lines.push(`VMS: ${result.memory.vms_mb.toFixed(1)} MB`);
    lines.push('');
  }

  // Error details section (for failed executions)
  if (result.error) {
    lines.push('=== Execution Failed ===');
    lines.push(`Error Type: ${result.error.type}`);
    lines.push(`Message: ${result.error.message}`);
    if (result.error.traceback) {
      lines.push('');
      lines.push('Traceback:');
      lines.push(result.error.traceback);
    }
    lines.push('');
  }

  lines.push(result.success ? '=== Execution Complete ===' : '=== Execution Failed ===');

  return lines.join('\n');
}

/**
 * Format state result into a readable string.
 */
function formatStateResult(result: StateResult, sessionId: string): string {
  const lines: string[] = [];

  lines.push('=== Python REPL State ===');
  lines.push(`Session: ${sessionId}`);
  lines.push('');

  lines.push('--- Memory ---');
  lines.push(`RSS: ${result.memory.rss_mb.toFixed(1)} MB`);
  lines.push(`VMS: ${result.memory.vms_mb.toFixed(1)} MB`);
  lines.push('');

  lines.push('--- Variables ---');
  lines.push(`Count: ${result.variable_count}`);
  if (result.variables.length > 0) {
    lines.push('');
    // Group variables, max 10 per line for readability
    const chunks: string[][] = [];
    for (let i = 0; i < result.variables.length; i += 10) {
      chunks.push(result.variables.slice(i, i + 10));
    }
    for (const chunk of chunks) {
      lines.push(chunk.join(', '));
    }
  } else {
    lines.push('(no user variables defined)');
  }
  lines.push('');

  lines.push('=== State Retrieved ===');

  return lines.join('\n');
}

/**
 * Format reset result into a readable string.
 */
function formatResetResult(result: ResetResult, sessionId: string): string {
  const lines: string[] = [];

  lines.push('=== Python REPL Reset ===');
  lines.push(`Session: ${sessionId}`);
  lines.push(`Status: ${result.status}`);
  lines.push('');

  lines.push('--- Memory After Reset ---');
  lines.push(`RSS: ${result.memory.rss_mb.toFixed(1)} MB`);
  lines.push(`VMS: ${result.memory.vms_mb.toFixed(1)} MB`);
  lines.push('');

  lines.push('=== Namespace Cleared ===');

  return lines.join('\n');
}

/**
 * Format interrupt result into a readable string.
 */
function formatInterruptResult(
  result: InterruptResult & { terminationTimeMs?: number },
  sessionId: string
): string {
  const lines: string[] = [];

  lines.push('=== Python REPL Interrupt ===');
  lines.push(`Session: ${sessionId}`);
  lines.push(`Status: ${result.status}`);

  if (result.terminatedBy) {
    lines.push(`Terminated By: ${result.terminatedBy}`);
  }
  if (result.terminationTimeMs !== undefined) {
    lines.push(`Termination Time: ${result.terminationTimeMs}ms`);
  }
  lines.push('');

  lines.push('=== Execution Interrupted ===');

  return lines.join('\n');
}

/**
 * Format a lock timeout error into a readable string.
 */
function formatLockTimeoutError(error: LockTimeoutError, sessionId: string): string {
  const lines: string[] = [];

  lines.push('=== Session Busy ===');
  lines.push(`Session: ${sessionId}`);
  lines.push('');
  lines.push('The session is currently busy processing another request.');
  lines.push(`Queue timeout: ${error.timeout}ms`);
  lines.push('');

  if (error.lastHolder) {
    lines.push('Current holder:');
    lines.push(`  PID: ${error.lastHolder.pid}`);
    lines.push(`  Host: ${error.lastHolder.hostname}`);
    lines.push(`  Since: ${error.lastHolder.acquiredAt}`);
    lines.push('');
  }

  lines.push('Suggestions:');
  lines.push('  1. Wait and retry later');
  lines.push('  2. Use the "interrupt" action to stop the current execution');
  lines.push('  3. Use the "reset" action to clear the session');

  return lines.join('\n');
}

/**
 * Format a socket connection error into a readable string.
 */
function formatSocketError(error: SocketConnectionError, sessionId: string): string {
  const lines: string[] = [];

  lines.push('=== Connection Error ===');
  lines.push(`Session: ${sessionId}`);
  lines.push('');
  lines.push(`Error: ${error.message}`);
  lines.push(`Socket: ${error.socketPath}`);
  lines.push('');

  lines.push('Troubleshooting:');
  lines.push('  1. The bridge process may have crashed - retry will auto-restart');
  lines.push('  2. Use "reset" action to force restart the bridge');
  lines.push('  3. Ensure .venv exists with Python installed');

  return lines.join('\n');
}

/**
 * Format a general error into a readable string.
 */
function formatGeneralError(error: Error, sessionId: string, action: string): string {
  const lines: string[] = [];

  lines.push('=== Error ===');
  lines.push(`Session: ${sessionId}`);
  lines.push(`Action: ${action}`);
  lines.push('');
  lines.push(`Type: ${error.name}`);
  lines.push(`Message: ${error.message}`);

  if (error.stack) {
    lines.push('');
    lines.push('Stack trace:');
    lines.push(error.stack);
  }

  return lines.join('\n');
}

// =============================================================================
// ACTION HANDLERS
// =============================================================================

/**
 * Handle the 'execute' action - run Python code.
 */
async function handleExecute(
  sessionId: string,
  socketPath: string,
  code: string,
  executionTimeout: number,
  executionLabel?: string
): Promise<string> {
  const executionCount = getNextExecutionCount(sessionId);

  try {
    // Send execute request with extra time for response
    const result = await sendSocketRequest<ExecuteResult>(
      socketPath,
      'execute',
      { code, timeout: executionTimeout / 1000 },
      executionTimeout + 10000 // Allow extra time for response
    );

    return formatExecuteResult(result, sessionId, executionLabel, executionCount);
  } catch (error) {
    // Handle specific socket errors that might be recoverable
    if (error instanceof SocketConnectionError) {
      throw error; // Let the main handler retry with a new bridge
    }

    if (error instanceof SocketTimeoutError) {
      // Execution timeout - the code took too long
      return [
        '=== Execution Timeout ===',
        `Session: ${sessionId}`,
        `Label: ${executionLabel || '(none)'}`,
        '',
        `The code execution exceeded the timeout of ${executionTimeout / 1000} seconds.`,
        '',
        'The execution is still running in the background.',
        'Use the "interrupt" action to stop it.',
      ].join('\n');
    }

    if (error instanceof JsonRpcError) {
      return [
        '=== Execution Failed ===',
        `Session: ${sessionId}`,
        '',
        `Error Code: ${error.code}`,
        `Message: ${error.message}`,
        error.data ? `Data: ${JSON.stringify(error.data, null, 2)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }

    throw error;
  }
}

/**
 * Handle the 'reset' action - clear the namespace.
 */
async function handleReset(sessionId: string, socketPath: string): Promise<string> {
  try {
    const result = await sendSocketRequest<ResetResult>(socketPath, 'reset', {}, 10000);
    return formatResetResult(result, sessionId);
  } catch (error) {
    // If reset fails, try to kill and restart the bridge
    await killBridgeWithEscalation(sessionId);

    return [
      '=== Bridge Restarted ===',
      `Session: ${sessionId}`,
      '',
      'The bridge was unresponsive and has been terminated.',
      'A new bridge will be spawned on the next request.',
      '',
      'Memory has been cleared.',
    ].join('\n');
  }
}

/**
 * Handle the 'get_state' action - retrieve memory and variables.
 */
async function handleGetState(sessionId: string, socketPath: string): Promise<string> {
  try {
    const result = await sendSocketRequest<StateResult>(socketPath, 'get_state', {}, 5000);
    return formatStateResult(result, sessionId);
  } catch (error) {
    if (error instanceof SocketConnectionError) {
      throw error; // Let main handler deal with connection issues
    }

    if (error instanceof SocketTimeoutError) {
      return [
        '=== State Retrieval Timeout ===',
        `Session: ${sessionId}`,
        '',
        'Could not retrieve state within timeout.',
        'The bridge may be busy with a long-running execution.',
      ].join('\n');
    }

    throw error;
  }
}

/**
 * Handle the 'interrupt' action - stop running code with signal escalation.
 */
async function handleInterrupt(
  sessionId: string,
  socketPath: string,
  gracePeriodMs: number = 5000
): Promise<string> {
  // First try graceful interrupt via socket
  try {
    const result = await sendSocketRequest<InterruptResult>(
      socketPath,
      'interrupt',
      {},
      Math.min(gracePeriodMs, 5000)
    );

    return formatInterruptResult(
      {
        ...result,
        status: result.status || 'interrupted',
        terminatedBy: 'graceful',
      },
      sessionId
    );
  } catch {
    // Graceful interrupt failed - escalate with signals
    const escalationResult = await killBridgeWithEscalation(sessionId, { gracePeriodMs });

    return formatInterruptResult(
      {
        status: 'force_killed',
        terminatedBy: escalationResult.terminatedBy,
        terminationTimeMs: escalationResult.terminationTimeMs,
      },
      sessionId
    );
  }
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

/**
 * Main handler for the Python REPL tool.
 *
 * @param input - Validated input from the tool call
 * @returns Formatted string output for Claude
 *
 * @example
 * ```typescript
 * const output = await pythonReplHandler({
 *   action: 'execute',
 *   researchSessionID: 'my-session',
 *   code: 'print("Hello, World!")',
 * });
 * ```
 */
export async function pythonReplHandler(input: PythonReplInput): Promise<string> {
  // Step 1: Validate input with Zod
  const parseResult = pythonReplSchema.safeParse(input);
  if (!parseResult.success) {
    const errors = parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
    return [
      '=== Validation Error ===',
      '',
      'Invalid input parameters:',
      ...errors.map((e) => `  - ${e}`),
    ].join('\n');
  }

  const {
    action,
    researchSessionID: sessionId,
    code,
    executionLabel,
    executionTimeout,
    queueTimeout,
    projectDir,
  } = parseResult.data;

  // Step 2: Validate session ID (path traversal protection)
  try {
    validatePathSegment(sessionId, 'researchSessionID');
  } catch (error) {
    return [
      '=== Invalid Session ID ===',
      '',
      `Error: ${(error as Error).message}`,
      '',
      'Session IDs must be safe path segments without:',
      '  - Path separators (/ or \\)',
      '  - Parent directory references (..)',
      '  - Null bytes',
      '  - Windows reserved names (CON, PRN, etc.)',
    ].join('\n');
  }

  // Step 3: Validate action-specific requirements
  if (action === 'execute' && !code) {
    return [
      '=== Missing Code ===',
      '',
      'The "execute" action requires the "code" parameter.',
      '',
      'Example:',
      '  action: "execute"',
      '  code: "print(\'Hello!\')"',
    ].join('\n');
  }

  // Step 4: Acquire session lock
  const lock = new SessionLock(sessionId);
  try {
    await lock.acquire(queueTimeout);
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return formatLockTimeoutError(error, sessionId);
    }
    return formatGeneralError(error as Error, sessionId, action);
  }

  try {
    // Step 5: Ensure bridge is running
    let meta;
    try {
      meta = await ensureBridge(sessionId, projectDir);
    } catch (error) {
      return [
        '=== Bridge Startup Failed ===',
        `Session: ${sessionId}`,
        '',
        `Error: ${(error as Error).message}`,
        '',
        'Ensure you have a Python virtual environment:',
        '  python -m venv .venv',
        '  .venv/bin/pip install pandas numpy matplotlib',
      ].join('\n');
    }

    // Step 6: Dispatch to action handler
    switch (action) {
      case 'execute':
        try {
          return await handleExecute(
            sessionId,
            meta.socketPath,
            code!,
            executionTimeout,
            executionLabel
          );
        } catch (error) {
          // On connection error, try respawning the bridge once
          if (error instanceof SocketConnectionError) {
            try {
              meta = await spawnBridgeServer(sessionId, projectDir);
              return await handleExecute(
                sessionId,
                meta.socketPath,
                code!,
                executionTimeout,
                executionLabel
              );
            } catch (retryError) {
              return formatSocketError(
                retryError instanceof SocketConnectionError
                  ? retryError
                  : new SocketConnectionError((retryError as Error).message, meta.socketPath),
                sessionId
              );
            }
          }
          return formatGeneralError(error as Error, sessionId, action);
        }

      case 'reset':
        return await handleReset(sessionId, meta.socketPath);

      case 'get_state':
        try {
          return await handleGetState(sessionId, meta.socketPath);
        } catch (error) {
          if (error instanceof SocketConnectionError) {
            return formatSocketError(error, sessionId);
          }
          return formatGeneralError(error as Error, sessionId, action);
        }

      case 'interrupt':
        return await handleInterrupt(sessionId, meta.socketPath);

      default:
        return [
          '=== Unknown Action ===',
          '',
          `Received action: ${action}`,
          '',
          'Valid actions are:',
          '  - execute: Run Python code',
          '  - interrupt: Stop running code',
          '  - reset: Clear the namespace',
          '  - get_state: Get memory and variable info',
        ].join('\n');
    }
  } finally {
    // Step 7: Always release lock
    await lock.release();
  }
}

// =============================================================================
// TOOL DEFINITION FOR REGISTRATION
// =============================================================================

/**
 * Tool definition for registration with the tool registry.
 */
export const pythonReplTool = {
  name: 'python_repl',
  description:
    'Execute Python code in a persistent REPL environment. ' +
    'Variables and state persist between calls within the same session. ' +
    'Actions: execute (run code), interrupt (stop execution), reset (clear state), get_state (view memory/variables). ' +
    'Supports scientific computing with pandas, numpy, matplotlib.',
  schema: pythonReplSchema.shape,
  handler: async (args: unknown) => {
    const output = await pythonReplHandler(args as PythonReplInput);
    return {
      content: [{ type: 'text' as const, text: output }],
    };
  },
};

// =============================================================================
// EXPORTS
// =============================================================================

export { getNextExecutionCount };

/**
 * Reset the execution counter for a session.
 * Useful for testing or when manually resetting state.
 */
export function resetExecutionCounter(sessionId: string): void {
  executionCounters.delete(sessionId);
}

/**
 * Get the current execution count for a session without incrementing.
 */
export function getExecutionCount(sessionId: string): number {
  return executionCounters.get(sessionId) || 0;
}
