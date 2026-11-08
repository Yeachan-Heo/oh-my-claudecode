/** Static reviewed legacy guide signatures; no runtime filesystem, Git, or network access. */
export interface LegacyGuideVariant {
    id: string;
    sourceCommit: string;
    markerless: true;
    gitBlobSha: string;
    rawByteLength: number;
    rawSha256: string;
    normalizedSha256: string;
    lineCount: number;
    terminalEolPolicy: 'required' | 'forbidden' | 'either';
    openingLine: string;
    finalLine: string;
}
export declare const LEGACY_CLAUDE_MD_VARIANTS: readonly LegacyGuideVariant[];
//# sourceMappingURL=legacy-claude-md-corpus.d.ts.map