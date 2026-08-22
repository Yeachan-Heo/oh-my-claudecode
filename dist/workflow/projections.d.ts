/**
 * Deterministic registry projections and drift checks — issue #3703.
 *
 * The projection is the read-only public metadata view of the registry
 * (plan §6.1): a canonical-JSON snapshot with schemaVersion, registryVersion,
 * and a SHA-256 digest of the normalized entries. Drift checks compare the
 * registry against the installed surfaces (`skills/*\/SKILL.md`,
 * `commands/*.md`) so a new public surface can never ship unregistered.
 *
 * Adapter seam for #3702: the durable inventory manifest/graph generator is
 * not merged yet. Until it lands, the drift check enumerates installed files
 * directly from the filesystem. `checkProjectionDrift` accepts injected
 * `installed` lists so a future #3702 manifest can replace the filesystem
 * census without changing the comparison logic.
 */
import { type WorkflowEntry } from './registry.js';
/** Stable JSON serialization: object keys sorted recursively, no whitespace. */
export declare function canonicalJson(value: unknown): string;
export declare function sha256Hex(input: string): string;
export interface RegistryProjectionEntry {
    readonly name: string;
    readonly kind: WorkflowEntry['kind'];
    readonly decision: WorkflowEntry['decision'];
    readonly canonicalTarget?: string;
    readonly tier?: 0;
    readonly riskClass: WorkflowEntry['riskClass'];
    readonly owner: string;
    readonly maintainerOnly?: boolean;
    readonly internalOnly?: boolean;
    readonly declaredOnly?: boolean;
    readonly removalMilestone?: string;
}
export interface RegistryProjection {
    readonly schemaVersion: number;
    readonly registryVersion: string;
    readonly entries: readonly RegistryProjectionEntry[];
    /** SHA-256 of the canonical JSON of `entries` (normalized, sorted). */
    readonly digest: string;
}
/**
 * Build the deterministic projection. Entries are sorted by (kind, name) and
 * serialized through canonicalJson, so the digest is stable across processes
 * and independent of source ordering.
 */
export declare function buildRegistryProjection(entries?: readonly WorkflowEntry[]): RegistryProjection;
export declare function computeRegistryDigest(entries?: readonly WorkflowEntry[]): string;
export interface InstalledSurfaces {
    readonly skills: readonly string[];
    readonly commands: readonly string[];
}
/** Enumerate installed surfaces from the repository filesystem (pre-#3702 census). */
export declare function enumerateInstalledSurfaces(repoRoot: string): InstalledSurfaces;
export interface ProjectionDrift {
    readonly ok: boolean;
    /** Installed surfaces with no registry entry. */
    readonly unregistered: readonly string[];
    /** Registered non-declaredOnly entries with no installed file. */
    readonly missing: readonly string[];
}
/**
 * Compare the registry against installed surfaces.
 * - Every installed skill/command MUST be registered (unregistered = drift).
 * - Every registered entry that is not `declaredOnly` SHOULD have an installed
 *   file (missing = drift). `declaredOnly` covers defined Tier-0 targets and
 *   legacy alias names without files.
 */
export declare function checkProjectionDrift(installed: InstalledSurfaces, entries?: readonly WorkflowEntry[]): ProjectionDrift;
//# sourceMappingURL=projections.d.ts.map