/**
 * Hook Input Normalization
 *
 * Handles snake_case -> camelCase field mapping for Claude Code hook inputs.
 * Claude Code sends snake_case fields: tool_name, tool_input, tool_response,
 * session_id, cwd, hook_event_name. This module normalizes them to camelCase
 * with snake_case-first fallback.
 *
 * Uses Zod for structural validation to catch malformed inputs early.
 * Sensitive hooks use strict allowlists; others pass through unknown fields.
 */
import { z } from 'zod';
// --- Zod schemas for hook input validation ---
/** Schema for the common hook input structure (supports both snake_case and camelCase) */
const HookInputSchema = z.object({
    // snake_case fields from Claude Code
    tool_name: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
    hook_event_name: z.string().optional(),
    // camelCase fields (fallback / already normalized)
    toolName: z.string().optional(),
    toolInput: z.unknown().optional(),
    toolOutput: z.unknown().optional(),
    toolResponse: z.unknown().optional(),
    sessionId: z.string().optional(),
    directory: z.string().optional(),
    hookEventName: z.string().optional(),
    // Fields that are the same in both conventions
    prompt: z.string().optional(),
    message: z.object({ content: z.string().optional() }).optional(),
    parts: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    // Stop hook fields
    stop_reason: z.string().optional(),
    stopReason: z.string().optional(),
    user_requested: z.boolean().optional(),
    userRequested: z.boolean().optional(),
}).passthrough();
// --- Security: Hook sensitivity classification ---
/** Hooks where unknown fields are dropped (strict allowlist only) */
const SENSITIVE_HOOKS = new Set([
    'permission-request',
    'setup-init',
    'setup-maintenance',
    'session-end',
]);
/** All known camelCase field names the system uses (post-normalization) */
const KNOWN_FIELDS = new Set([
    // Core normalized fields
    'sessionId', 'toolName', 'toolInput', 'toolOutput', 'directory',
    'prompt', 'message', 'parts', 'hookEventName',
    // Stop hook fields
    'stop_reason', 'stopReason', 'user_requested', 'userRequested',
    // Permission hook fields
    'permission_mode', 'tool_use_id', 'transcript_path',
    // Subagent fields
    'agent_id', 'agent_name', 'agent_type', 'parent_session_id',
    // Common extra fields from Claude Code
    'input', 'output', 'result', 'error', 'status',
]);
// --- Fast-path detection ---
/** Typical camelCase keys that indicate already-normalized input */
const CAMEL_CASE_MARKERS = new Set(['sessionId', 'toolName', 'directory']);
/** Check if any key in the object contains an underscore (snake_case indicator) */
function hasSnakeCaseKeys(obj) {
    for (const key of Object.keys(obj)) {
        if (key.includes('_'))
            return true;
    }
    return false;
}
/** Check if input is already camelCase-normalized and can skip Zod parsing */
function isAlreadyCamelCase(obj) {
    // Must have at least one camelCase marker key
    let hasMarker = false;
    for (const marker of CAMEL_CASE_MARKERS) {
        if (marker in obj) {
            hasMarker = true;
            break;
        }
    }
    if (!hasMarker)
        return false;
    // Must have no snake_case keys
    return !hasSnakeCaseKeys(obj);
}
/**
 * Normalize hook input from Claude Code's snake_case format to the
 * camelCase HookInput interface used internally.
 *
 * Validates the input structure with Zod, then maps snake_case to camelCase.
 * Always reads snake_case first with camelCase fallback, per the
 * project convention documented in MEMORY.md.
 *
 * @param raw - Raw hook input (may be snake_case, camelCase, or mixed)
 * @param hookType - Optional hook type for sensitivity-aware filtering
 */
export function normalizeHookInput(raw, hookType) {
    if (typeof raw !== 'object' || raw === null) {
        return {};
    }
    const rawObj = raw;
    // Fast path: if input is already camelCase, skip Zod parse entirely
    if (isAlreadyCamelCase(rawObj)) {
        return {
            sessionId: rawObj.sessionId,
            toolName: rawObj.toolName,
            toolInput: rawObj.toolInput,
            toolOutput: rawObj.toolOutput ?? rawObj.toolResponse,
            directory: rawObj.directory,
            prompt: rawObj.prompt,
            message: rawObj.message,
            parts: rawObj.parts,
            ...filterPassthrough(rawObj, hookType),
        };
    }
    // Validate with Zod - use safeParse so malformed input doesn't throw
    const parsed = HookInputSchema.safeParse(raw);
    if (!parsed.success) {
        // Log validation issues but don't block - fall through to best-effort mapping
        console.error('[bridge-normalize] Zod validation warning:', parsed.error.issues.map(i => i.message).join(', '));
    }
    const input = (parsed.success ? parsed.data : raw);
    return {
        sessionId: input.session_id ?? input.sessionId,
        toolName: input.tool_name ?? input.toolName,
        toolInput: input.tool_input ?? input.toolInput,
        // tool_response maps to toolOutput for backward compatibility
        toolOutput: input.tool_response ?? input.toolOutput ?? input.toolResponse,
        directory: input.cwd ?? input.directory,
        prompt: input.prompt,
        message: input.message,
        parts: input.parts,
        // Pass through extra fields with sensitivity filtering
        ...filterPassthrough(input, hookType),
    };
}
/**
 * Filter passthrough fields based on hook sensitivity.
 *
 * - Sensitive hooks: only allow KNOWN_FIELDS (drop everything else)
 * - Other hooks: pass through unknown fields with a debug warning
 */
function filterPassthrough(input, hookType) {
    const MAPPED_KEYS = new Set([
        'tool_name', 'toolName',
        'tool_input', 'toolInput',
        'tool_response', 'toolOutput', 'toolResponse',
        'session_id', 'sessionId',
        'cwd', 'directory',
        'hook_event_name', 'hookEventName',
        'prompt', 'message', 'parts',
    ]);
    const isSensitive = hookType != null && SENSITIVE_HOOKS.has(hookType);
    const extra = {};
    for (const [key, value] of Object.entries(input)) {
        if (MAPPED_KEYS.has(key) || value === undefined)
            continue;
        if (isSensitive) {
            // Strict: only allow known fields
            if (KNOWN_FIELDS.has(key)) {
                extra[key] = value;
            }
            // Unknown fields silently dropped for sensitive hooks
        }
        else {
            // Conservative: pass through but warn on truly unknown fields
            extra[key] = value;
            if (!KNOWN_FIELDS.has(key)) {
                console.debug(`[bridge-normalize] Unknown field "${key}" passed through for hook "${hookType ?? 'unknown'}"`);
            }
        }
    }
    return extra;
}
// --- Test helpers (exported for testing only) ---
export { SENSITIVE_HOOKS, KNOWN_FIELDS, isAlreadyCamelCase, HookInputSchema };
//# sourceMappingURL=bridge-normalize.js.map