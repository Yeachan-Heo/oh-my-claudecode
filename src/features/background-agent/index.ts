/**
 * Background Agent Feature
 *
 * Manages background tasks for the OMC multi-agent system.
 * Provides concurrency control and task state management.
 *
 * Adapted from oh-my-opencode's background-agent feature.
 */

export * from './types.js';
export { BackgroundManager, getBackgroundManager, resetBackgroundManager } from './manager.js';
export { ConcurrencyManager } from './concurrency.js';
