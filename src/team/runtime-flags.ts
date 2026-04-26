// src/team/runtime-flags.ts

/**
 * Runtime-v2 is default-on. Explicit falsey opt-out values force legacy v1.
 */
export function isRuntimeV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OMC_RUNTIME_V2;
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(normalized);
}
