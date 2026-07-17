import { type LegacyGuideVariant } from './legacy-claude-md-corpus.js';
/** Decodes valid UTF-8 without silently stripping a leading byte-order mark. */
export declare function decodeClaudeMdUtf8(bytes: Buffer, path: string): string;
export declare const OMC_START_MARKER = "<!-- OMC:START -->";
export declare const OMC_END_MARKER = "<!-- OMC:END -->";
export interface ClaudeMdLine {
    start: number;
    contentEnd: number;
    eolEnd: number;
    text: string;
    eol: '' | '\n' | '\r\n';
}
export interface ClaudeMdRange {
    start: number;
    end: number;
}
export interface ManagedClaudeMdRange extends ClaudeMdRange {
    contentStart: number;
    contentEnd: number;
}
export type MarkerState = 'none' | 'complete' | 'corrupt';
export interface MarkerParseResult {
    state: MarkerState;
    lines: ClaudeMdLine[];
    managedRanges: ManagedClaudeMdRange[];
    outsideRanges: ClaudeMdRange[];
    diagnostics: string[];
    counters: AnalysisCounters;
}
export interface AnalysisCounters {
    lineVisits: number;
    parserSteps: number;
    candidateWindows: number;
    bytesHashed: number;
}
export interface LegacyExactMatch extends ClaudeMdRange {
    variantId: string;
}
export interface LegacyManualFinding extends ClaudeMdRange {
    reason: string;
}
export interface LegacyGuideAnalysis {
    markers: MarkerParseResult;
    exactMatches: LegacyExactMatch[];
    manualFindings: LegacyManualFinding[];
    counters: AnalysisCounters;
}
/** Parse source coordinates without altering any input byte or EOL spelling. */
export declare function parseClaudeMdLines(content: string): ClaudeMdLine[];
/**
 * Parse exact, standalone marker lines. Any ordering, nesting, duplicate, or
 * unmatched marker makes the complete structure corrupt and exposes no ranges.
 */
export declare function parseClaudeMdMarkers(content: string): MarkerParseResult;
/** Exact identity matcher. Only LF/CRLF spelling is normalized; all line content is literal. */
export declare function analyzeLegacyClaudeMd(content: string): LegacyGuideAnalysis;
/** Remove source-coordinate ranges descending so every retained slice is byte-for-byte unchanged. */
export declare function removeClaudeMdRanges(content: string, ranges: readonly ClaudeMdRange[]): string;
export declare function getLegacyGuideManifestForVerification(): readonly LegacyGuideVariant[];
//# sourceMappingURL=claude-md-analysis.d.ts.map