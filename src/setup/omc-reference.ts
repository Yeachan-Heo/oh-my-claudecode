/**
 * `omc-reference` skill installer.
 *
 * TypeScript port of `install_omc_reference_skill()` from
 * scripts/setup-claude-md.sh:148-175.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface InstallOmcReferenceResult {
  installed: boolean;
  sourceLabel: string | null;
  reason?: string;
}

/**
 * Install the `omc-reference` skill's `SKILL.md` to `skillTargetPath`.
 *
 * Tries `${canonicalPluginRoot}/skills/omc-reference/SKILL.md` first, then
 * falls back to `${CLAUDE_PLUGIN_ROOT}/skills/omc-reference/SKILL.md`. Returns
 * a skip result (no throw) when no source is available or the source is empty.
 * The target's parent directory is created if missing.
 */
export function installOmcReferenceSkill(
  skillTargetPath: string,
  canonicalPluginRoot?: string,
): InstallOmcReferenceResult {
  const candidates: string[] = [];
  if (canonicalPluginRoot) {
    candidates.push(join(canonicalPluginRoot, 'skills', 'omc-reference', 'SKILL.md'));
  }
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (envRoot) {
    candidates.push(join(envRoot, 'skills', 'omc-reference', 'SKILL.md'));
  }

  let sourcePath: string | null = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      sourcePath = candidate;
      break;
    }
  }

  if (!sourcePath) {
    return {
      installed: false,
      sourceLabel: null,
      reason: 'canonical source unavailable',
    };
  }

  let sourceSize = 0;
  try {
    sourceSize = statSync(sourcePath).size;
  } catch {
    sourceSize = 0;
  }
  if (sourceSize === 0) {
    return {
      installed: false,
      sourceLabel: sourcePath,
      reason: 'empty canonical source',
    };
  }

  // Mirror the bash `mktemp + cp + rm` pattern so a partial/failed copy never
  // leaves a half-written SKILL.md behind.
  const tempDir = mkdtempSync(join(tmpdir(), 'omc-reference-skill-'));
  const tempFile = join(tempDir, 'SKILL.md');
  try {
    copyFileSync(sourcePath, tempFile);
    mkdirSync(dirname(skillTargetPath), { recursive: true });
    copyFileSync(tempFile, skillTargetPath);
  } finally {
    try {
      unlinkSync(tempFile);
    } catch {
      /* best-effort cleanup */
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  return { installed: true, sourceLabel: sourcePath };
}
