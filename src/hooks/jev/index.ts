/**
 * Jev judgment points: zero-dependency client, config, resolver seam.
 *
 * Call sites (hooks) consult resolveJudgment only — they never talk to the
 * Jev client directly.
 */

export * from './types.js';
export * from './config.js';
export * from './client.js';
export * from './resolver.js';
export * from './points.js';
