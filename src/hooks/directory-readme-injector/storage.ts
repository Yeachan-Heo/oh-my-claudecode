/**
 * Directory README Injector Storage
 *
 * Persistent storage for tracking which directory READMEs have been injected per session.
 *
 * Ported from oh-my-opencode's directory-readme-injector hook.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { README_INJECTOR_STORAGE } from './constants.js';
import type { InjectedPathsData } from './types.js';

/**
 * Get storage file path for a session.
 */
function getStoragePath(sessionID: string): string {
  return join(README_INJECTOR_STORAGE, `${sessionID}.json`);
}

/**
 * Load set of injected directory paths for a session.
 */
export function loadInjectedPaths(sessionID: string): Set<string> {
  const filePath = getStoragePath(sessionID);
  if (!existsSync(filePath)) return new Set();

  try {
    const content = readFileSync(filePath, 'utf-8');
    const data: InjectedPathsData = JSON.parse(content);
    return new Set(data.injectedPaths);
  } catch {
    return new Set();
  }
}

/**
 * Save set of injected directory paths for a session.
 */
export function saveInjectedPaths(sessionID: string, paths: Set<string>): void {
  if (!existsSync(README_INJECTOR_STORAGE)) {
    mkdirSync(README_INJECTOR_STORAGE, { recursive: true });
  }

  const data: InjectedPathsData = {
    sessionID,
    injectedPaths: Array.from(paths),
    updatedAt: Date.now(),
  };

  writeFileSync(getStoragePath(sessionID), JSON.stringify(data, null, 2));
}

/**
 * Clear injected paths for a session.
 */
export function clearInjectedPaths(sessionID: string): void {
  const filePath = getStoragePath(sessionID);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}
