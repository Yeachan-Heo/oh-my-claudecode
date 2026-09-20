import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { TEAM_NAME_SAFE_PATTERN } from './contracts.js';
import {
  canonicalTeamCwd,
  canonicalTeamStatePath,
  canonicalTeamStateRoot,
  assertTeamStatePathSafe,
  assertTeamStatePathSafeSync,
  teamInstanceLifecycleLockPath,
  teamWorkspaceHash,
  TeamPaths,
} from './state-paths.js';
import { withProcessIdentityFileLock } from './process-identity-lock.js';
import {
  currentProcessStartIdentity,
  isProcessIdentityDead,
  isValidProcessStartIdentity,
} from './team-owner-epoch.js';
import type {
  TeamInstanceAssertion,
  TeamInstanceBinding,
  TeamInstanceCleanupRecord,
  TeamInstanceCleanupResult,
  TeamInstanceDisposalAuthorization,
  TeamInstanceId,
  TeamInstanceObservedState,
  TeamInstancePendingConfig,
  TeamInstanceProcessIdentity,
  TeamInstanceRequest,
  TeamInstanceReservation,
  TeamInstanceReservationPhase,
} from './types.js';
import { isValidTeamInstanceId } from './types.js';

/** Errors are stable enough for callers to classify without parsing messages. */
export type TeamInstanceErrorCode =
  | 'team_instance_id_invalid'
  | 'team_instance_name_invalid'
  | 'team_instance_cwd_invalid'
  | 'team_instance_process_identity_unavailable'
  | 'team_instance_reservation_conflict'
  | 'team_instance_authority_missing'
  | 'team_instance_authority_corrupt'
  | 'team_instance_mismatch'
  | 'team_instance_newer_instance'
  | 'team_instance_state_unknown'
  | 'team_instance_state_corrupt'
  | 'team_instance_state_missing'
  | 'team_instance_startup_config_missing'
  | 'team_instance_startup_not_empty'
  | 'team_instance_reservation_active'
  | 'team_instance_owner_unknown'
  | 'team_instance_final_state_required'
  | 'team_instance_receipt_publish_failed'
  | 'team_instance_rename_failed'
  | 'team_instance_remove_failed'
  | 'team_instance_reservation_release_failed'
  | 'team_instance_cleanup_inconsistent';

export class TeamInstanceError extends Error {
  readonly code: TeamInstanceErrorCode;

  constructor(code: TeamInstanceErrorCode, message: string = code, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TeamInstanceError';
    this.code = code;
  }
}

/** Optional fault-injection seams also make the durable boundaries testable. */
export interface TeamInstanceIo {
  publishReservation?: (path: string, record: TeamInstanceReservation) => Promise<void> | void;
  publishCleanupReceipt?: (path: string, record: TeamInstanceCleanupRecord) => Promise<void> | void;
  renameStateRoot?: (source: string, destination: string) => Promise<void> | void;
  removeTree?: (path: string) => Promise<void> | void;
}

export interface TeamInstanceOperationOptions {
  timeoutMs?: number;
  io?: TeamInstanceIo;
}

/** Address accepted by assertion/disposal APIs; it must contain an instance id. */
export type BoundTeamInstance =
  | TeamInstanceBinding
  | TeamInstanceReservation
  | (TeamInstanceRequest & { instanceId: TeamInstanceId });

interface JsonValue {
  kind: 'missing' | 'invalid' | 'value';
  value?: unknown;
}

interface TeamStateInspection {
  observed_state: TeamInstanceObservedState;
  instance_id?: TeamInstanceId;
}

const TEAM_INSTANCE_RESERVATION_PHASES: readonly TeamInstanceReservationPhase[] = ['pending', 'active'];
const TEAM_INSTANCE_CLEANUP_PHASES: readonly TeamInstanceCleanupRecord['phase'][] = [
  'prepared', 'detached', 'removing', 'failed', 'completed',
];

function fail(code: TeamInstanceErrorCode, message: string = code): never {
  throw new TeamInstanceError(code, message);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateTeamName(teamName: string): void {
  if (!TEAM_NAME_SAFE_PATTERN.test(teamName)) fail('team_instance_name_invalid', 'invalid_team_name');
}

function validateCwd(cwd: string): string {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    fail('team_instance_cwd_invalid', 'invalid_cwd');
  }
  return canonicalTeamCwd(cwd);
}

function validateInstanceId(instanceId: string): TeamInstanceId {
  if (!isValidTeamInstanceId(instanceId)) fail('team_instance_id_invalid', 'invalid_instance_id');
  return instanceId.toLowerCase();
}

function expectedPaths(binding: TeamInstanceBinding): {
  reservation: string;
  cleanupRoot: string;
  cleanup: string;
  detached: string;
  lifecycle: string;
} {
  return {
    reservation: canonicalTeamStatePath(binding.cwd, TeamPaths.teamInstanceReservation(binding.workspace_hash, binding.team_name)),
    cleanupRoot: canonicalTeamStatePath(binding.cwd, TeamPaths.teamInstanceCleanupRoot(
      binding.workspace_hash,
      binding.team_name,
      binding.instance_id,
    )),
    cleanup: canonicalTeamStatePath(binding.cwd, TeamPaths.teamInstanceCleanupReceipt(
      binding.workspace_hash,
      binding.team_name,
      binding.instance_id,
    )),
    detached: canonicalTeamStatePath(binding.cwd, TeamPaths.teamInstanceDetachedRoot(
      binding.workspace_hash,
      binding.team_name,
      binding.instance_id,
    )),
    lifecycle: teamInstanceLifecycleLockPath(binding.cwd, binding.team_name),
  };
}

async function assertBindingPathsSafe(binding: TeamInstanceBinding): Promise<void> {
  const paths = expectedPaths(binding);
  try {
    await assertTeamStatePathSafe(binding.cwd, binding.state_root);
    await assertTeamStatePathSafe(binding.cwd, paths.reservation);
    await assertTeamStatePathSafe(binding.cwd, paths.cleanupRoot);
    await assertTeamStatePathSafe(binding.cwd, paths.cleanup);
    await assertTeamStatePathSafe(binding.cwd, paths.detached);
    await assertTeamStatePathSafe(binding.cwd, paths.lifecycle);
  } catch (error: unknown) {
    if (error instanceof TeamInstanceError) throw error;
    fail('team_instance_state_corrupt', error instanceof Error ? error.message : String(error));
  }
}

async function assertExternalCleanupPathsSafe(binding: TeamInstanceBinding): Promise<void> {
  const paths = expectedPaths(binding);
  try {
    await assertTeamStatePathSafe(binding.cwd, paths.cleanupRoot);
    await assertTeamStatePathSafe(binding.cwd, paths.cleanup);
    await assertTeamStatePathSafe(binding.cwd, paths.detached);
  } catch (error: unknown) {
    if (error instanceof TeamInstanceError) throw error;
    fail('team_instance_state_corrupt', error instanceof Error ? error.message : String(error));
  }
}

function canonicalPath(path: string): string {
  return resolve(path);
}

function sameBinding(a: Pick<TeamInstanceBinding, 'instance_id' | 'team_name' | 'cwd' | 'workspace_hash' | 'state_root'>,
  b: TeamInstanceBinding): boolean {
  return a.instance_id === b.instance_id
    && a.team_name === b.team_name
    && canonicalTeamCwd(a.cwd) === b.cwd
    && a.workspace_hash === b.workspace_hash
    && canonicalTeamStatePath(b.cwd, a.state_root) === canonicalPath(b.state_root);
}

function currentOwner(): TeamInstanceProcessIdentity {
  const processStartedAt = currentProcessStartIdentity();
  if (!isValidProcessStartIdentity(processStartedAt)) {
    fail('team_instance_process_identity_unavailable');
  }
  return {
    pid: process.pid,
    process_started_at: processStartedAt,
    nonce: randomUUID(),
  };
}

function ownerMatchesCurrent(owner: TeamInstanceProcessIdentity): boolean {
  const processStartedAt = currentProcessStartIdentity();
  return processStartedAt !== null
    && owner.pid === process.pid
    && owner.process_started_at === processStartedAt;
}

async function readJsonState(path: string): Promise<JsonValue> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return { kind: 'invalid' };
    return { kind: 'value', value: JSON.parse(await readFile(path, 'utf8')) as unknown };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid' };
  }
}

async function pathKind(path: string): Promise<'missing' | 'directory' | 'file' | 'other'> {
  try {
    const stat = await lstat(path);
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    fail('team_instance_state_corrupt', `state_path_unreadable:${path}`);
  }
}

async function defaultPublish(path: string, value: unknown): Promise<void> {
  const bytes = JSON.stringify(value, null, 2);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(tempPath, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(tempPath, path);
    const persisted = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (stableJson(persisted) !== stableJson(value)) {
      throw new Error('publication_verification_failed');
    }
  } finally {
    try { await unlink(tempPath); } catch { /* successful rename removes the temp path */ }
  }
}

async function verifyPublished(path: string, value: unknown): Promise<void> {
  const state = await readJsonState(path);
  if (state.kind !== 'value' || stableJson(state.value) !== stableJson(value)) {
    throw new Error('publication_verification_failed');
  }
}

async function publishReservation(
  record: TeamInstanceReservation,
  io: TeamInstanceIo | undefined,
): Promise<void> {
  try {
    await assertTeamStatePathSafe(record.cwd, record.reservation_path);
    if (io?.publishReservation) await io.publishReservation(record.reservation_path, record);
    else await defaultPublish(record.reservation_path, record);
    await verifyPublished(record.reservation_path, record);
  } catch (error: unknown) {
    throw new TeamInstanceError(
      'team_instance_receipt_publish_failed',
      `reservation_publish_failed:${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function publishCleanupReceipt(
  record: TeamInstanceCleanupRecord,
  io: TeamInstanceIo | undefined,
  path = record.receipt_path,
): Promise<void> {
  try {
    await assertTeamStatePathSafe(record.cwd, path);
    if (io?.publishCleanupReceipt) await io.publishCleanupReceipt(path, record);
    else await defaultPublish(path, record);
    await verifyPublished(path, record);
  } catch (error: unknown) {
    throw new TeamInstanceError(
      'team_instance_receipt_publish_failed',
      `cleanup_receipt_publish_failed:${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Publish the first cleanup receipt as a directory transaction. The permanent
 * instance directory is created only by the final directory rename, after the
 * complete receipt has been written and verified in a unique sibling staging
 * directory. A write/rename failure therefore leaves no empty cleanupRoot
 * that could masquerade as retained history on retry.
 */
async function publishInitialCleanupReceipt(
  record: TeamInstanceCleanupRecord,
  io: TeamInstanceIo | undefined,
): Promise<void> {
  const cleanupRoot = dirname(record.receipt_path);
  const stagingRoot = `${cleanupRoot}.staging-${process.pid}-${randomUUID()}`;
  let published = false;
  try {
    await assertTeamStatePathSafe(record.cwd, cleanupRoot);
    await assertTeamStatePathSafe(record.cwd, stagingRoot);
    if (await pathKind(cleanupRoot) !== 'missing') {
      fail('team_instance_authority_corrupt', 'cleanup_root_already_exists');
    }
    // Reservation and canonical state were independently revalidated by the
    // caller. An abandoned staging directory is not authority to adopt, nor
    // a reason to block this fresh transaction; leave its evidence untouched.
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const stagedReceiptPath = join(stagingRoot, 'cleanup.json');
    await publishCleanupReceipt(record, io, stagedReceiptPath);
    await rename(stagingRoot, cleanupRoot);
    published = true;
    await verifyPublished(record.receipt_path, record);
  } catch (error: unknown) {
    if (published) {
      if (error instanceof TeamInstanceError) throw error;
      throw new TeamInstanceError(
        'team_instance_receipt_publish_failed',
        `initial_cleanup_receipt_verification_failed:${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    try { await rm(stagingRoot, { recursive: true, force: true }); } catch { /* best effort; no permanent target was published */ }
    if (error instanceof TeamInstanceError) throw error;
    throw new TeamInstanceError(
      'team_instance_receipt_publish_failed',
      `initial_cleanup_receipt_publish_failed:${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function readReservation(binding: TeamInstanceBinding): Promise<TeamInstanceReservation | null> {
  const path = expectedPaths(binding).reservation;
  const state = await readJsonState(path);
  if (state.kind === 'missing') return null;
  if (state.kind !== 'value' || !isValidReservation(state.value)) {
    fail('team_instance_authority_corrupt', 'invalid_team_instance_reservation');
  }
  return state.value as TeamInstanceReservation;
}

async function readCleanupReceipt(binding: TeamInstanceBinding): Promise<TeamInstanceCleanupRecord | null> {
  await assertExternalCleanupPathsSafe(binding);
  const paths = expectedPaths(binding);
  const path = paths.cleanup;
  const state = await readJsonState(path);
  if (state.kind === 'missing') {
    const rootKind = await pathKind(paths.cleanupRoot);
    if (rootKind !== 'missing') fail('team_instance_authority_corrupt', 'cleanup_receipt_missing');
    return null;
  }
  if (state.kind !== 'value' || !isValidCleanupRecord(state.value, binding)) {
    fail('team_instance_authority_corrupt', 'invalid_team_instance_cleanup_receipt');
  }
  return state.value as TeamInstanceCleanupRecord;
}

/**
 * Cleanup authority is intentionally monotonic: once a UUID has a cleanup
 * directory, that UUID can never be admitted again. Even an empty, malformed,
 * or otherwise unreadable directory is evidence that must fail closed.
 */
async function hasHistoricalCleanupAuthority(binding: TeamInstanceBinding): Promise<boolean> {
  const root = expectedPaths(binding).cleanupRoot;
  const kind = await pathKind(root);
  if (kind !== 'missing') return true;
  const parent = dirname(root);
  try {
    const entries = await readdir(parent);
    return entries.some(entry => entry.startsWith(`${basename(root)}.staging-`));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    fail('team_instance_authority_corrupt', `cleanup_authority_parent_unreadable:${String(error)}`);
  }
}

function isValidProcessIdentity(value: unknown): value is TeamInstanceProcessIdentity {
  return isRecord(value)
    && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
    && isValidProcessStartIdentity(value.process_started_at)
    && typeof value.nonce === 'string' && value.nonce.length > 0;
}

function isValidReservation(value: unknown): value is TeamInstanceReservation {
  if (!isRecord(value)
    || value.schema_version !== 1
    || value.kind !== 'team-instance-reservation'
    || !isValidTeamInstanceId(value.instance_id)
    || !isNonEmptyString(value.team_name)
    || !TEAM_NAME_SAFE_PATTERN.test(value.team_name)
    || !isNonEmptyString(value.cwd)
    || !isNonEmptyString(value.state_root)
    || !TEAM_INSTANCE_RESERVATION_PHASES.includes(value.phase as TeamInstanceReservationPhase)
    || !isValidProcessIdentity(value.owner)
    || !isNonEmptyString(value.reservation_path)
    || !isNonEmptyString(value.lifecycle_lock_path)
    || !isTimestamp(value.created_at)
    || !isTimestamp(value.updated_at)) return false;
  const recordCwd = canonicalTeamCwd(value.cwd);
  const recordBinding: TeamInstanceBinding = {
    instance_id: value.instance_id,
    team_name: value.team_name,
    cwd: recordCwd,
    workspace_hash: teamWorkspaceHash(recordCwd, value.team_name),
    state_root: canonicalTeamStateRoot(recordCwd, value.team_name),
  };
  const expected = expectedPaths(recordBinding);
  return value.workspace_hash === recordBinding.workspace_hash
    && canonicalTeamStatePath(recordCwd, value.state_root) === canonicalPath(recordBinding.state_root)
    && canonicalTeamStatePath(recordCwd, value.reservation_path) === expected.reservation
    && canonicalTeamStatePath(recordCwd, value.lifecycle_lock_path) === expected.lifecycle;
}

function isValidAuthorization(value: unknown): value is TeamInstanceDisposalAuthorization {
  return isRecord(value)
    && value.protocol === 'caller-owned-final-state-v1'
    && value.providers === 'disposed'
    && value.panes === 'disposed'
    && value.worktrees === 'disposed';
}

function isValidCleanupRecord(value: unknown, binding: TeamInstanceBinding): value is TeamInstanceCleanupRecord {
  if (!isRecord(value)
    || value.schema_version !== 1
    || value.kind !== 'team-instance-cleanup'
    || !isValidTeamInstanceId(value.instance_id)
    || !isNonEmptyString(value.team_name)
    || !isNonEmptyString(value.cwd)
    || value.workspace_hash !== binding.workspace_hash
    || !isNonEmptyString(value.state_root)
    || !isNonEmptyString(value.detached_root)
    || !isNonEmptyString(value.receipt_path)
    || !TEAM_INSTANCE_CLEANUP_PHASES.includes(value.phase as TeamInstanceCleanupRecord['phase'])
    || (value.detached_at !== undefined && !isTimestamp(value.detached_at))
    || (value.phase === 'prepared' && value.detached_at !== undefined)
    || (value.phase !== 'prepared' && value.detached_at === undefined)
    || !isValidAuthorization(value.authorization)
    || !isTimestamp(value.created_at)
    || !isTimestamp(value.updated_at)
    || (value.failure_reason !== undefined && typeof value.failure_reason !== 'string')) return false;
  const expected = expectedPaths(binding);
  return value.instance_id === binding.instance_id
    && value.team_name === binding.team_name
    && canonicalTeamCwd(value.cwd) === binding.cwd
    && canonicalTeamStatePath(binding.cwd, value.state_root) === canonicalPath(binding.state_root)
    && canonicalTeamStatePath(binding.cwd, value.detached_root) === canonicalPath(expected.detached)
    && canonicalTeamStatePath(binding.cwd, value.receipt_path) === expected.cleanup;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function identityFromDocument(value: unknown, binding: TeamInstanceBinding): TeamInstanceId | undefined {
  if (!isRecord(value)) fail('team_instance_state_corrupt', 'invalid_team_config_document');
  if (value.name !== undefined && value.name !== binding.team_name) {
    fail('team_instance_state_corrupt', 'team_name_binding_mismatch');
  }
  if (value.instance_id === undefined) return undefined;
  if (!isValidTeamInstanceId(value.instance_id)) {
    fail('team_instance_state_corrupt', 'invalid_team_instance_id');
  }
  if (value.leader_cwd !== undefined) {
    if (typeof value.leader_cwd !== 'string' || canonicalTeamCwd(value.leader_cwd) !== binding.cwd) {
      fail('team_instance_mismatch', 'team_cwd_binding_mismatch');
    }
  }
  if (value.team_state_root !== undefined) {
    if (typeof value.team_state_root !== 'string'
      || canonicalTeamStatePath(binding.cwd, value.team_state_root) !== canonicalPath(binding.state_root)) {
      fail('team_instance_mismatch', 'team_state_root_binding_mismatch');
    }
  }
  return value.instance_id.toLowerCase();
}

async function inspectTeamState(binding: TeamInstanceBinding): Promise<TeamStateInspection> {
  await assertTeamStatePathSafe(binding.cwd, binding.state_root);
  const root = binding.state_root;
  const kind = await pathKind(root);
  if (kind === 'missing') return { observed_state: 'missing' };
  if (kind !== 'directory') fail('team_instance_state_corrupt', 'team_state_root_not_directory');

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error: unknown) {
    fail('team_instance_state_corrupt', `team_state_root_unreadable:${error instanceof Error ? error.message : String(error)}`);
  }
  if (entries.length === 0) return { observed_state: 'empty' };

  const identities: TeamInstanceId[] = [];
  for (const fileName of ['config.json', 'manifest.json']) {
    const path = join(root, fileName);
    const fileKind = await pathKind(path);
    if (fileKind === 'missing') continue;
    if (fileKind !== 'file') fail('team_instance_state_corrupt', `team_state_document_not_file:${fileName}`);
    const state = await readJsonState(path);
    if (state.kind !== 'value') fail('team_instance_state_corrupt', `invalid_team_state_document:${fileName}`);
    const identity = identityFromDocument(state.value, binding);
    if (identity === undefined) fail('team_instance_state_unknown', 'team_state_identity_missing');
    identities.push(identity);
  }

  if (identities.length === 0) fail('team_instance_state_unknown', 'team_state_identity_missing');
  if (identities.some(identity => identity !== binding.instance_id.toLowerCase())) {
    fail('team_instance_newer_instance', 'team_instance_identity_mismatch');
  }
  if (new Set(identities).size !== 1) fail('team_instance_state_corrupt', 'team_state_identity_conflict');
  return { observed_state: 'bound', instance_id: identities[0] };
}

function bindingFromInput(input: TeamInstanceRequest, requireInstanceId: boolean): TeamInstanceBinding {
  validateTeamName(input.teamName);
  const cwd = validateCwd(input.cwd);
  const instanceId = input.instanceId === undefined
    ? (requireInstanceId ? fail('team_instance_id_invalid', 'instance_id_required') : randomUUID())
    : validateInstanceId(input.instanceId);
  return {
    instance_id: instanceId,
    team_name: input.teamName,
    cwd,
    workspace_hash: teamWorkspaceHash(cwd, input.teamName),
    state_root: canonicalTeamStateRoot(cwd, input.teamName),
  };
}

function bindingFromBoundInput(input: BoundTeamInstance): TeamInstanceBinding {
  if ('team_name' in input) {
    const binding = bindingFromInput({ teamName: input.team_name, cwd: input.cwd, instanceId: input.instance_id }, true);
    if (!sameBinding(input, binding)) fail('team_instance_mismatch', 'invalid_team_instance_binding');
    return binding;
  }
  return bindingFromInput(input, true);
}

function reservationForBinding(binding: TeamInstanceBinding, phase: TeamInstanceReservationPhase, owner: TeamInstanceProcessIdentity,
  createdAt = new Date().toISOString()): TeamInstanceReservation {
  const paths = expectedPaths(binding);
  return {
    schema_version: 1,
    kind: 'team-instance-reservation',
    instance_id: binding.instance_id,
    team_name: binding.team_name,
    cwd: binding.cwd,
    workspace_hash: binding.workspace_hash,
    state_root: binding.state_root,
    phase,
    owner,
    reservation_path: paths.reservation,
    lifecycle_lock_path: paths.lifecycle,
    created_at: createdAt,
    updated_at: new Date().toISOString(),
  };
}

function assertAuthorization(authorization: TeamInstanceDisposalAuthorization): void {
  if (!isValidAuthorization(authorization)) {
    fail('team_instance_final_state_required', 'caller_owned_final_state_protocol_required');
  }
}

function assertSameAuthorization(
  expected: TeamInstanceDisposalAuthorization,
  actual: TeamInstanceDisposalAuthorization,
): void {
  assertAuthorization(actual);
  if (stableJson(expected) !== stableJson(actual)) {
    fail('team_instance_mismatch', 'cleanup_authorization_mismatch');
  }
}

/** Build and canonicalize an instance id before any state effect. */
export function createTeamInstanceBinding(input: TeamInstanceRequest): TeamInstanceBinding {
  return bindingFromInput(input, false);
}

/** The one external lock shared by startup, lifecycle mutation and cleanup. */
export { teamInstanceLifecycleLockPath };

export async function withTeamInstanceLifecycleLock<T>(
  cwd: string,
  teamName: string,
  fn: () => Promise<T> | T,
  timeoutMs = 10_000,
): Promise<T> {
  validateTeamName(teamName);
  const canonicalCwd = validateCwd(cwd);
  const lifecyclePath = teamInstanceLifecycleLockPath(canonicalCwd, teamName);
  try {
    assertTeamStatePathSafeSync(canonicalCwd, lifecyclePath);
  } catch (error: unknown) {
    throw new TeamInstanceError(
      'team_instance_state_corrupt',
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  return withProcessIdentityFileLock(lifecyclePath, fn, timeoutMs);
}

/**
 * Reserve a new instance under the caller's lifecycle lock.  This function is
 * intentionally lock-free so startup can reserve, write its pending config,
 * and perform every effect while retaining one lock.
 */
export async function reserveTeamInstanceUnderLock(
  input: TeamInstanceRequest,
  options: TeamInstanceOperationOptions = {},
): Promise<TeamInstanceReservation> {
  const binding = bindingFromInput(input, false);
  await assertBindingPathsSafe(binding);
  if (await hasHistoricalCleanupAuthority(binding)) {
    fail('team_instance_reservation_conflict', 'instance_id_reuse_blocked');
  }
  const existing = await readReservation(binding);
  if (existing) {
    fail(
      'team_instance_reservation_conflict',
      existing.instance_id === binding.instance_id
        ? 'instance_already_reserved'
        : 'team_name_already_reserved',
    );
  }

  const state = await inspectTeamState(binding);
  if (state.observed_state === 'bound') fail('team_instance_reservation_conflict', 'team_state_already_exists');

  const reservation = reservationForBinding(binding, 'pending', currentOwner());
  await publishReservation(reservation, options.io);
  return reservation;
}

/** Convenience form for callers that do not already own the lifecycle lock. */
export function reserveTeamInstance(
  input: TeamInstanceRequest,
  options: TeamInstanceOperationOptions = {},
): Promise<TeamInstanceReservation> {
  const binding = bindingFromInput(input, false);
  return withTeamInstanceLifecycleLock(binding.cwd, binding.team_name,
    () => reserveTeamInstanceUnderLock({ teamName: binding.team_name, cwd: binding.cwd, instanceId: binding.instance_id }, options),
    options.timeoutMs);
}

/** Return the minimal config projection safe to write before startup effects. */
export function buildTeamInstancePendingConfig(input: BoundTeamInstance): TeamInstancePendingConfig {
  const binding = bindingFromBoundInput(input);
  return {
    name: binding.team_name,
    instance_id: binding.instance_id,
    leader_cwd: binding.cwd,
    team_state_root: binding.state_root,
    lifecycle_state: 'starting',
  };
}

/**
 * Assert the reservation and any config/manifest identity while the lifecycle
 * lock is held.  It never acquires the lock itself, preventing recursive-lock
 * deadlocks when config CAS is performed inside lifecycle operations.
 */
export async function assertTeamInstanceUnderLock(input: BoundTeamInstance): Promise<TeamInstanceAssertion> {
  const binding = bindingFromBoundInput(input);
  await assertBindingPathsSafe(binding);
  const reservation = await readReservation(binding);
  if (!reservation) fail('team_instance_authority_missing', 'team_instance_reservation_missing');
  if (!sameBinding(reservation, binding)) fail('team_instance_mismatch', 'reservation_binding_mismatch');
  const state = await inspectTeamState(binding);
  return { binding, reservation, observed_state: state.observed_state };
}

/** Mark a pending reservation active after the identity-bearing config exists. */
export async function activateTeamInstanceUnderLock(
  input: BoundTeamInstance,
  options: TeamInstanceOperationOptions = {},
): Promise<TeamInstanceReservation> {
  const assertion = await assertTeamInstanceUnderLock(input);
  if (!ownerMatchesCurrent(assertion.reservation.owner)) {
    fail('team_instance_owner_unknown', 'startup_reservation_owner_not_current');
  }
  if (assertion.observed_state !== 'bound') {
    fail('team_instance_startup_config_missing', 'identity_bearing_config_required');
  }
  const active = {
    ...assertion.reservation,
    phase: 'active' as const,
    updated_at: new Date().toISOString(),
  };
  await publishReservation(active, options.io);
  return active;
}

/**
 * Release only a failed, still-empty startup.  The root is checked and removed
 * before the reservation, so a release failure leaves a retryable authority.
 */
export async function releaseFailedStartupReservationUnderLock(
  input: BoundTeamInstance,
  options: TeamInstanceOperationOptions = {},
): Promise<void> {
  const binding = bindingFromBoundInput(input);
  await assertBindingPathsSafe(binding);
  const reservation = await readReservation(binding);
  if (!reservation) return;
  if (!sameBinding(reservation, binding)) fail('team_instance_mismatch', 'reservation_binding_mismatch');
  if (reservation.phase !== 'pending') fail('team_instance_reservation_active', 'active_reservation_not_releaseable');
  if (!ownerMatchesCurrent(reservation.owner) && !isProcessIdentityDead(reservation.owner)) {
    fail('team_instance_owner_unknown', 'startup_owner_not_confirmed_dead');
  }

  const rootKind = await pathKind(binding.state_root);
  if (rootKind === 'other' || rootKind === 'file') fail('team_instance_state_corrupt', 'team_state_root_not_directory');
  if (rootKind === 'directory') {
    let entries: string[];
    try { entries = await readdir(binding.state_root); }
    catch (error: unknown) { fail('team_instance_state_corrupt', `team_state_root_unreadable:${String(error)}`); }
    if (entries.length > 0) fail('team_instance_startup_not_empty', 'failed_startup_root_not_empty');
    try {
      if (options.io?.removeTree) await options.io.removeTree(binding.state_root);
      else await rm(binding.state_root, { recursive: true, force: true });
    } catch (error: unknown) {
      throw new TeamInstanceError('team_instance_remove_failed', `empty_startup_root_remove_failed:${String(error)}`, { cause: error });
    }
    if (await pathKind(binding.state_root) !== 'missing') {
      fail('team_instance_remove_failed', 'empty_startup_root_remove_unverified');
    }
  }
  try {
    await unlink(reservation.reservation_path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new TeamInstanceError('team_instance_reservation_release_failed', `reservation_release_failed:${String(error)}`, { cause: error });
    }
  }
  if (await readReservation(binding)) fail('team_instance_reservation_release_failed', 'reservation_release_unverified');
}

export function releaseFailedStartupReservation(
  input: BoundTeamInstance,
  options: TeamInstanceOperationOptions = {},
): Promise<void> {
  const binding = bindingFromBoundInput(input);
  return withTeamInstanceLifecycleLock(binding.cwd, binding.team_name,
    () => releaseFailedStartupReservationUnderLock(binding, options), options.timeoutMs);
}

async function renameIntoDetachedRoot(
  binding: TeamInstanceBinding,
  options: TeamInstanceOperationOptions,
): Promise<void> {
  await assertBindingPathsSafe(binding);
  const paths = expectedPaths(binding);
  const sourceKind = await pathKind(binding.state_root);
  const destinationKind = await pathKind(paths.detached);
  if (sourceKind === 'missing' && destinationKind === 'missing') {
    fail('team_instance_state_missing', 'team_state_root_missing_before_detach');
  }
  if (sourceKind === 'missing' && destinationKind !== 'missing') return;
  if (sourceKind !== 'directory') fail('team_instance_state_corrupt', 'team_state_root_not_directory');
  if (destinationKind !== 'missing') fail('team_instance_cleanup_inconsistent', 'both_state_and_detached_roots_exist');
  await mkdir(dirname(paths.detached), { recursive: true, mode: 0o700 });
  try {
    if (options.io?.renameStateRoot) await options.io.renameStateRoot(binding.state_root, paths.detached);
    else await rename(binding.state_root, paths.detached);
  } catch (error: unknown) {
    throw new TeamInstanceError('team_instance_rename_failed', `state_root_detach_failed:${String(error)}`, { cause: error });
  }
  if (await pathKind(binding.state_root) !== 'missing' || await pathKind(paths.detached) !== 'directory') {
    fail('team_instance_rename_failed', 'state_root_detach_unverified');
  }
}

async function removeDetachedRoot(
  binding: TeamInstanceBinding,
  options: TeamInstanceOperationOptions,
): Promise<void> {
  await assertExternalCleanupPathsSafe(binding);
  const detached = expectedPaths(binding).detached;
  const kind = await pathKind(detached);
  if (kind === 'missing') return;
  if (kind !== 'directory') fail('team_instance_cleanup_inconsistent', 'detached_root_not_directory');
  try {
    if (options.io?.removeTree) await options.io.removeTree(detached);
    else await rm(detached, { recursive: true, force: true });
  } catch (error: unknown) {
    throw new TeamInstanceError('team_instance_remove_failed', `detached_root_remove_failed:${String(error)}`, { cause: error });
  }
}

async function clearReservationIfOwned(binding: TeamInstanceBinding): Promise<void> {
  const path = expectedPaths(binding).reservation;
  // Reservation is shared with successors. A replacement may intentionally
  // have changed this path (including by installing a symlink); never follow
  // such a path and never let it block removal of an already-detached owner.
  try { await assertTeamStatePathSafe(binding.cwd, path); } catch { return; }
  let stat;
  try {
    stat = await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    return;
  }
  // A successor may have installed a symlink or another non-regular marker at
  // the shared reservation path. Never follow or remove it during old-instance
  // detached cleanup.
  if (!stat.isFile()) return;
  const state = await readJsonState(path);
  if (state.kind !== 'value' || !isValidReservation(state.value)) return;
  const reservation = state.value as TeamInstanceReservation;
  if (!sameBinding(reservation, binding)) return; // A newer reservation is never touched.
  try {
    await unlink(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new TeamInstanceError('team_instance_reservation_release_failed', `reservation_release_failed:${String(error)}`, { cause: error });
    }
  }
  try {
    const after = await lstat(path);
    // A concurrent successor may have replaced the path immediately after our
    // unlink. That replacement is not ours and must remain untouched.
    if (after.isSymbolicLink() || after.isFile()) return;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
}

function transitionCleanupRecord(
  record: TeamInstanceCleanupRecord,
  phase: TeamInstanceCleanupRecord['phase'],
  failureReason?: string,
): TeamInstanceCleanupRecord {
  const next: TeamInstanceCleanupRecord = { ...record, phase, updated_at: new Date().toISOString() };
  if (phase === 'prepared') delete next.detached_at;
  else next.detached_at ??= new Date().toISOString();
  if (failureReason === undefined) delete next.failure_reason;
  else next.failure_reason = failureReason;
  return next;
}

async function resumeCleanupUnderLock(
  binding: TeamInstanceBinding,
  authorization: TeamInstanceDisposalAuthorization,
  existing: TeamInstanceCleanupRecord,
  options: TeamInstanceOperationOptions,
): Promise<TeamInstanceCleanupResult> {
  assertSameAuthorization(existing.authorization, authorization);
  await assertExternalCleanupPathsSafe(binding);
  const paths = expectedPaths(binding);
  let receipt = existing;
  if (existing.phase === 'completed') {
    if (await pathKind(paths.detached) !== 'missing') {
      fail('team_instance_cleanup_inconsistent', 'completed_receipt_with_detached_root');
    }
    return { outcome: 'already_cleaned', binding, receipt: existing };
  }

  if (receipt.phase === 'prepared') {
    // Before the detached phase is durably recorded, the canonical root is
    // still the only authority. A replacement must block this retry.
    const currentState = await inspectTeamState(binding);
    const detachedBefore = await pathKind(paths.detached);
    if (currentState.observed_state === 'bound' && currentState.instance_id !== binding.instance_id) {
      fail('team_instance_newer_instance', 'newer_same_name_instance_present');
    }
    const alreadyRenamed = currentState.observed_state === 'missing' && detachedBefore === 'directory';
    if (!alreadyRenamed && currentState.observed_state !== 'bound') {
      fail('team_instance_state_missing', 'identity_bearing_state_required_before_detach');
    }
    if (!alreadyRenamed) await renameIntoDetachedRoot(binding, options);
    receipt = transitionCleanupRecord(receipt, 'detached');
    await publishCleanupReceipt(receipt, options.io);
  }

  // Once the original root is durably detached, the shared name is safe for a
  // replacement instance.  Release only the matching reservation; a newer
  // reservation is never touched.
  await clearReservationIfOwned(binding);

  const detachedKind = await pathKind(paths.detached);
  if (detachedKind !== 'missing') {
    receipt = transitionCleanupRecord(receipt, 'removing');
    await publishCleanupReceipt(receipt, options.io);
    try {
      await removeDetachedRoot(binding, options);
    } catch (error: unknown) {
      const failed: TeamInstanceCleanupRecord = {
        ...receipt,
        phase: 'failed',
        failure_reason: error instanceof Error ? error.message : String(error),
        updated_at: new Date().toISOString(),
      };
      try { await publishCleanupReceipt(failed, options.io); } catch { /* preserve the last durable phase */ }
      throw error;
    }
  }

  const completed = transitionCleanupRecord(receipt, 'completed');
  await publishCleanupReceipt(completed, options.io);
  return { outcome: 'cleaned', binding, receipt: completed };
}

/**
 * Dispose one instance after the caller-owned final-state protocol has run.
 * Callers MUST prove provider termination from launch/process identity evidence,
 * prove pane ownership/absence separately, and complete worktree cleanup in
 * its established order before passing this authorization. This module never
 * probes or kills providers and never infers provider death from a pane.
 */
export async function disposeTeamInstanceUnderLock(
  input: BoundTeamInstance,
  authorization: TeamInstanceDisposalAuthorization,
  options: TeamInstanceOperationOptions = {},
): Promise<TeamInstanceCleanupResult> {
  assertAuthorization(authorization);
  const binding = bindingFromBoundInput(input);
  // Existing receipts may be resumed after the named state root and shared
  // reservation have already been replaced. Read only the old external
  // authority first; canonical-root validation is restricted to initial and
  // prepared disposal.
  await assertExternalCleanupPathsSafe(binding);
  const existing = await readCleanupReceipt(binding);
  if (existing) return resumeCleanupUnderLock(binding, authorization, existing, options);

  await assertBindingPathsSafe(binding);
  const assertion = await assertTeamInstanceUnderLock(binding);
  if (assertion.observed_state !== 'bound') {
    fail('team_instance_state_missing', 'identity_bearing_state_required_for_disposal');
  }
  const paths = expectedPaths(binding);
  let receipt: TeamInstanceCleanupRecord = {
    schema_version: 1,
    kind: 'team-instance-cleanup',
    instance_id: binding.instance_id,
    team_name: binding.team_name,
    cwd: binding.cwd,
    workspace_hash: binding.workspace_hash,
    state_root: binding.state_root,
    detached_root: paths.detached,
    receipt_path: paths.cleanup,
    phase: 'prepared',
    authorization,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await publishInitialCleanupReceipt(receipt, options.io);
  await renameIntoDetachedRoot(binding, options);
  receipt = transitionCleanupRecord(receipt, 'detached');
  await publishCleanupReceipt(receipt, options.io);
  return resumeCleanupUnderLock(binding, authorization, receipt, options);
}

/** Convenience disposal form for callers that do not already own the lock. */
export function disposeTeamInstance(
  input: BoundTeamInstance,
  authorization: TeamInstanceDisposalAuthorization,
  options: TeamInstanceOperationOptions = {},
): Promise<TeamInstanceCleanupResult> {
  assertAuthorization(authorization);
  const binding = bindingFromBoundInput(input);
  return withTeamInstanceLifecycleLock(binding.cwd, binding.team_name,
    () => disposeTeamInstanceUnderLock(binding, authorization, options), options.timeoutMs);
}

/**
 * Retry only a cleanup transaction that already published a valid receipt.
 * Unlike `disposeTeamInstance`, this API never creates a prepared receipt and
 * therefore cannot turn a caller's literal authorization into a new deletion.
 */
export async function retryTeamInstanceDisposalUnderLock(
  input: BoundTeamInstance,
  authorization: TeamInstanceDisposalAuthorization,
  options: TeamInstanceOperationOptions = {},
): Promise<TeamInstanceCleanupResult> {
  assertAuthorization(authorization);
  const binding = bindingFromBoundInput(input);
  await assertExternalCleanupPathsSafe(binding);
  const existing = await readCleanupReceipt(binding);
  if (!existing) fail('team_instance_authority_missing', 'team_instance_cleanup_receipt_missing');
  return resumeCleanupUnderLock(binding, authorization, existing, options);
}

/** Explicit public retry entry point; it acquires the canonical name lock. */
export function retryTeamInstanceDisposal(
  input: BoundTeamInstance,
  authorization: TeamInstanceDisposalAuthorization,
  options: TeamInstanceOperationOptions = {},
): Promise<TeamInstanceCleanupResult> {
  const binding = bindingFromBoundInput(input);
  return withTeamInstanceLifecycleLock(binding.cwd, binding.team_name,
    () => retryTeamInstanceDisposalUnderLock(binding, authorization, options), options.timeoutMs);
}