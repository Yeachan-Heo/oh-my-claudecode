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

export const DEFAULT_PAYLOAD_LIMITS: PayloadLimits = {
  maxPayloadBytes: 1_048_576, // 1MB
  maxNestingDepth: 10,
  maxTopLevelKeys: 100,
};

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Measure the nesting depth of a value.
 * Returns 0 for primitives, 1 for flat objects/arrays, etc.
 */
function measureDepth(value: unknown, current: number = 0, maxAllowed: number): number {
  if (current > maxAllowed) return current; // short-circuit

  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    let max = current + 1;
    for (const entry of entries) {
      const d = measureDepth(entry, current + 1, maxAllowed);
      if (d > max) max = d;
      if (max > maxAllowed) return max; // short-circuit
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
export function validatePayload(
  payload: unknown,
  limits: Partial<PayloadLimits> = {},
): ValidationResult {
  const resolved: PayloadLimits = { ...DEFAULT_PAYLOAD_LIMITS, ...limits };

  // 1. Top-level key count (only for objects)
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const keyCount = Object.keys(payload as Record<string, unknown>).length;
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
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
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
