/**
 * HUD element config writer — merges a partial HudElementConfig patch into
 * `<configDir>/.omc-config.json` under the `hud.elements` key.
 *
 * Preserves any existing top-level keys in `.omc-config.json` (e.g.
 * `setupVersion`, `setupCompleted`, `executionMode`) via `mergeJsonShallow`
 * — we only rewrite the single `hud` key, and within that key we shallow-
 * merge `elements` so unrelated HUD settings the user might have authored
 * are retained.
 *
 * Called from phase 4 when `options.hud?.elements` is present. Also usable
 * standalone for tests or external scripts.
 */

import { join } from 'node:path';
import { getClaudeConfigDir } from '../utils/config-dir.js';
import {
  mergeJsonShallow,
  readJsonSafe,
} from './config-writer.js';
import type { HudElementConfig } from '../hud/types.js';

export interface WriteHudConfigOptions {
  /** Override the config directory. Defaults to `getClaudeConfigDir()`. */
  configDir?: string;
}

interface OmcConfigFile {
  hud?: {
    elements?: Partial<HudElementConfig>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Shallow-merge `elements` into `<configDir>/.omc-config.json`'s
 * `hud.elements` object. Creates the file if missing; preserves all other
 * top-level keys and unrelated `hud.*` sub-keys.
 *
 * Safe to call with an empty patch (no-op write that still normalizes the
 * file to its current on-disk form).
 */
export function writeHudConfig(
  elements: Partial<HudElementConfig>,
  opts: WriteHudConfigOptions = {},
): void {
  const dir = opts.configDir ?? getClaudeConfigDir();
  const path = join(dir, '.omc-config.json');

  // Read existing file to preserve any non-HUD hud.* sub-keys and merge
  // `hud.elements` rather than replacing the whole `hud` object.
  const existing = readJsonSafe<OmcConfigFile>(path) ?? {};
  const existingHud =
    existing.hud && typeof existing.hud === 'object' && !Array.isArray(existing.hud)
      ? existing.hud
      : {};
  const existingElements =
    existingHud.elements &&
    typeof existingHud.elements === 'object' &&
    !Array.isArray(existingHud.elements)
      ? existingHud.elements
      : {};

  const mergedHud = {
    ...existingHud,
    elements: {
      ...existingElements,
      ...elements,
    },
  };

  // mergeJsonShallow re-reads the file before writing so concurrent writers
  // during phase 4 (e.g. completeSetup) don't clobber our patch. Passing
  // only `{ hud: mergedHud }` shallow-merges at the top level: unknown keys
  // already in the file are kept as-is.
  mergeJsonShallow(path, { hud: mergedHud });
}
