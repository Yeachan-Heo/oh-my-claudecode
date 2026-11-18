export function cleanTextBlock(value: unknown): string;
export function escapeIdentifier(value: unknown, max?: number): string;
export function cleanTextBlockKeeping(value: unknown, identifiers: unknown): string;
export function fitLines(value: unknown, max: number): string;
export function substituteText(value: unknown, pairs: unknown): string;
export function cutText(value: unknown, max: number): string;
export function capText(value: unknown, max: number, whole?: unknown): string;
export const HOOK_OUTPUT_MAX_CHARS: number;
export function cleanHookOutput<T>(output: T, options?: { identifiers?: unknown; substitutions?: unknown; max?: number; whole?: unknown }): T;
