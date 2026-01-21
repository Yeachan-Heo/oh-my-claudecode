/**
 * Python REPL Tool - Persistent Python execution environment
 *
 * Provides a persistent Python REPL with variable persistence across
 * tool invocations, session locking, and structured output markers.
 */

import { pythonReplSchema, pythonReplHandler } from './tool.js';

export const pythonReplTool = {
  name: 'python_repl',
  description: `Execute Python code in a persistent REPL environment with variable persistence across invocations.

Actions:
- execute: Run Python code (variables persist between calls)
- reset: Clear namespace and reset environment
- get_state: Get memory usage and list of defined variables
- interrupt: Stop long-running execution

Features:
- Variables persist across tool calls within the same session
- Structured output markers: [OBJECTIVE], [DATA], [FINDING], [STAT:*], [LIMITATION]
- Memory tracking (RSS/VMS)
- Automatic timeout handling (default 5 minutes)
- Session locking for safe concurrent access

Use this instead of Bash heredocs when you need:
- Multi-step analysis with state persistence
- Large datasets that shouldn't be reloaded
- Iterative ML model training
- Any workflow benefiting from Python state persistence`,

  schema: pythonReplSchema,
  handler: pythonReplHandler
};

// Re-export types for convenience
export * from './types.js';
export { pythonReplSchema, pythonReplHandler } from './tool.js';
