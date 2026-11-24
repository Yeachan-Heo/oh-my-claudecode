/**
 * Payload Size Validation
 *
 * Configurable limits for memory/state write payloads to prevent
 * OOM and disk exhaustion from oversized writes.
 *
 * @see https://github.com/anthropics/claude-code/issues/1169
 */
export const DEFAULT_PAYLOAD_LIMITS = {
    maxPayloadBytes: 1_048_576, // 1MB
    maxNestingDepth: 10,
    maxTopLevelKeys: 100,
};
/**
 * Measure the nesting depth of a value.
 * Returns 0 for primitives, 1 for flat objects/arrays, etc.
 */
function measureDepth(value, current = 0, maxAllowed) {
    if (current > maxAllowed)
        return current; // short-circuit
    if (value !== null && typeof value === 'object') {
        const entries = Array.isArray(value) ? value : Object.values(value);
        let max = current + 1;
        for (const entry of entries) {
            const d = measureDepth(entry, current + 1, maxAllowed);
            if (d > max)
                max = d;
            if (max > maxAllowed)
                return max; // short-circuit
        }
        return max;
    }
    return current;
}
/**
 * Validate a payload against configurable size limits.
 *
 * Checks:
 * 1. Serialized JSON byte size
 * 2. Object nesting depth
 * 3. Top-level key count
 */
export function validatePayload(payload, limits = {}) {
    const resolved = { ...DEFAULT_PAYLOAD_LIMITS, ...limits };
    // 1. Top-level key count (only for objects)
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
        const keyCount = Object.keys(payload).length;
        if (keyCount > resolved.maxTopLevelKeys) {
            return {
                valid: false,
                error: `Payload has ${keyCount} top-level keys (max: ${resolved.maxTopLevelKeys})`,
            };
        }
    }
    // 2. Nesting depth
    const depth = measureDepth(payload, 0, resolved.maxNestingDepth);
    if (depth > resolved.maxNestingDepth) {
        return {
            valid: false,
            error: `Payload nesting depth ${depth} exceeds maximum of ${resolved.maxNestingDepth}`,
        };
    }
    // 3. Serialized byte size
    let serialized;
    try {
        serialized = JSON.stringify(payload);
    }
    catch {
        return { valid: false, error: 'Payload cannot be serialized to JSON' };
    }
    if (typeof serialized !== 'string') {
        return { valid: false, error: 'Payload cannot be serialized to JSON' };
    }
    const byteSize = Buffer.byteLength(serialized, 'utf-8');
    if (byteSize > resolved.maxPayloadBytes) {
        const sizeMB = (byteSize / 1_048_576).toFixed(2);
        const limitMB = (resolved.maxPayloadBytes / 1_048_576).toFixed(2);
        return {
            valid: false,
            error: `Payload size ${sizeMB}MB exceeds maximum of ${limitMB}MB`,
        };
    }
    return { valid: true };
}
//# sourceMappingURL=payload-limits.js.map