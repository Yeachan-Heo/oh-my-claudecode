import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import { withStateFileMutationLock } from '../lib/mode-state-io.js';
import { resolveSessionStatePaths } from '../lib/worktree-paths.js';
import { graphPlatform, type GraphPlatformAdapter } from './platform.js';
import type {
  ControlChildRegistration,
  ControlLineageIdentity,
  ControlOwnerState,
  ControlRoot,
  GraphClaimLineage,
  GraphControlMode,
  GraphDriverLease,
  GraphProcessIdentity,
} from './runtime-types.js';

const CONTROL_MAX_BYTES = 1024 * 1024;
const ROOT_MODES: readonly GraphControlMode[] = [
  'graph',
  'autopilot',
  'autoresearch',
  'ralph',
  'team',
  'ultrawork',
  'ultraqa',
  'ralplan',
  'deep-interview',
  'self-improve',
];
const NON_OWNER_MODES = new Set(['merge-readiness', 'skill-active', 'support', 'read-only']);

export type ControlModeClassification = 'root' | 'non_owner' | 'unknown';

export function classifyControlMode(mode: string): ControlModeClassification {
  if ((ROOT_MODES as readonly string[]).includes(mode)) return 'root';
  if (NON_OWNER_MODES.has(mode)) return 'non_owner';
  return 'unknown';
}

export class ControlOwnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ControlOwnerError';
    this.code = code;
  }
}

export interface ControlOwnerDependencies {
  fileExists(path: string): boolean;
  readText(path: string): string;
  writeAtomic(path: string, value: unknown): void;
  withExclusiveLock<T>(path: string, callback: () => T): { acquired: boolean; value: T | undefined };
}

export interface ControlOwnerStoreOptions {
  sessionId: string;
  worktreeRoot?: string;
  platform?: GraphPlatformAdapter;
  dependencies?: Partial<ControlOwnerDependencies>;
}

const DEFAULT_DEPENDENCIES: ControlOwnerDependencies = {
  fileExists: existsSync,
  readText: (path) => readFileSync(path, 'utf8'),
  writeAtomic: atomicWriteJsonSync,
  withExclusiveLock: (path, callback) => withStateFileMutationLock(path, callback, true),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ControlOwnerError('malformed_control', `${name} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[], name: string): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !(key in value));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new ControlOwnerError(
      'malformed_control',
      `${name} has invalid keys${missing.length ? `; missing ${missing.join(', ')}` : ''}${unknown.length ? `; unknown ${unknown.join(', ')}` : ''}`,
    );
  }
}

function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ControlOwnerError('malformed_control', `${name} must be a non-empty bounded string`);
  }
  return value;
}

function timestamp(value: unknown, name: string): string {
  const result = text(value, name, 64);
  if (!Number.isFinite(Date.parse(result))) {
    throw new ControlOwnerError('malformed_control', `${name} must be an ISO timestamp`);
  }
  return result;
}

function mode(value: unknown, name: string): GraphControlMode {
  const result = text(value, name, 32);
  if (classifyControlMode(result) !== 'root') {
    throw new ControlOwnerError('unknown_mode', `${name} is not a canonical root-capable mode`);
  }
  return result as GraphControlMode;
}

function processIdentity(value: unknown, name: string): GraphProcessIdentity {
  const identity = record(value, name);
  exactKeys(identity, ['pid', 'process_start'], [], name);
  if (!Number.isSafeInteger(identity.pid) || (identity.pid as number) <= 0) {
    throw new ControlOwnerError('malformed_control', `${name}.pid is invalid`);
  }
  // process_start may be the empty string when the host could not capture a
  // start time at reservation time (ps/powershell/proc unavailable once). The
  // runtime functions with pid-only identity - isProcessIdentityLive() falls
  // back to pid-only liveness - so the empty form is accepted here. Rejecting
  // it would make every subsequent read() reject the reserved control state as
  // malformed_control, permanently wedging control authority.
  if (typeof identity.process_start !== 'string' || !/^\d*$/.test(identity.process_start)) {
    throw new ControlOwnerError('malformed_control', `${name}.process_start is invalid`);
  }
  return value as GraphProcessIdentity;
}

function driverLease(value: unknown, name: string): GraphDriverLease {
  const lease = record(value, name);
  exactKeys(lease, ['driver_instance_id', 'lease_id', 'expires_at'], [], name);
  text(lease.driver_instance_id, `${name}.driver_instance_id`, 128);
  text(lease.lease_id, `${name}.lease_id`, 128);
  timestamp(lease.expires_at, `${name}.expires_at`);
  return value as GraphDriverLease;
}

function lineage(value: unknown, name: string): ControlLineageIdentity {
  const identity = record(value, name);
  exactKeys(identity, ['mode', 'session_id', 'run_id'], [], name);
  return {
    mode: mode(identity.mode, `${name}.mode`),
    session_id: text(identity.session_id, `${name}.session_id`),
    run_id: text(identity.run_id, `${name}.run_id`, 128),
  };
}

function claimLineage(value: unknown, name: string): GraphClaimLineage {
  const claim = record(value, name);
  exactKeys(claim, [
    'activation_id', 'attempt_id', 'lease_id', 'revision_id', 'revision_hash', 'dispatch_generation',
  ], [], name);
  for (const key of ['activation_id', 'attempt_id', 'lease_id', 'revision_id'] as const) {
    text(claim[key], `${name}.${key}`, 128);
  }
  if (typeof claim.revision_hash !== 'string' || !/^[a-f0-9]{64}$/.test(claim.revision_hash)) {
    throw new ControlOwnerError('malformed_control', `${name}.revision_hash is invalid`);
  }
  if (!Number.isSafeInteger(claim.dispatch_generation) || (claim.dispatch_generation as number) < 0) {
    throw new ControlOwnerError('malformed_control', `${name}.dispatch_generation is invalid`);
  }
  return value as GraphClaimLineage;
}

function graphRevision(value: unknown, name: string): { revision_id: string; revision_hash: string } {
  const revision = record(value, name);
  exactKeys(revision, ['revision_id', 'revision_hash'], [], name);
  const revisionId = text(revision.revision_id, `${name}.revision_id`, 128);
  if (typeof revision.revision_hash !== 'string' || !/^[a-f0-9]{64}$/.test(revision.revision_hash)) {
    throw new ControlOwnerError('malformed_control', `${name}.revision_hash is invalid`);
  }
  return { revision_id: revisionId, revision_hash: revision.revision_hash };
}

function childRegistration(value: unknown, name: string): ControlChildRegistration {
  const child = record(value, name);
  exactKeys(child, ['mode', 'session_id', 'run_id', 'parent', 'registered_at'], ['graph_claim'], name);
  const identity = lineage(
    { mode: child.mode, session_id: child.session_id, run_id: child.run_id },
    name,
  );
  const parent = lineage(child.parent, `${name}.parent`);
  timestamp(child.registered_at, `${name}.registered_at`);
  return {
    ...identity,
    parent,
    ...(child.graph_claim === undefined ? {} : { graph_claim: claimLineage(child.graph_claim, `${name}.graph_claim`) }),
    registered_at: child.registered_at as string,
  };
}

function identityKey(identity: ControlLineageIdentity): string {
  return `${identity.mode}\0${identity.session_id}\0${identity.run_id}`;
}

function sameIdentity(left: ControlLineageIdentity, right: ControlLineageIdentity): boolean {
  return identityKey(left) === identityKey(right);
}

function parseControlOwnerState(value: unknown, expectedSessionId?: string): ControlOwnerState {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > CONTROL_MAX_BYTES) {
    throw new ControlOwnerError('control_too_large', 'Control owner state exceeds the configured bound');
  }
  const state = record(value, 'control state');
  exactKeys(state, ['format_version', 'session_id', 'generation', 'root', 'updated_at'], ['last_release'], 'control state');
  if (state.format_version !== 1) throw new ControlOwnerError('malformed_control', 'Unsupported control format version');
  const sessionId = text(state.session_id, 'control state.session_id');
  if (expectedSessionId && sessionId !== expectedSessionId) {
    throw new ControlOwnerError('session_mismatch', 'Control state belongs to a different session');
  }
  if (!Number.isSafeInteger(state.generation) || (state.generation as number) < 0) {
    throw new ControlOwnerError('malformed_control', 'Control generation is invalid');
  }
  timestamp(state.updated_at, 'control state.updated_at');
  if (state.last_release !== undefined) {
    const release = record(state.last_release, 'control state.last_release');
    exactKeys(release, ['mode', 'run_id', 'nonce', 'disposition', 'released_at'], [], 'control state.last_release');
    mode(release.mode, 'control state.last_release.mode');
    text(release.run_id, 'control state.last_release.run_id', 128);
    text(release.nonce, 'control state.last_release.nonce', 128);
    if (release.disposition !== 'paused' && release.disposition !== 'terminal') {
      throw new ControlOwnerError('malformed_control', 'Control release disposition is invalid');
    }
    timestamp(release.released_at, 'control state.last_release.released_at');
  }
  if (state.root === null) return structuredClone(value as ControlOwnerState);

  const root = record(state.root, 'control state.root');
  exactKeys(root, [
    'mode', 'session_id', 'run_id', 'nonce', 'phase', 'reservation_process',
    'children', 'created_at', 'updated_at',
  ], ['driver_lease', 'graph_revision'], 'control state.root');
  const rootIdentity = lineage({ mode: root.mode, session_id: root.session_id, run_id: root.run_id }, 'control state.root');
  if (rootIdentity.session_id !== sessionId) {
    throw new ControlOwnerError('session_mismatch', 'Control root session does not match its state file');
  }
  text(root.nonce, 'control state.root.nonce', 128);
  if (root.phase !== 'reserved' && root.phase !== 'active') {
    throw new ControlOwnerError('malformed_control', 'Control root phase is invalid');
  }
  processIdentity(root.reservation_process, 'control state.root.reservation_process');
  if (root.driver_lease !== undefined) driverLease(root.driver_lease, 'control state.root.driver_lease');
  if (rootIdentity.mode === 'graph') {
    if (root.graph_revision === undefined) {
      throw new ControlOwnerError('malformed_control', 'Graph control root requires an exact revision/hash fence');
    }
    graphRevision(root.graph_revision, 'control state.root.graph_revision');
  } else if (root.graph_revision !== undefined) {
    throw new ControlOwnerError('malformed_control', 'Only Graph control roots may carry graph_revision');
  }
  timestamp(root.created_at, 'control state.root.created_at');
  timestamp(root.updated_at, 'control state.root.updated_at');
  if (!Array.isArray(root.children) || root.children.length > 128) {
    throw new ControlOwnerError('malformed_control', 'Control child registrations are invalid');
  }
  const children = root.children.map((child, index) => childRegistration(child, `control state.root.children[${index}]`));
  const identities = new Set([identityKey(rootIdentity)]);
  for (const child of children) {
    if (identities.has(identityKey(child))) throw new ControlOwnerError('duplicate_child', 'Control child identity is duplicated');
    if (!identities.has(identityKey(child.parent))) {
      throw new ControlOwnerError('lineage_mismatch', 'Control child parent is not reachable from the root');
    }
    if (!allowedChild(child.parent.mode, child.mode)) {
      throw new ControlOwnerError('lineage_rejected', `Stored ${child.parent.mode} -> ${child.mode} lineage is not allowed`);
    }
    if (child.parent.mode === 'graph' && (!child.graph_claim || child.mode !== 'team')) {
      throw new ControlOwnerError('graph_claim_required', 'Stored Graph child requires exact Team claim lineage');
    }
    if (child.parent.mode !== 'graph' && child.graph_claim) {
      throw new ControlOwnerError('graph_claim_unexpected', 'Stored non-Graph child cannot carry graph claim lineage');
    }
    identities.add(identityKey(child));
  }
  return structuredClone(value as ControlOwnerState);
}

function allowedChild(parentMode: GraphControlMode, childMode: GraphControlMode): boolean {
  if (parentMode === 'autopilot') {
    return ['ralph', 'team', 'ultrawork', 'ultraqa', 'ralplan', 'deep-interview'].includes(childMode);
  }
  if (parentMode === 'ralph') return ['team', 'ultrawork', 'ultraqa', 'ralplan'].includes(childMode);
  return parentMode === 'graph' && childMode === 'team';
}

export interface ReserveRootInput {
  mode: GraphControlMode;
  run_id: string;
  nonce: string;
  reserved_at: string;
  graph_revision?: { revision_id: string; revision_hash: string };
}

export interface PromoteRootInput {
  mode: GraphControlMode;
  run_id: string;
  nonce: string;
  promoted_at: string;
  driver_lease: GraphDriverLease;
}

export interface RegisterChildInput extends Omit<ControlChildRegistration, 'registered_at'> {
  registered_at: string;
}

export interface GraphReleaseDisposition {
  graph_status: 'paused' | 'failed' | 'cancelled' | 'succeeded';
  claims_fenced: boolean;
  children_drained: boolean;
}

export interface ReleaseRootInput {
  mode: GraphControlMode;
  run_id: string;
  nonce: string;
  disposition: GraphReleaseDisposition;
  released_at: string;
}

export interface LegacyControlCandidate {
  mode: GraphControlMode;
  session_id?: string;
  run_id?: string;
  active: boolean;
  terminal?: boolean;
  parent?: ControlLineageIdentity;
  linked_ultrawork?: boolean;
  linked_to_ralph?: boolean;
  graph_revision?: { revision_id: string; revision_hash: string };
  graph_claim?: GraphClaimLineage;
}

export interface AdoptLegacyRootsInput {
  candidates: LegacyControlCandidate[];
  nonce: string;
  adopted_at: string;
}

export class ControlOwnerStore {
  readonly sessionId: string;
  readonly worktreeRoot: string | undefined;
  readonly path: string;
  private readonly readPath: string;
  private readonly platform: GraphPlatformAdapter;
  private readonly dependencies: ControlOwnerDependencies;

  constructor(options: ControlOwnerStoreOptions) {
    const paths = resolveSessionStatePaths('control-owner', options.sessionId, options.worktreeRoot);
    if (!paths.sessionScoped || paths.effectiveWrite !== paths.sessionScoped) {
      throw new ControlOwnerError('unsafe_state_path', 'Control ownership requires an explicit session-scoped path');
    }
    this.sessionId = options.sessionId;
    this.worktreeRoot = options.worktreeRoot;
    this.path = paths.effectiveWrite;
    this.readPath = paths.sessionScoped;
    this.platform = options.platform ?? graphPlatform;
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  }

  read(): ControlOwnerState | null {
    if (!this.dependencies.fileExists(this.readPath)) return null;
    let value: unknown;
    try {
      value = JSON.parse(this.dependencies.readText(this.readPath));
    } catch (error) {
      throw new ControlOwnerError('malformed_control', `Cannot parse control-owner-state.json: ${String(error)}`);
    }
    return parseControlOwnerState(value, this.sessionId);
  }

  reserveRoot(input: ReserveRootInput): ControlOwnerState {
    const owner = this.platform.preflight();
    timestamp(input.reserved_at, 'reserved_at');
    if (input.mode === 'graph' && !input.graph_revision) {
      throw new ControlOwnerError('graph_revision_required', 'Graph reservation requires an exact revision/hash fence');
    }
    if (input.mode !== 'graph' && input.graph_revision) {
      throw new ControlOwnerError('graph_revision_unexpected', 'Only Graph reservations may carry graph_revision');
    }
    return this.mutate((current) => {
      if (current?.root) {
        throw new ControlOwnerError('root_conflict', `Session is already controlled by ${current.root.mode}/${current.root.run_id}`);
      }
      const root: ControlRoot = {
        mode: input.mode,
        session_id: this.sessionId,
        run_id: text(input.run_id, 'run_id', 128),
        nonce: text(input.nonce, 'nonce', 128),
        phase: 'reserved',
        reservation_process: owner,
        ...(input.graph_revision ? { graph_revision: graphRevision(input.graph_revision, 'graph_revision') } : {}),
        children: [],
        created_at: input.reserved_at,
        updated_at: input.reserved_at,
      };
      return {
        format_version: 1,
        session_id: this.sessionId,
        generation: (current?.generation ?? 0) + 1,
        root,
        ...(current?.last_release ? { last_release: current.last_release } : {}),
        updated_at: input.reserved_at,
      };
    });
  }

  promoteRoot(input: PromoteRootInput): ControlOwnerState {
    timestamp(input.promoted_at, 'promoted_at');
    driverLease(input.driver_lease, 'driver_lease');
    return this.mutate((current) => {
      const root = this.requireExactRoot(current, input);
      if (root.phase !== 'reserved') throw new ControlOwnerError('already_active', 'Control root is already active');
      return this.withRoot(current!, {
        ...root,
        phase: 'active',
        driver_lease: structuredClone(input.driver_lease),
        updated_at: input.promoted_at,
      }, input.promoted_at);
    });
  }

  registerChild(input: RegisterChildInput): ControlOwnerState {
    timestamp(input.registered_at, 'registered_at');
    return this.mutate((current) => {
      if (!current?.root || current.root.phase !== 'active') {
        throw new ControlOwnerError('root_inactive', 'Child registration requires an active root');
      }
      const child = childRegistration(input, 'child registration');
      if (current.root.children.some((candidate) => sameIdentity(candidate, child))) {
        throw new ControlOwnerError('duplicate_child', 'Child identity is already registered');
      }
      const parent = sameIdentity(current.root, child.parent)
        ? current.root
        : current.root.children.find((candidate) => sameIdentity(candidate, child.parent));
      if (!parent) throw new ControlOwnerError('parent_lineage_mismatch', 'Exact parent lineage is not registered');
      if (!allowedChild(parent.mode, child.mode)) {
        throw new ControlOwnerError('lineage_rejected', `${parent.mode} -> ${child.mode} lineage is not allowed`);
      }
      if (parent.mode === 'graph' && (!child.graph_claim || child.mode !== 'team')) {
        throw new ControlOwnerError('graph_claim_required', 'Graph permits only Team with an exact agent-node claim lineage');
      }
      if (parent.mode !== 'graph' && child.graph_claim) {
        throw new ControlOwnerError('graph_claim_unexpected', 'Graph claim lineage is only valid for Graph -> Team');
      }
      return this.withRoot(current, {
        ...current.root,
        children: [...current.root.children, child],
        updated_at: input.registered_at,
      }, input.registered_at);
    });
  }

  releaseRoot(input: ReleaseRootInput): { state: ControlOwnerState | null; released: boolean } {
    timestamp(input.released_at, 'released_at');
    let released = false;
    const state = this.mutate((current) => {
      if (!current?.root
        || current.root.mode !== input.mode
        || current.root.run_id !== input.run_id
        || current.root.nonce !== input.nonce) return current ?? this.emptyState(input.released_at);
      if (!input.disposition.children_drained || current.root.children.length > 0) {
        throw new ControlOwnerError('children_live', 'Control release requires all exact children to be drained');
      }
      if (input.mode === 'graph' && input.disposition.graph_status === 'paused' && !input.disposition.claims_fenced) {
        throw new ControlOwnerError('claims_live', 'Paused Graph release requires all claims to be fenced');
      }
      released = true;
      return {
        ...current,
        generation: current.generation + 1,
        root: null,
        last_release: {
          mode: input.mode,
          run_id: input.run_id,
          nonce: input.nonce,
          disposition: input.disposition.graph_status === 'paused' ? 'paused' : 'terminal',
          released_at: input.released_at,
        },
        updated_at: input.released_at,
      };
    }, false);
    return { state, released };
  }

  reservePausedGraph(input: {
    run_id: string;
    revision_id: string;
    revision_hash: string;
    nonce: string;
    graph_state: { session_id: string; run_id: string; revision_id: string; status: 'paused' };
    reserved_at: string;
  }): ControlOwnerState {
    if (input.graph_state.session_id !== this.sessionId
      || input.graph_state.run_id !== input.run_id
      || input.graph_state.revision_id !== input.revision_id
      || input.graph_state.status !== 'paused') {
      throw new ControlOwnerError('resume_mismatch', 'Resume requires the exact paused session/run/revision');
    }
    return this.reserveRoot({
      mode: 'graph', run_id: input.run_id, nonce: input.nonce, reserved_at: input.reserved_at,
      graph_revision: { revision_id: input.revision_id, revision_hash: input.revision_hash },
    });
  }

  recoverGraphReservation(input: {
    session_id: string;
    run_id: string;
    revision_id: string;
    revision_hash: string;
    status: 'draft' | 'awaiting_approval' | 'running' | 'waiting_human' | 'waiting_patch_approval' | 'reconciling' | 'paused' | 'failed' | 'cancelled' | 'succeeded';
    reservation_nonce: string;
    observed_at: string;
    driver_lease: GraphDriverLease;
  }): { state: ControlOwnerState; action: 'promoted' | 'released' | 'waiting' | 'already_active' } {
    timestamp(input.observed_at, 'observed_at');
    driverLease(input.driver_lease, 'driver_lease');
    let action: 'promoted' | 'released' | 'waiting' | 'already_active' = 'waiting';
    const state = this.mutate((current) => {
      const root = this.requireExactRoot(current, {
        mode: 'graph', run_id: input.run_id, nonce: input.reservation_nonce,
      });
      if (input.session_id !== this.sessionId) {
        throw new ControlOwnerError('session_mismatch', 'Graph recovery session does not match control authority');
      }
      if (!root.graph_revision
        || root.graph_revision.revision_id !== input.revision_id
        || root.graph_revision.revision_hash !== input.revision_hash) {
        throw new ControlOwnerError('revision_mismatch', 'Graph recovery revision/hash does not match the reservation');
      }
      if (root.phase === 'active') {
        action = 'already_active';
        return current!;
      }
      const live = this.platform.isProcessIdentityLive(root.reservation_process);
      if (live === 'unknown') throw new ControlOwnerError('owner_unverifiable', 'Reservation process identity is unverifiable');
      if (live) {
        action = 'waiting';
        return current!;
      }
      if (['failed', 'cancelled', 'succeeded'].includes(input.status)) {
        action = 'released';
        return {
          ...current!,
          generation: current!.generation + 1,
          root: null,
          last_release: {
            mode: 'graph', run_id: input.run_id, nonce: input.reservation_nonce,
            disposition: 'terminal', released_at: input.observed_at,
          },
          updated_at: input.observed_at,
        };
      }
      action = 'promoted';
      return this.withRoot(current!, {
        ...root,
        phase: 'active',
        driver_lease: structuredClone(input.driver_lease),
        updated_at: input.observed_at,
      }, input.observed_at);
    }, false);
    return { state, action };
  }

  adoptLegacyRoots(input: AdoptLegacyRootsInput): ControlOwnerState {
    const owner = this.platform.preflight();
    timestamp(input.adopted_at, 'adopted_at');
    return this.mutate((current) => {
      if (current?.root) throw new ControlOwnerError('root_conflict', 'Cannot adopt legacy state over an existing root');
      const active = input.candidates.filter((candidate) => candidate.active && !candidate.terminal);
      if (active.some((candidate) => !candidate.session_id || !candidate.run_id)) {
        throw new ControlOwnerError('legacy_identity_incomplete', 'Legacy active state is missing session/run identity');
      }
      const keys = active.map((candidate) => identityKey({
        mode: candidate.mode,
        session_id: candidate.session_id!,
        run_id: candidate.run_id!,
      }));
      if (new Set(keys).size !== keys.length) {
        throw new ControlOwnerError('legacy_identity_duplicate', 'Legacy active state contains duplicate identities');
      }
      const roots = active.filter((candidate) => !candidate.parent);
      if (roots.length !== 1) {
        throw new ControlOwnerError('legacy_root_conflict', 'Legacy adoption requires exactly one legacy root');
      }
      const rootCandidate = roots[0];
      if (rootCandidate.session_id !== this.sessionId) {
        throw new ControlOwnerError('session_mismatch', 'Legacy root session does not match control authority');
      }
      const rootIdentity: ControlLineageIdentity = {
        mode: rootCandidate.mode,
        session_id: rootCandidate.session_id!,
        run_id: rootCandidate.run_id!,
      };
      const childCandidates = active.filter((candidate) => candidate !== rootCandidate);
      for (const ralph of active.filter((candidate) => candidate.mode === 'ralph')) {
        const ralphIdentity: ControlLineageIdentity = {
          mode: 'ralph', session_id: ralph.session_id!, run_id: ralph.run_id!,
        };
        const linked = childCandidates.filter(
          (candidate) => candidate.mode === 'ultrawork' && candidate.parent && sameIdentity(candidate.parent, ralphIdentity),
        );
        if (linked.length > 0 || ralph.linked_ultrawork) {
          if (ralph.linked_ultrawork !== true
            || linked.length !== 1
            || linked[0].linked_to_ralph !== true) {
            throw new ControlOwnerError('legacy_link_mismatch', 'Legacy Ralph/Ultrawork requires mutual exact links');
          }
        }
      }
      if (childCandidates.some((candidate) => candidate.linked_to_ralph
        && candidate.parent?.mode !== 'ralph')) {
        throw new ControlOwnerError('legacy_link_mismatch', 'Legacy linked Ultrawork has no exact Ralph parent');
      }
      const children: ControlChildRegistration[] = [];
      const reachable = new Set([identityKey(rootIdentity)]);
      const pending = [...childCandidates];
      while (pending.length > 0) {
        const index = pending.findIndex(
          (candidate) => candidate.parent && reachable.has(identityKey(candidate.parent)),
        );
        if (index < 0) {
          throw new ControlOwnerError('legacy_lineage_mismatch', 'Legacy child lineage is cyclic or unreachable from the root');
        }
        const [candidate] = pending.splice(index, 1);
        if (!candidate.parent || !allowedChild(candidate.parent.mode, candidate.mode)) {
          throw new ControlOwnerError('legacy_lineage_rejected', 'Legacy child lineage is not recognized');
        }
        if (candidate.parent.mode === 'graph' && (!candidate.graph_claim || candidate.mode !== 'team')) {
          throw new ControlOwnerError('graph_claim_required', 'Legacy Graph child requires an exact Team claim lineage');
        }
        if (candidate.parent.mode !== 'graph' && candidate.graph_claim) {
          throw new ControlOwnerError('graph_claim_unexpected', 'Legacy non-Graph child cannot carry graph claim lineage');
        }
        const child: ControlChildRegistration = {
          mode: candidate.mode,
          session_id: candidate.session_id!,
          run_id: candidate.run_id!,
          parent: structuredClone(candidate.parent),
          ...(candidate.graph_claim ? { graph_claim: structuredClone(candidate.graph_claim) } : {}),
          registered_at: input.adopted_at,
        };
        children.push(child);
        reachable.add(identityKey(child));
      }
      const root: ControlRoot = {
        ...rootIdentity,
        nonce: text(input.nonce, 'nonce', 128),
        phase: 'active',
        reservation_process: owner,
        ...(rootCandidate.mode === 'graph'
          ? {
              graph_revision: rootCandidate.graph_revision
                ? graphRevision(rootCandidate.graph_revision, 'legacy graph_revision')
                : (() => { throw new ControlOwnerError('legacy_identity_incomplete', 'Legacy Graph root lacks revision/hash'); })(),
            }
          : {}),
        children,
        created_at: input.adopted_at,
        updated_at: input.adopted_at,
      };
      return {
        format_version: 1,
        session_id: this.sessionId,
        generation: (current?.generation ?? 0) + 1,
        root,
        updated_at: input.adopted_at,
      };
    });
  }

  private emptyState(at: string): ControlOwnerState {
    return {
      format_version: 1,
      session_id: this.sessionId,
      generation: 0,
      root: null,
      updated_at: at,
    };
  }

  private requireExactRoot(
    current: ControlOwnerState | null,
    input: { mode: GraphControlMode; run_id: string; nonce: string },
  ): ControlRoot {
    if (!current?.root
      || current.root.mode !== input.mode
      || current.root.run_id !== input.run_id
      || current.root.nonce !== input.nonce) {
      throw new ControlOwnerError('root_fence_mismatch', 'Control root session/run/nonce fence does not match');
    }
    return current.root;
  }

  private withRoot(current: ControlOwnerState, root: ControlRoot, at: string): ControlOwnerState {
    return {
      ...current,
      generation: current.generation + 1,
      root,
      updated_at: at,
    };
  }

  private mutate(
    callback: (current: ControlOwnerState | null) => ControlOwnerState,
    writeUnchanged = true,
  ): ControlOwnerState {
    const locked = this.dependencies.withExclusiveLock(this.path, () => {
      const current = this.read();
      const next = parseControlOwnerState(callback(current), this.sessionId);
      if (writeUnchanged || JSON.stringify(next) !== JSON.stringify(current)) {
        this.dependencies.writeAtomic(this.path, next);
      }
      return next;
    });
    if (!locked.acquired || !locked.value) {
      throw new ControlOwnerError('lock_busy', 'Could not acquire the exclusive control-owner lock');
    }
    return locked.value;
  }
}
