/**
 * Payload Size Validation
 *
 * Configurable limits for memory/state write payloads to prevent
 * OOM and disk exhaustion from oversized writes.
 *
 * @see https://github.com/anthropics/claude-code/issues/1169
 */
export interface PayloadLimits {
    /** Maximum serialized JSON size in bytes (default: 1MB) */
    maxPayloadBytes: number;
    /** Maximum object nesting depth (default: 10) */
    maxNestingDepth: number;
    /** Maximum number of keys in the top-level object (default: 100) */
    maxTopLevelKeys: number;
}
export declare const DEFAULT_PAYLOAD_LIMITS: PayloadLimits;
export interface ValidationResult {
    valid: boolean;
    error?: string;
}
/**
 * Validate a payload against configurable size limits.
 *
 * Checks:
 * 1. Serialized JSON byte size
 * 2. Object nesting depth
 * 3. Top-level key count
 */
export declare function validatePayload(payload: unknown, limits?: Partial<PayloadLimits>): ValidationResult;
//# sourceMappingURL=payload-limits.d.ts.map