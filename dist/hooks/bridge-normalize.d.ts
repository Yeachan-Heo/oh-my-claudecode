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
import type { HookInput } from './bridge.js';
/** Schema for the common hook input structure (supports both snake_case and camelCase) */
declare const HookInputSchema: z.ZodObject<{
    tool_name: z.ZodOptional<z.ZodString>;
    tool_input: z.ZodOptional<z.ZodUnknown>;
    tool_response: z.ZodOptional<z.ZodUnknown>;
    session_id: z.ZodOptional<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    hook_event_name: z.ZodOptional<z.ZodString>;
    toolName: z.ZodOptional<z.ZodString>;
    toolInput: z.ZodOptional<z.ZodUnknown>;
    toolOutput: z.ZodOptional<z.ZodUnknown>;
    toolResponse: z.ZodOptional<z.ZodUnknown>;
    sessionId: z.ZodOptional<z.ZodString>;
    directory: z.ZodOptional<z.ZodString>;
    hookEventName: z.ZodOptional<z.ZodString>;
    prompt: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodObject<{
        content: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        content?: string | undefined;
    }, {
        content?: string | undefined;
    }>>;
    parts: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        text: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: string;
        text?: string | undefined;
    }, {
        type: string;
        text?: string | undefined;
    }>, "many">>;
    stop_reason: z.ZodOptional<z.ZodString>;
    stopReason: z.ZodOptional<z.ZodString>;
    user_requested: z.ZodOptional<z.ZodBoolean>;
    userRequested: z.ZodOptional<z.ZodBoolean>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    tool_name: z.ZodOptional<z.ZodString>;
    tool_input: z.ZodOptional<z.ZodUnknown>;
    tool_response: z.ZodOptional<z.ZodUnknown>;
    session_id: z.ZodOptional<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    hook_event_name: z.ZodOptional<z.ZodString>;
    toolName: z.ZodOptional<z.ZodString>;
    toolInput: z.ZodOptional<z.ZodUnknown>;
    toolOutput: z.ZodOptional<z.ZodUnknown>;
    toolResponse: z.ZodOptional<z.ZodUnknown>;
    sessionId: z.ZodOptional<z.ZodString>;
    directory: z.ZodOptional<z.ZodString>;
    hookEventName: z.ZodOptional<z.ZodString>;
    prompt: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodObject<{
        content: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        content?: string | undefined;
    }, {
        content?: string | undefined;
    }>>;
    parts: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        text: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: string;
        text?: string | undefined;
    }, {
        type: string;
        text?: string | undefined;
    }>, "many">>;
    stop_reason: z.ZodOptional<z.ZodString>;
    stopReason: z.ZodOptional<z.ZodString>;
    user_requested: z.ZodOptional<z.ZodBoolean>;
    userRequested: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    tool_name: z.ZodOptional<z.ZodString>;
    tool_input: z.ZodOptional<z.ZodUnknown>;
    tool_response: z.ZodOptional<z.ZodUnknown>;
    session_id: z.ZodOptional<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    hook_event_name: z.ZodOptional<z.ZodString>;
    toolName: z.ZodOptional<z.ZodString>;
    toolInput: z.ZodOptional<z.ZodUnknown>;
    toolOutput: z.ZodOptional<z.ZodUnknown>;
    toolResponse: z.ZodOptional<z.ZodUnknown>;
    sessionId: z.ZodOptional<z.ZodString>;
    directory: z.ZodOptional<z.ZodString>;
    hookEventName: z.ZodOptional<z.ZodString>;
    prompt: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodObject<{
        content: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        content?: string | undefined;
    }, {
        content?: string | undefined;
    }>>;
    parts: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        text: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: string;
        text?: string | undefined;
    }, {
        type: string;
        text?: string | undefined;
    }>, "many">>;
    stop_reason: z.ZodOptional<z.ZodString>;
    stopReason: z.ZodOptional<z.ZodString>;
    user_requested: z.ZodOptional<z.ZodBoolean>;
    userRequested: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough">>;
/** Hooks where unknown fields are dropped (strict allowlist only) */
declare const SENSITIVE_HOOKS: Set<string>;
/** All known camelCase field names the system uses (post-normalization) */
declare const KNOWN_FIELDS: Set<string>;
/** Check if input is already camelCase-normalized and can skip Zod parsing */
declare function isAlreadyCamelCase(obj: Record<string, unknown>): boolean;
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
export declare function normalizeHookInput(raw: unknown, hookType?: string): HookInput;
export { SENSITIVE_HOOKS, KNOWN_FIELDS, isAlreadyCamelCase, HookInputSchema };
//# sourceMappingURL=bridge-normalize.d.ts.map