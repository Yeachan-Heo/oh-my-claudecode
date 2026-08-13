/**
 * Deterministic prompt SSOT composer — epic #3698 / issue #3704.
 *
 * composeProjection(manifest, sections, projectionId, overlay) renders one
 * projection. Given the same manifest + sections + overlay the output text
 * and digest are byte-identical: sections are selected, sorted by
 * (kind rank, manifest-declared order), joined with a single blank line,
 * normalized, and hashed. Overlay sections (provider-delta matching
 * overlay.provider, model-tier-delta matching overlay.modelTier) are data
 * selects, not copied prose.
 */

import { digestProjection, digestSection, normalizePromptText } from './digest.js';
import type {
  ComposeOverlay,
  ComposedProjection,
  PromptSection,
  PromptSsotManifest,
} from './types.js';
import { SECTION_KIND_RANK } from './types.js';

export class PromptSsotError extends Error {}

function overlaySectionId(overlay: ComposeOverlay): string[] {
  const ids: string[] = [];
  if (overlay.provider) ids.push(`provider/${overlay.provider}`);
  if (overlay.modelTier) ids.push(`tier/${overlay.modelTier}`);
  return ids;
}

export function selectSections(
  manifest: PromptSsotManifest,
  sections: readonly PromptSection[],
  projectionId: string,
  overlay: ComposeOverlay = {},
): PromptSection[] {
  const spec = manifest.projections.find((p) => p.id === projectionId);
  if (!spec) throw new PromptSsotError(`unknown projection: ${projectionId}`);

  const byId = new Map(sections.map((s) => [s.id, s]));
  const wanted = [...spec.sections];
  if (spec.acceptsOverlays) wanted.push(...overlaySectionId(overlay));

  const selected: PromptSection[] = [];
  for (const id of wanted) {
    const section = byId.get(id);
    if (!section) throw new PromptSsotError(`projection ${projectionId} references missing section: ${id}`);
    selected.push(section);
  }

  for (const required of manifest.requiredSections) {
    if (!selected.some((s) => s.id === required)) {
      throw new PromptSsotError(
        `projection ${projectionId} is missing required section: ${required}`,
      );
    }
  }

  // Deterministic canonical order: kind rank first, then section id. This is
  // independent of how the manifest lists sections, so composition output
  // never depends on declaration order.
  selected.sort((a, b) => {
    const rankDiff = SECTION_KIND_RANK[a.kind] - SECTION_KIND_RANK[b.kind];
    if (rankDiff !== 0) return rankDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return selected;
}

export function composeProjection(
  manifest: PromptSsotManifest,
  sections: readonly PromptSection[],
  projectionId: string,
  overlay: ComposeOverlay = {},
): ComposedProjection {
  const selected = selectSections(manifest, sections, projectionId, overlay);
  const body = normalizePromptText(selected.map((s) => s.body.trim()).join('\n\n'));
  const digest = digestProjection(body);
  const sectionDigests: Record<string, string> = {};
  for (const s of selected) sectionDigests[s.id] = digestSection(s.id, s.version, s.body);

  const header = [
    '<!-- PROMPT-SSOT:GENERATED',
    `schemaVersion: ${manifest.schemaVersion}`,
    `projection: ${projectionId}`,
    `sourceRevision: ${manifest.sourceRevision}`,
    `overlay.provider: ${overlay.provider ?? 'none'}`,
    `overlay.modelTier: ${overlay.modelTier ?? 'none'}`,
    `sha256: ${digest}`,
    'Regenerate: npm run prompt-ssot:build. Do not edit by hand.',
    '-->',
  ].join('\n');

  return {
    id: projectionId,
    metadata: {
      schemaVersion: 1,
      sourceRevision: manifest.sourceRevision,
      digest,
      overlay,
      sectionDigests,
    },
    body,
    fileText: `${header}\n\n${body}`,
  };
}

/** All declared projections composed with the same overlay. */
export function composeAll(
  manifest: PromptSsotManifest,
  sections: readonly PromptSection[],
  overlay: ComposeOverlay = {},
): ComposedProjection[] {
  return manifest.projections.map((p) => composeProjection(manifest, sections, p.id, overlay));
}
