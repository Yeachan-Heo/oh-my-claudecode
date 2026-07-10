/**
 * Shared CLAUDE.md merge + legacy pre-marker guide cleanup.
 *
 * This is the single source of truth for merging OMC content into a user's
 * CLAUDE.md. Both the TypeScript installer (`install()`) and the shell setup
 * path (`scripts/setup-claude-md.sh`, via the `merge-claude-md` CLI entry)
 * route through {@link mergeClaudeMd} so the cleanup behavior cannot diverge.
 *
 * The module depends only on `node:crypto` so it bundles standalone for the CLI
 * entry the shell invokes.
 */

import { createHash } from 'node:crypto';

export const OMC_START_MARKER = '<!-- OMC:START -->';
export const OMC_END_MARKER = '<!-- OMC:END -->';
const USER_CUSTOMIZATIONS = '<!-- User customizations -->';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find a marker that appears at the start of a line (line-anchored).
 * This prevents matching markers inside code blocks.
 */
function findLineAnchoredMarker(content: string, marker: string, fromEnd = false): number {
  const regex = new RegExp(`^${escapeRegex(marker)}$`, 'gm');
  if (fromEnd) {
    let lastIndex = -1;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      lastIndex = match.index;
    }
    return lastIndex;
  }
  const match = regex.exec(content);
  return match ? match.index : -1;
}

function createLineAnchoredMarkerRegex(marker: string, flags = 'gm'): RegExp {
  return new RegExp(`^${escapeRegex(marker)}$`, flags);
}

function stripGeneratedUserCustomizationHeaders(content: string): string {
  return content.replace(/^<!-- User customizations(?: \([^)]+\))? -->\r?\n?/gm, '');
}

function trimClaudeUserContent(content: string): string {
  if (content.trim().length === 0) {
    return '';
  }
  return content
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/(?:\r?\n[ \t]*)+$/, '')
    .replace(/(?:\r?\n){3,}/g, '\n\n');
}

// ---------------------------------------------------------------------------
// Structural OMC marker parser (shared by mutation and diagnostic paths)
// ---------------------------------------------------------------------------

export interface OmcMarkerStructure {
  /** Well-formed, non-nested START..END pairs in document order (line indices). */
  blocks: Array<{ start: number; end: number }>;
  /** Structural problems: 'nested-start', 'unmatched-end', 'unmatched-start'. */
  anomalies: string[];
  /** True when there are no structural anomalies at all. */
  wellFormed: boolean;
}

/**
 * Parse OMC markers structurally using whole-line anchoring (never substring
 * `includes`). Validates ordering, pairing and nesting so that both the merge
 * and the doctor diagnostic agree on what a "complete block" is and can fail
 * safe on malformed input.
 */
export function parseOmcMarkerStructure(content: string): OmcMarkerStructure {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Array<{ start: number; end: number }> = [];
  const anomalies: string[] = [];
  let openStart = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === OMC_START_MARKER) {
      if (openStart !== -1) {
        anomalies.push('nested-start');
      } else {
        openStart = i;
      }
    } else if (line === OMC_END_MARKER) {
      if (openStart === -1) {
        anomalies.push('unmatched-end');
      } else {
        blocks.push({ start: openStart, end: i });
        openStart = -1;
      }
    }
  }

  if (openStart !== -1) {
    anomalies.push('unmatched-start');
  }

  return { blocks, anomalies, wellFormed: anomalies.length === 0 };
}

/**
 * Return the content that lives OUTSIDE complete, well-formed OMC marker blocks.
 * Fails safe: on any structural anomaly, nothing is considered "safely inside" a
 * block and the full content is returned (so legacy scans still see hidden
 * content and mutation paths do not delete around malformed markers).
 */
export function contentOutsideCompleteOmcBlocks(content: string): string {
  const structure = parseOmcMarkerStructure(content);
  if (!structure.wellFormed || structure.blocks.length === 0) {
    return content;
  }

  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const removed = new Array<boolean>(lines.length).fill(false);
  for (const block of structure.blocks) {
    for (let i = block.start; i <= block.end; i += 1) {
      removed[i] = true;
    }
  }
  return lines.filter((_line, index) => !removed[index]).join('\n');
}

// ---------------------------------------------------------------------------
// Legacy pre-marker guide detection
// ---------------------------------------------------------------------------

/**
 * Distinctive phrases that appear only in the legacy long-form ("CONDUCTOR")
 * OMC guide and never in the current marker-wrapped template. Used only as a
 * coarse doctor heuristic (which warns for manual review); the installer's
 * strip path relies on exact template matching, not these.
 */
const LEGACY_OMC_FINGERPRINTS = [
  'You are a CONDUCTOR, not a performer',
  'PART 1: CORE PROTOCOL',
  'DELEGATION-FIRST PHILOSOPHY',
  "The difference? You don't NEED them anymore. Everything auto-activates.",
] as const;

const LEGACY_OMC_FINGERPRINT_THRESHOLD = 2;

/** Count how many distinct legacy OMC fingerprints appear in `content`. */
export function countLegacyOmcFingerprints(content: string): number {
  return LEGACY_OMC_FINGERPRINTS.reduce(
    (count, fingerprint) => (content.includes(fingerprint) ? count + 1 : count),
    0
  );
}

/**
 * Opening headings used across the pre-marker eras of the shipped template.
 * A legacy guide always begins with one of these, so they gate the exact-match
 * scan and mark candidate block starts.
 */
const LEGACY_TEMPLATE_HEADINGS = [
  '# oh-my-claudecode - Intelligent Multi-Agent Orchestration',
  '# OMC Multi-Agent System',
  '# Sisyphus Multi-Agent System',
] as const;

export interface LegacyTemplateSignature {
  /** Number of {@link normalizeTemplateLines}-normalized lines in the template. */
  lineCount: number;
  /** SHA-256 of the normalized template lines joined by "\n". */
  sha256: string;
}

/**
 * Fingerprints of every pre-marker `docs/CLAUDE.md` revision in upstream git
 * history (all markerless blobs; the marker mechanism was introduced later).
 * The pre-marker installer wrote one of these guides verbatim into the user's
 * CLAUDE.md, so an exact match against a preserved region is a structural proof
 * that the region is a stale generated guide rather than user-authored text.
 *
 * Normalization is EOL-only (see {@link normalizeTemplateLines}): CRLF/CR -> LF
 * and a single trailing newline dropped. No whitespace is stripped, so any
 * user edit (e.g. Markdown hard-break trailing spaces) makes the region differ
 * from every template and be preserved.
 *
 * This list is kept in sync with the checked-in provenance manifest
 * `src/installer/__tests__/fixtures/legacy-template-manifest.json`; a test
 * asserts they match, and `scripts/generate-legacy-template-manifest.mjs`
 * regenerates both from git history.
 */
export const LEGACY_TEMPLATE_SIGNATURES: readonly LegacyTemplateSignature[] = [
  { lineCount: 168, sha256: "e63ed430c326b64f6673ff1aa2c523ded6432864a05ad96597e930d060fbecb7" }, // df2cf2ed833e "# Sisyphus Multi-Agent System"
  { lineCount: 220, sha256: "8953ef9807e8062480f5ea4a3f5831439ce15067f31a95dc95d0d2270b052c27" }, // 30932adbdce0 "# Sisyphus Multi-Agent System"
  { lineCount: 222, sha256: "97629f1df4008d3d9add680342c6291df1d8305618ac5591173814dceeeb1722" }, // e96516c9b67b "# Sisyphus Multi-Agent System"
  { lineCount: 281, sha256: "00e5c79ec3357a05ed1fbcb6dccf93e573f938bd6720e5e866afe0a33aa981f6" }, // 1e5adf8fc013 "# OMC Multi-Agent System"
  { lineCount: 281, sha256: "d5bc088810c29163d524936c7c82473d248c4e208647a778a1df593bddb59744" }, // 3a564f00865a "# OMC Multi-Agent System"
  { lineCount: 292, sha256: "549e113b71738e73798096ac4be763a609b92c23fdc936680f20099aed28fa1a" }, // 97b83b327b74 "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 292, sha256: "570d03a21582707615690f3987139f401a74ce04307f94238550c2491b99f4e3" }, // 173a9c8d542d "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 296, sha256: "e0d60a7612c32838058ac874d6e1aaf0922842571ab3c01ba9d0db84e18dbe9d" }, // 62706f8b0e5e "# Sisyphus Multi-Agent System"
  { lineCount: 304, sha256: "5e06d427b9681b1af6e48c53e61b93a5abfc2eb873a9fbd50a1fa583bd24f88d" }, // 466569ea4877 "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 304, sha256: "f79797777234b0b2321ac1346a096a216064d6e34a0659de9b13aea12f998783" }, // 26a56e555af3 "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 386, sha256: "730ef988aa6f0c6e7e40224f38531ddf96245f9c4d24b93052bb6d86dc168679" }, // 60f219084886 "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 388, sha256: "70763267fcd0ea35ed5c8eef64cead25ffcdf8c6008c50efd51f9aeaf4525887" }, // 294d68014791 "# Sisyphus Multi-Agent System"
  { lineCount: 395, sha256: "9d317963b8f84231205a1ed4f6744b2fe2b0aeb7833fcddcbe5362b763fdebf7" }, // 95112588b50b "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 411, sha256: "80df71c2efa0e1171b1004ff5cbc1ad098f34b23e9c658a2574f544e8aa66452" }, // 6f005ea35251 "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 417, sha256: "abc8fbcc16cd44cd3bc6916124414b1789eb3eeec1720a0029125bd471e46efc" }, // 9f90998867fb "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 424, sha256: "e3b2c65e66d8169e3dd942bff432e5f419cb41e197ecc4d68812e0a964cb0719" }, // 7e600225d358 "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 429, sha256: "e1f45622c042d007abba9421b9f2c75df1f5eadc0d17a7366e44192b94b22d64" }, // c01f0039651c "# Sisyphus Multi-Agent System"
  { lineCount: 431, sha256: "38be02ee6ee1a4e368f9a5134614bf2ca58faca722ebf451bc4cdfe4f94aeb93" }, // 091f7a4d3313 "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 457, sha256: "0d9234c7026540097d23a4f159f2ee49ba472060b9aee7cf1decb0c3c86fa6e1" }, // 36eb3effcfac "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 457, sha256: "479bcbfc4d04e3e353846e2ca9cc85866b67097b690adedc568636d4143585ff" }, // 4903c785e15e "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 534, sha256: "6469fc2e3b41ec9d9c1000ac8c143b59f9776967fe1d832c1be4d1d4c6e8d926" }, // dc02bf379845 "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 576, sha256: "03ab36b0d233a19195d892ad43e2033ac12b28a44e629196d05345d70069f28b" }, // 9b19d53d59f3 "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 576, sha256: "df301c7263291356005300f4a3175aa806693525d6f2245434bb173141196d54" }, // 7d38a2de5a03 "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 583, sha256: "b0b06eac1cf3ba557f91acc4b93ed2b4ea0ec133a49f84a4d07361f2b9d08c21" }, // afbf9cb29227 "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 659, sha256: "ef1eed15aa9e80372516615a402a28762cc1f611bb0fb3c7d59e74994cb65e3e" }, // f2346c49597d "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 680, sha256: "4ec039bd333c3ad6aecd16c7206731e97e6963e54a138a97379710261d9bdfa8" }, // c75cd527a6fd "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 680, sha256: "c2b6f253f146bbdf80e469751312fea9aecd6900c0d570369d3c285dfdd7f34b" }, // 020424a846f5 "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 718, sha256: "ad7c487773fd21de53dfdeaf40667f7ce37a3979efcaae347b8e30ea2b6525aa" }, // b66ec4a761bc "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
  { lineCount: 720, sha256: "b1bdafcd18b420d6c75c497e5b339ac1114787abb32bee70a418949c0b0580b5" }, // b1e5de1548f3 "# oh-my-claudecode - Intelligent Multi-Agent Orchestration"
];

const LEGACY_TEMPLATE_HASHES: ReadonlySet<string> = new Set(
  LEGACY_TEMPLATE_SIGNATURES.map(signature => signature.sha256)
);

/** Distinct template lengths, longest first (prefer the largest proven block). */
const LEGACY_TEMPLATE_LENGTHS: readonly number[] = [
  ...new Set(LEGACY_TEMPLATE_SIGNATURES.map(signature => signature.lineCount)),
].sort((a, b) => b - a);

/**
 * Split `content` into template-comparison lines. Normalization is EOL-only:
 * CRLF/CR are converted to LF and a single trailing newline is dropped. No
 * whitespace within or around lines is altered, so only a byte-identical
 * (modulo EOL) region can match a historical template.
 */
export function normalizeTemplateLines(content: string): string[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** True when `content` contains a region that exactly matches a known template. */
export function hasLegacyTemplateMatch(content: string): boolean {
  return stripLegacyUnmarkedOmcContent(content) !== content;
}

/**
 * Detect residual legacy pre-marker OMC guidance living OUTSIDE complete,
 * well-formed OMC marker blocks. Used by the doctor diagnostic to warn for
 * manual review. Intentionally broader than the installer's strip: it also
 * flags fingerprinted near-miss variants that exact matching leaves in place.
 */
export function hasLegacyUnmarkedOmcContent(content: string): boolean {
  const outsideMarkers = contentOutsideCompleteOmcBlocks(content);
  return (
    countLegacyOmcFingerprints(outsideMarkers) >= LEGACY_OMC_FINGERPRINT_THRESHOLD ||
    hasLegacyTemplateMatch(outsideMarkers)
  );
}

/**
 * Remove residual legacy (pre-marker) OMC guides from `content`.
 *
 * Removal is proof-based and fails closed: a region is removed only when a
 * contiguous run of lines, starting at a known template heading, matches a
 * recorded historical template byte-for-byte (modulo EOL). Each proven block
 * is removed independently; content between or around blocks is never spanned.
 * Anything that does not match exactly is left untouched.
 */
function stripLegacyUnmarkedOmcContent(content: string): string {
  if (!LEGACY_TEMPLATE_HEADINGS.some(heading => content.includes(heading))) {
    return content;
  }

  const physicalLines = content.replace(/\r\n?/g, '\n').split('\n');
  const total = physicalLines.length;
  const headingSet: ReadonlySet<string> = new Set(LEGACY_TEMPLATE_HEADINGS);
  const removed = new Array<boolean>(total).fill(false);
  let matchedAny = false;

  for (let start = 0; start < total; ) {
    if (!headingSet.has(physicalLines[start])) {
      start += 1;
      continue;
    }

    let matchedLength = 0;
    for (const length of LEGACY_TEMPLATE_LENGTHS) {
      if (start + length > total) {
        continue;
      }
      const window = physicalLines.slice(start, start + length).join('\n');
      if (LEGACY_TEMPLATE_HASHES.has(sha256Hex(window))) {
        matchedLength = length;
        break;
      }
    }

    if (matchedLength > 0) {
      for (let k = start; k < start + matchedLength; k += 1) {
        removed[k] = true;
      }
      matchedAny = true;
      start += matchedLength;
    } else {
      start += 1;
    }
  }

  if (!matchedAny) {
    return content;
  }
  return physicalLines.filter((_line, index) => !removed[index]).join('\n');
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge OMC content into an existing CLAUDE.md using markers.
 * @param existingContent - Existing CLAUDE.md content (null if file doesn't exist)
 * @param omcContent - Canonical OMC content to inject (markers optional)
 * @param version - Version string to stamp in the OMC:VERSION marker
 */
export function mergeClaudeMd(existingContent: string | null, omcContent: string, version?: string): string {
  const START_MARKER = OMC_START_MARKER;
  const END_MARKER = OMC_END_MARKER;
  const markerStartRegex = createLineAnchoredMarkerRegex(START_MARKER);
  const markerEndRegex = createLineAnchoredMarkerRegex(END_MARKER);

  // Idempotency guard: strip markers from omcContent if already present
  // (docs/CLAUDE.md ships with markers).
  let cleanOmcContent = omcContent;
  const omcStartIdx = findLineAnchoredMarker(omcContent, START_MARKER);
  const omcEndIdx = findLineAnchoredMarker(omcContent, END_MARKER, true);
  if (omcStartIdx !== -1 && omcEndIdx !== -1 && omcStartIdx < omcEndIdx) {
    cleanOmcContent = omcContent.substring(omcStartIdx + START_MARKER.length, omcEndIdx).trim();
  }

  // Strip any existing version marker from content and inject current version.
  cleanOmcContent = cleanOmcContent.replace(/<!-- OMC:VERSION:[^\s]*? -->\n?/, '');
  const versionMarker = version ? `<!-- OMC:VERSION:${version} -->\n` : '';

  // Case 1: No existing content - wrap omcContent in markers.
  if (!existingContent) {
    return `${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}\n`;
  }

  const structure = parseOmcMarkerStructure(existingContent);

  // Case 2: Malformed marker structure (unmatched/nested markers). Fail safe:
  // do not strip anything; preserve the whole original file for manual recovery.
  if (!structure.wellFormed) {
    const recoveredContent = existingContent
      .replace(markerStartRegex, '')
      .replace(markerEndRegex, '')
      .trim();
    return `${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}\n\n<!-- User customizations (recovered from corrupted markers) -->\n${recoveredContent}`;
  }

  // Remove complete OMC blocks, then remove residual legacy pre-marker guides,
  // then preserve whatever real user content remains.
  const strippedExistingContent = contentOutsideCompleteOmcBlocks(existingContent);
  const cleanedExistingContent = stripLegacyUnmarkedOmcContent(strippedExistingContent);
  const preservedUserContent = trimClaudeUserContent(
    stripGeneratedUserCustomizationHeaders(cleanedExistingContent)
  );

  if (!preservedUserContent) {
    return `${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}\n`;
  }

  // Case 3: Preserve only user-authored content that lives outside OMC markers.
  return `${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}\n\n${USER_CUSTOMIZATIONS}\n${preservedUserContent}`;
}
