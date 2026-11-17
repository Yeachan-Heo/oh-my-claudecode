/**
 * Canonical Python REPL sandbox boundary description.
 *
 * The python_repl bridge (bridge/gyoshu_bridge.py) executes code in-process
 * with a restricted namespace: every import is rejected by
 * validate_user_code_ast, no third-party module is prebound, file I/O and
 * dynamic code execution builtins are blocked, and dunder/format-field
 * traversal is blocked. Every user-facing description of the tool MUST
 * include this exact boundary so guidance surfaces never advertise
 * capabilities the sandbox forbids (issue #3682).
 */
export declare const PYTHON_REPL_SANDBOX_BOUNDARY: string;
//# sourceMappingURL=sandbox.d.ts.map