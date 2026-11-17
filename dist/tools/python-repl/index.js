/**
 * Python REPL Tool - Persistent Python execution environment
 *
 * Provides a persistent Python REPL with variable persistence across
 * tool invocations, session locking, and structured output markers.
 */
import { pythonReplSchema, pythonReplHandler } from './tool.js';
import { PYTHON_REPL_SANDBOX_BOUNDARY } from './sandbox.js';
export const pythonReplTool = {
    name: 'python_repl',
    description: `Execute Python code in a persistent REPL environment with variable persistence across invocations.

Actions:
- execute: Run Python code (variables persist between calls)
- reset: Clear namespace and reset environment
- get_state: Get memory usage and list of defined variables
- interrupt: Stop long-running execution

${PYTHON_REPL_SANDBOX_BOUNDARY}

Features:
- Variables persist across tool calls within the same session
- Structured output markers: [OBJECTIVE], [DATA], [FINDING], [STAT:*], [LIMITATION]
- Memory tracking (RSS/VMS)
- Automatic timeout handling (default 5 minutes)
- Session locking for safe concurrent access

Use this instead of Bash heredocs when you need:
- Multi-step analysis with state persistence
- In-memory data analysis with persistent variables
- Any workflow benefiting from Python state persistence`,
    // The SDK `tool()` and every OMC schema serializer expect a ZodRawShape, not
    // a ZodObject: passing the object serializes its instance properties instead
    // of the parameters.
    schema: pythonReplSchema.shape,
    handler: pythonReplHandler
};
// Re-export types for convenience
export * from './types.js';
export { pythonReplSchema, pythonReplHandler } from './tool.js';
//# sourceMappingURL=index.js.map