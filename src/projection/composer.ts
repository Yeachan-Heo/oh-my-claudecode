/**
 * Minimal prompt SSOT composer for #3705.
 * Intended seam for #3704 structured sections.
 *
 * Today: canonical source is docs/CLAUDE.md between OMC markers.
 * Composer renders root/.github CLAUDE projections deterministically
 * and exposes digests for parity checks and file writers.
 *
 * Design notes (per plan 6.2):
 * - Each projection includes schemaVersion, sourceRevision, version marker.
 * - Section deltas (provider/model/role) are future work under #3704.
 * - This module provides the deterministic narrow adapter until that lands.
 */

import { createHash } from 'node:crypto';
import { normalizeForDigest, computeDigest } from './manifest.js';
import { OMC_START_MARKER, OMC_END_MARKER } from '../installer/claude-md-analysis.js';

export const COMPOSER_SCHEMA_VERSION = 1 as const;

export interface ComposerInput {
  /** Canonical docs/CLAUDE.md raw content (with markers + version). */
  canonicalDocsRaw: string;
  /** Package version to stamp in projection header. */
  version: string;
}

export interface ComposedClaudeProjection {
  path: 'CLAUDE.md' | '.github/CLAUDE.md';
  content: string;
  /** Digest of normalized projection body (including markers+version line). */
  digest: string;
}

function extractCanonicalBody(canonicalDocsRaw: string): string {
  const start = canonicalDocsRaw.indexOf(OMC_START_MARKER);
  const end = canonicalDocsRaw.indexOf(OMC_END_MARKER);
  if (start === -1 || end === -1 || end < start) throw new Error('canonical docs missing OMC markers');
  // content between markers exclusive: after START's eol through before END's start
  const startEol = canonicalDocsRaw.indexOf('\n', start);
  if (startEol === -1) throw new Error('malformed start marker');
  let body = canonicalDocsRaw.slice(startEol + 1, end);
  // strip existing version marker if any
  body = body.replace(/<!-- OMC:VERSION:[^\s]*? -->\r?\n?/g, '');
  // ensure trailing newline exactly one
  body = body.replace(/\r\n/g, '\n');
  if (body.length > 0 && !body.endsWith('\n')) body += '\n';
  return body;
}

/**
 * Render a CLAUDE.md projection with the same block structure the
 * claude-md transaction expects: START, VERSION line, body, END.
 */
export function composeManagedBlock(input: ComposerInput): string {
  const body = extractCanonicalBody(input.canonicalDocsRaw);
  return `${OMC_START_MARKER}\n<!-- OMC:VERSION:${input.version} -->\n${body}${OMC_END_MARKER}\n`;
}

/**
 * Normalized sourceRevision for handshake/manifest:
 * digest of the canonical body WITHOUT version marker, LF-normalized.
 */
export function canonicalSourceRevision(canonicalDocsRaw: string): string {
  const body = extractCanonicalBody(canonicalDocsRaw);
  // The body already has one trailing newline; digest it normalized.
  return createHash('sha256').update(normalizeForDigest(body), 'utf8').digest('hex');
}

export function composeAllClaudeProjections(input: ComposerInput): ComposedClaudeProjection[] {
  const content = composeManagedBlock(input);
  const digest = computeDigest(content);
  return [
    { path: 'CLAUDE.md', content, digest },
    { path: '.github/CLAUDE.md', content, digest },
  ];
}
