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

import { createHash } from 'crypto';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  REGISTRY_SCHEMA_VERSION,
  REGISTRY_VERSION,
  WORKFLOW_ENTRIES,
  type WorkflowEntry,
} from './registry.js';

// ---------------------------------------------------------------------------
// Canonical JSON + digest
// ---------------------------------------------------------------------------

/** Stable JSON serialization: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

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

function toProjectionEntry(e: WorkflowEntry): RegistryProjectionEntry {
  return {
    name: e.name,
    kind: e.kind,
    decision: e.decision,
    canonicalTarget: e.canonicalTarget,
    tier: e.tier,
    riskClass: e.riskClass,
    owner: e.owner,
    maintainerOnly: e.maintainerOnly,
    internalOnly: e.internalOnly,
    declaredOnly: e.declaredOnly,
    removalMilestone: e.removalMilestone,
  };
}

/**
 * Build the deterministic projection. Entries are sorted by (kind, name) and
 * serialized through canonicalJson, so the digest is stable across processes
 * and independent of source ordering.
 */
export function buildRegistryProjection(
  entries: readonly WorkflowEntry[] = WORKFLOW_ENTRIES,
): RegistryProjection {
  const projected = entries
    .map(toProjectionEntry)
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    registryVersion: REGISTRY_VERSION,
    entries: projected,
    digest: sha256Hex(canonicalJson(projected)),
  };
}

export function computeRegistryDigest(entries: readonly WorkflowEntry[] = WORKFLOW_ENTRIES): string {
  return buildRegistryProjection(entries).digest;
}

// ---------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------

export interface InstalledSurfaces {
  readonly skills: readonly string[];
  readonly commands: readonly string[];
}

/** Enumerate installed surfaces from the repository filesystem (pre-#3702 census). */
export function enumerateInstalledSurfaces(repoRoot: string): InstalledSurfaces {
  const skillsDir = join(repoRoot, 'skills');
  const commandsDir = join(repoRoot, 'commands');
  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(skillsDir, d.name, 'SKILL.md')))
        .map((d) => d.name)
        .sort()
    : [];
  const commands = existsSync(commandsDir)
    ? readdirSync(commandsDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.md'))
        .map((d) => d.name.replace(/\.md$/, ''))
        .sort()
    : [];
  return { skills, commands };
}

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
export function checkProjectionDrift(
  installed: InstalledSurfaces,
  entries: readonly WorkflowEntry[] = WORKFLOW_ENTRIES,
): ProjectionDrift {
  const registered = new Map<string, WorkflowEntry>(
    entries.map((e) => [`${e.kind}:${e.name}`, e]),
  );
  const unregistered: string[] = [];
  for (const name of installed.skills) {
    if (!registered.has(`skill:${name}`)) unregistered.push(`skill:${name}`);
  }
  for (const name of installed.commands) {
    if (!registered.has(`command:${name}`)) unregistered.push(`command:${name}`);
  }
  const installedSet = new Set([
    ...installed.skills.map((n) => `skill:${n}`),
    ...installed.commands.map((n) => `command:${n}`),
  ]);
  const missing: string[] = [];
  for (const e of entries) {
    if (e.declaredOnly) continue;
    const key = `${e.kind}:${e.name}`;
    if (!installedSet.has(key)) missing.push(key);
  }
  return { ok: unregistered.length === 0 && missing.length === 0, unregistered, missing };
}
