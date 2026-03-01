/**
 * Verification Tier Selector
 *
 * Scales verification effort with task complexity to optimize cost
 * while maintaining quality. Used by ralph and autopilot.
 */
const TIER_AGENTS = {
    LIGHT: {
        agent: 'architect-low',
        model: 'haiku',
        evidenceRequired: ['lsp_diagnostics clean'],
    },
    STANDARD: {
        agent: 'architect-medium',
        model: 'sonnet',
        evidenceRequired: ['lsp_diagnostics clean', 'build pass'],
    },
    THOROUGH: {
        agent: 'architect',
        model: 'opus',
        evidenceRequired: ['full architect review', 'all tests pass', 'no regressions'],
    },
};
/**
 * Select appropriate verification tier based on change metadata.
 */
export function selectVerificationTier(changes) {
    // Security and architectural changes always require thorough review
    if (changes.hasSecurityImplications || changes.hasArchitecturalChanges) {
        return 'THOROUGH';
    }
    // Large scope changes require thorough review
    if (changes.filesChanged > 20) {
        return 'THOROUGH';
    }
    // Small, well-tested changes can use light verification
    if (changes.filesChanged < 5 &&
        changes.linesChanged < 100 &&
        changes.testCoverage === 'full') {
        return 'LIGHT';
    }
    // Default to standard verification
    return 'STANDARD';
}
/**
 * Get the verification agent configuration for a tier.
 */
export function getVerificationAgent(tier) {
    return TIER_AGENTS[tier];
}
/**
 * Detect if any files represent architectural changes.
 */
export function detectArchitecturalChanges(files) {
    const architecturalPatterns = [
        /config\.(ts|js|json)$/i,
        /schema\.(ts|prisma|sql)$/i,
        /definitions\.ts$/i,
        /(?:^|\/)types\.ts$/i,
        /package\.json$/i,
        /tsconfig\.json$/i,
    ];
    return files.some((file) => architecturalPatterns.some((pattern) => pattern.test(file)));
}
/**
 * Detect if any files have security implications.
 */
export function detectSecurityImplications(files) {
    const securityPatterns = [
        /\/auth\//i, // auth directory
        /\/security\//i, // security directory
        /(^|[\/-])permissions?\.(ts|js)$/i, // permission.ts, permissions.ts
        /(^|[\/-])credentials?\.(ts|js|json)$/i, // credential.ts, credentials.json
        /(^|[\/-])secrets?\.(ts|js|json|ya?ml)$/i, // secret.ts, secrets.yaml
        /(^|[\/-])tokens?\.(ts|js|json)$/i, // token.ts, auth-token.ts
        /\.(env|pem|key)(\.|$)/i, // .env, .env.local, cert.pem, private.key
        /(^|[\/-])passwords?\.(ts|js|json)$/i, // password.ts
        /(^|[\/-])oauth/i, // oauth.ts, oauth-config.ts, oauth2.ts
        /(^|[\/-])jwt/i, // jwt.ts, jwt-utils.ts, jwt_utils.ts
    ];
    return files.some((file) => securityPatterns.some((pattern) => pattern.test(file)));
}
/**
 * Build change metadata from a list of changed files and line count.
 */
export function buildChangeMetadata(files, linesChanged, testCoverage = 'partial') {
    return {
        filesChanged: files.length,
        linesChanged,
        hasArchitecturalChanges: detectArchitecturalChanges(files),
        hasSecurityImplications: detectSecurityImplications(files),
        testCoverage,
    };
}
//# sourceMappingURL=tier-selector.js.map