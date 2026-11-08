/**
 * Prompt projection manifest for #3705.
 * Records deterministic digests for CLAUDE / agent / command / skill
 * projections so builds, installs, and handshakes can be verified.
 *
 * Depends on #3704 composer contract. When #3704's structured sections
 * land, this manifest should consume its normalized section digests
 * instead of raw file hashes. Until then, raw normalized file digests
 * provide parity and migration evidence without blocking.
 */

import { createHash } from 'node:crypto';

export const PROMPT_MANIFEST_SCHEMA_VERSION = 1 as const;

export type PromptProjectionKind = 'claude' | 'agent' | 'command' | 'skill';

export interface PromptProjectionRecord {
  kind: PromptProjectionKind;
  /** Repo-relative POSIX path of canonical source. */
  sourcePath: string;
  /** Repo-relative POSIX path of generated projection (empty when source==output). */
  outputPath: string;
  /** SHA-256 of normalized canonical bytes (LF, no BOM, stable trim). */
  digest: string;
  byteLength: number;
  /** Optional git blob sha for historical parity. */
  gitBlob?: string;
}

export interface PromptProjectionManifest {
  schemaVersion: typeof PROMPT_MANIFEST_SCHEMA_VERSION;
  engineVersion: string;
  /** SHA-256 of normalized canonical CLAUDE body (without version marker). */
  sourceRevision: string;
  generatedAt: string;
  projections: PromptProjectionRecord[];
}

/**
 * Normalize prompt bytes for stable digesting:
 * - LF line endings, strip trailing spaces per line is NOT done (literal),
 *   only normalize CRLF -> LF and ensure single trailing newline.
 * - Preserve BOM handling at decode layer; this normalizer works on string.
 */
export function normalizeForDigest(content: string): string {
  let normalized = content.replace(/\r\n/g, '\n');
  // Ensure exactly one trailing newline for non-empty content
  if (normalized.length > 0 && !normalized.endsWith('\n')) normalized += '\n';
  return normalized;
}

export function computeDigest(content: string): string {
  return createHash('sha256').update(normalizeForDigest(content), 'utf8').digest('hex');
}

export function computeRawDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createManifest(
  engineVersion: string,
  sourceRevision: string,
  projections: PromptProjectionRecord[],
): PromptProjectionManifest {
  const sorted = [...projections].sort((a, b) => {
    const k = a.kind.localeCompare(b.kind);
    if (k !== 0) return k;
    return a.sourcePath.localeCompare(b.sourcePath);
  });
  return {
    schemaVersion: PROMPT_MANIFEST_SCHEMA_VERSION,
    engineVersion,
    sourceRevision,
    generatedAt: new Date().toISOString(),
    projections: sorted,
  };
}

export function validateManifest(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('manifest must be an object');
    return errors;
  }
  const m = value as Record<string, unknown>;
  if (m.schemaVersion !== PROMPT_MANIFEST_SCHEMA_VERSION) errors.push('schemaVersion must be 1');
  if (typeof m.engineVersion !== 'string' || !m.engineVersion.trim()) errors.push('engineVersion must be non-empty');
  if (typeof m.sourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(m.sourceRevision)) errors.push('sourceRevision must be sha256 hex');
  if (typeof m.generatedAt !== 'string' || Number.isNaN(Date.parse(m.generatedAt))) errors.push('generatedAt must be ISO date');
  if (!Array.isArray(m.projections)) errors.push('projections must be an array');
  else {
    for (let i = 0; i < m.projections.length; i++) {
      const r = m.projections[i] as Record<string, unknown>;
      if (!r || typeof r !== 'object') { errors.push(`projections[${i}] must be object`); continue; }
      if (!['claude','agent','command','skill'].includes(String(r.kind))) errors.push(`projections[${i}].kind invalid`);
      if (typeof r.sourcePath !== 'string' || !r.sourcePath) errors.push(`projections[${i}].sourcePath invalid`);
      if (typeof r.outputPath !== 'string') errors.push(`projections[${i}].outputPath invalid`);
      if (typeof r.digest !== 'string' || !/^[a-f0-9]{64}$/.test(r.digest)) errors.push(`projections[${i}].digest invalid`);
      if (typeof r.byteLength !== 'number' || !Number.isSafeInteger(r.byteLength) || r.byteLength < 0) errors.push(`projections[${i}].byteLength invalid`);
    }
  }
  return errors;
}
