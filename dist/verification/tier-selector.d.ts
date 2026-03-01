/**
 * Verification Tier Selector
 *
 * Scales verification effort with task complexity to optimize cost
 * while maintaining quality. Used by ralph and autopilot.
 */
export interface ChangeMetadata {
    filesChanged: number;
    linesChanged: number;
    hasArchitecturalChanges: boolean;
    hasSecurityImplications: boolean;
    testCoverage: 'none' | 'partial' | 'full';
}
export type VerificationTier = 'LIGHT' | 'STANDARD' | 'THOROUGH';
export interface VerificationAgent {
    agent: string;
    model: 'haiku' | 'sonnet' | 'opus';
    evidenceRequired: string[];
}
/**
 * Select appropriate verification tier based on change metadata.
 */
export declare function selectVerificationTier(changes: ChangeMetadata): VerificationTier;
/**
 * Get the verification agent configuration for a tier.
 */
export declare function getVerificationAgent(tier: VerificationTier): VerificationAgent;
/**
 * Detect if any files represent architectural changes.
 */
export declare function detectArchitecturalChanges(files: string[]): boolean;
/**
 * Detect if any files have security implications.
 */
export declare function detectSecurityImplications(files: string[]): boolean;
/**
 * Build change metadata from a list of changed files and line count.
 */
export declare function buildChangeMetadata(files: string[], linesChanged: number, testCoverage?: 'none' | 'partial' | 'full'): ChangeMetadata;
//# sourceMappingURL=tier-selector.d.ts.map