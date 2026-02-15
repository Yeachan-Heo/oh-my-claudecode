/**
 * Rules Storage
 *
 * Persistent storage for tracking injected rules per session.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */

import { SessionJsonStore } from '../../lib/session-json-store.js';
import { RULES_INJECTOR_STORAGE } from './constants.js';
import type { InjectedRulesData } from './types.js';

const store = new SessionJsonStore<InjectedRulesData>({ storageDir: RULES_INJECTOR_STORAGE });

/**
 * Load injected rules for a session.
 */
export function loadInjectedRules(sessionId: string): {
  contentHashes: Set<string>;
  realPaths: Set<string>;
} {
  const data = store.load(sessionId);
  if (!data) {
    return { contentHashes: new Set(), realPaths: new Set() };
  }
  return {
    contentHashes: new Set(data.injectedHashes),
    realPaths: new Set(data.injectedRealPaths ?? []),
  };
}

/**
 * Save injected rules for a session.
 */
export function saveInjectedRules(
  sessionId: string,
  data: { contentHashes: Set<string>; realPaths: Set<string> }
): void {
  const storageData: InjectedRulesData = {
    sessionId,
    injectedHashes: [...data.contentHashes],
    injectedRealPaths: [...data.realPaths],
    updatedAt: Date.now(),
  };
  store.save(sessionId, storageData);
}

/**
 * Clear injected rules for a session.
 */
export function clearInjectedRules(sessionId: string): void {
  store.clear(sessionId);
}
