/**
 * Exact ownership records for standalone agent files shipped by local v4 release tags.
 *
 * The inventory is generated from each safe top-level agents/*.md path in the local
 * v4.0.0 through v4.15.7 tags. A record authorizes only the exact filename, byte
 * length, and SHA-256 bytes; release tags and the git blob provide audit provenance.
 *
 * Do not replace this with filename, frontmatter, or fuzzy ownership heuristics.
 */
export interface HistoricalAgentOwnership {
    filename: string;
    byteLength: number;
    sha256: string;
    gitBlob: string;
    firstReleaseTag: string;
    lastReleaseTag: string;
}
export declare const HISTORICAL_AGENT_OWNERSHIP: readonly HistoricalAgentOwnership[];
//# sourceMappingURL=historical-agent-ownership.d.ts.map