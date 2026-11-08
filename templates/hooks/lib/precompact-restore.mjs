// PreCompact checkpoint restore helper (issue #3817).
//
// This helper is intentionally self-contained because SessionStart imports it
// directly from a clean checkout. The portable publisher revalidates canonical
// cwd identity and creates deterministic immutable claims with no-clobber hard
// links from retained random O_EXCL ownership witnesses.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { basename, dirname, isAbsolute, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_MAX_BYTES = 256 * 1024;
const RESTORE_CONTEXT_MAX_CHARS = 1200;
const RESTORE_MARKER_MAX_BYTES = 16 * 1024;
const RESTORE_LOCK_RETRY_ATTEMPTS = 100;
const RESTORE_LOCK_RETRY_MS = 10;
const CHECKPOINT_FILE_PATTERN = /^checkpoint-.+\.json$/;
const RESTORE_CLAIM_PATTERN = /^restored-[0-9a-f]{64}\.json$/;

// Mirrors SESSION_ID_REGEX from src/lib/worktree-paths.ts::validateSessionId.
const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const WINDOWS_RESERVED_SESSION_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_ALLOWLIST.test(sessionId) &&
    !WINDOWS_RESERVED_SESSION_ID.test(sessionId);
}

function compareCheckpointNames(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function normalizeMtimeMs(value) {
  return Math.trunc(value);
}

function compareCheckpointOrder(a, b) {
  const aTime = Date.parse(a.createdAt);
  const bTime = Date.parse(b.createdAt);
  if (aTime !== bTime) return aTime - bTime;
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
  const nameOrder = compareCheckpointNames(a.name, b.name);
  if (nameOrder !== 0) return nameOrder;
  return compareCheckpointNames(a.contentSha256, b.contentSha256);
}

function isPathWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isPathWithinOrEqual(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function inspectCanonicalDirectory(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return { path: realpathSync(path), dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function getCanonicalCheckpointContext(omcRoot) {
  const root = inspectCanonicalDirectory(omcRoot);
  const statePath = join(omcRoot, 'state');
  const state = inspectCanonicalDirectory(statePath);
  const checkpointsPath = join(statePath, 'checkpoints');
  const checkpoints = inspectCanonicalDirectory(checkpointsPath);
  if (!root || !state || !checkpoints) return null;
  if (
    !isPathWithinOrEqual(root.path, state.path) ||
    !isPathWithinOrEqual(root.path, checkpoints.path) ||
    !isPathWithinOrEqual(state.path, checkpoints.path)
  ) return null;
  return { omcRoot: root, state, checkpoints };
}

function isStableCanonicalDirectory(path, expected) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      stat.dev === expected.dev && stat.ino === expected.ino &&
      realpathSync(path) === expected.path;
  } catch {
    return false;
  }
}

function isStableCheckpointContext(omcRoot, context) {
  return isStableCanonicalDirectory(omcRoot, context.omcRoot) &&
    isStableCanonicalDirectory(join(omcRoot, 'state'), context.state) &&
    isStableCanonicalDirectory(join(omcRoot, 'state', 'checkpoints'), context.checkpoints);
}

function canonicalChildDirectory(parent, name) {
  const childPath = join(parent.path, name);
  try {
    const stat = lstatSync(childPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const canonicalPath = realpathSync(childPath);
    if (!isPathWithinOrEqual(parent.path, canonicalPath)) return null;
    const after = lstatSync(childPath);
    if (!after.isDirectory() || after.isSymbolicLink() ||
      after.dev !== stat.dev || after.ino !== stat.ino ||
      realpathSync(childPath) !== canonicalPath) return null;
    return { path: canonicalPath, dev: after.dev, ino: after.ino };
  } catch {
    return null;
  }
}

function getRestoreMarkerTarget(omcRoot, sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  const context = getCanonicalCheckpointContext(omcRoot);
  if (!context || !isStableCheckpointContext(omcRoot, context)) return null;
  const markerRoot = canonicalChildDirectory(context.state, 'checkpoints-restored');
  if (!markerRoot || !isPathWithin(context.omcRoot.path, markerRoot.path)) return null;
  const parent = canonicalChildDirectory(markerRoot, sessionId);
  if (!parent || !isPathWithin(context.omcRoot.path, parent.path) ||
    !isPathWithinOrEqual(context.state.path, parent.path) ||
    !isStableCheckpointContext(omcRoot, context)) return null;
  return { context, markerRoot, parent, path: join(parent.path, 'restored.json') };
}

function publisherPath() {
  return fileURLToPath(new URL('./precompact-publisher.mjs', import.meta.url));
}

function publisherExecArgs() {
  const preload = process.env.OMC_PRECOMPACT_PUBLISHER_IMPORT;
  return typeof preload === 'string' && preload.startsWith('file:') ? ['--import', preload] : [];
}

function runPublisher(request, cwd) {
  try {
    const raw = execFileSync(process.execPath, [...publisherExecArgs(), publisherPath()], {
      cwd,
      input: JSON.stringify(request),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    const result = JSON.parse(raw);
    return result && typeof result.status === 'string' ? result : null;
  } catch {
    return null;
  }
}

function ensureRestoreMarkerTarget(omcRoot, sessionId) {
  const context = getCanonicalCheckpointContext(omcRoot);
  if (!context || !isStableCheckpointContext(omcRoot, context)) return false;
  const rootResult = runPublisher({ operation: 'ensure-root', expectedCwd: context.state }, context.state.path);
  if (rootResult?.status !== 'ready') return false;
  const markerRoot = canonicalChildDirectory(context.state, 'checkpoints-restored');
  if (!markerRoot || !isStableCheckpointContext(omcRoot, context)) return false;
  const sessionResult = runPublisher({ operation: 'ensure-session', sessionId, expectedCwd: markerRoot }, markerRoot.path);
  return sessionResult?.status === 'ready' && !!getRestoreMarkerTarget(omcRoot, sessionId);
}

function isStableRestoreMarkerTarget(target) {
  try {
    return isStableCheckpointContext(target.context.omcRoot.path, target.context) &&
      isStableCanonicalDirectory(
        join(target.context.state.path, 'checkpoints-restored'),
        target.markerRoot,
      ) &&
      isStableCanonicalDirectory(
        join(target.context.state.path, 'checkpoints-restored', basename(target.parent.path)),
        target.parent,
      );
  } catch {
    return false;
  }
}

function readBoundedFile(path, expected, maxBytes, allowHardlinks = false) {
  const readOnly = constants.O_RDONLY;
  if (typeof readOnly !== 'number') return null;
  const noFollow = constants.O_NOFOLLOW;
  let fd = null;
  try {
    const beforePath = lstatSync(path);
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || (!allowHardlinks && beforePath.nlink > 1) ||
      beforePath.dev !== expected.dev || beforePath.ino !== expected.ino ||
      realpathSync(path) !== expected.path) return null;
    const flags = readOnly | (typeof noFollow === 'number' && noFollow !== 0 ? noFollow : 0);
    fd = openSync(path, flags);
    const before = fstatSync(fd);
    if (!before.isFile() || before.isSymbolicLink() || (!allowHardlinks && before.nlink > 1) ||
      before.dev !== expected.dev || before.ino !== expected.ino ||
      !Number.isFinite(before.size) || before.size > maxBytes ||
      realpathSync(path) !== expected.path) return null;
    const openedPath = lstatSync(path);
    if (!openedPath.isFile() || openedPath.isSymbolicLink() || (!allowHardlinks && openedPath.nlink > 1) ||
      openedPath.dev !== before.dev || openedPath.ino !== before.ino) return null;
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!Number.isInteger(count) || count <= 0) return null;
      offset += count;
    }
    const after = fstatSync(fd);
    const afterPath = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || (!allowHardlinks && after.nlink > 1) ||
      after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      afterPath.dev !== before.dev || afterPath.ino !== before.ino ||
      afterPath.isSymbolicLink() || (!allowHardlinks && afterPath.nlink > 1) || afterPath.size !== before.size ||
      afterPath.mtimeMs !== before.mtimeMs || afterPath.ctimeMs !== before.ctimeMs ||
      realpathSync(path) !== expected.path) return null;
    const raw = buffer.toString('utf8');
    return raw.length <= maxBytes ? raw : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readBoundedCheckpoint(path, expected) {
  return readBoundedFile(path, expected, CHECKPOINT_MAX_BYTES);
}

function resolveContainedRegularPath(context, omcRoot, candidatePath) {
  try {
    if (!isStableCheckpointContext(omcRoot, context)) return null;
    const before = lstatSync(candidatePath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) return null;
    const resolvedPath = realpathSync(candidatePath);
    if (!isPathWithin(context.checkpoints.path, resolvedPath)) return null;
    if (!isStableCheckpointContext(omcRoot, context)) return null;
    const after = lstatSync(candidatePath);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink > 1 ||
      after.dev !== before.dev || after.ino !== before.ino) return null;
    const resolvedAgain = realpathSync(candidatePath);
    if (resolvedAgain !== resolvedPath || !isPathWithin(context.checkpoints.path, resolvedAgain)) return null;
    const resolvedStat = lstatSync(resolvedPath);
    if (!resolvedStat.isFile() || resolvedStat.isSymbolicLink() || resolvedStat.nlink > 1 ||
      resolvedStat.dev !== after.dev || resolvedStat.ino !== after.ino) return null;
    return isStableCheckpointContext(omcRoot, context)
      ? { path: resolvedPath, dev: after.dev, ino: after.ino }
      : null;
  } catch {
    return null;
  }
}

function checkpointOrderForSession(omcRoot, checkpointPath, sessionId) {
  try {
    const context = getCanonicalCheckpointContext(omcRoot);
    if (!context) return null;
    const resolved = resolveContainedRegularPath(context, omcRoot, checkpointPath);
    if (!resolved || dirname(resolved.path) !== context.checkpoints.path ||
      !CHECKPOINT_FILE_PATTERN.test(basename(resolved.path)) || !isStableCheckpointContext(omcRoot, context)) return null;
    const raw = readBoundedCheckpoint(resolved.path, resolved);
    if (raw === null) return null;
    const checkpoint = JSON.parse(raw);
    if (checkpoint.session_id !== sessionId || typeof checkpoint.created_at !== 'string' ||
      !Number.isFinite(Date.parse(checkpoint.created_at))) return null;
    if (checkpoint.active_modes !== undefined &&
      (checkpoint.active_modes === null || typeof checkpoint.active_modes !== 'object' || Array.isArray(checkpoint.active_modes) ||
       Object.values(checkpoint.active_modes).some((mode) => mode !== null && (typeof mode !== 'object' || Array.isArray(mode))))) return null;
    const stat = lstatSync(resolved.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 ||
      stat.dev !== resolved.dev || stat.ino !== resolved.ino) return null;
    return {
      path: resolved.path,
      createdAt: checkpoint.created_at,
      mtimeMs: normalizeMtimeMs(stat.mtimeMs),
      name: basename(resolved.path),
      contentSha256: createHash('sha256').update(raw).digest('hex'),
    };
  } catch {
    return null;
  }
}





















function markerOrderMatches(marker, order) {
  return !!order && typeof marker?.checkpoint_created_at === 'string' &&
    typeof marker?.checkpoint_mtime_ms === 'number' && typeof marker?.checkpoint_sha256 === 'string' &&
    marker.checkpoint_created_at === order.createdAt &&
    marker.checkpoint_mtime_ms === order.mtimeMs && marker.checkpoint_sha256 === order.contentSha256;
}

function claimNameForMarker(marker) {
  if (!isValidSessionId(marker?.session_id) || typeof marker?.checkpoint !== 'string' ||
    typeof marker?.checkpoint_created_at !== 'string' || typeof marker?.checkpoint_mtime_ms !== 'number' ||
    typeof marker?.checkpoint_sha256 !== 'string' || !Number.isFinite(Date.parse(marker.checkpoint_created_at)) ||
    !Number.isSafeInteger(marker.checkpoint_mtime_ms) || marker.checkpoint_mtime_ms < 0 ||
    !/^[0-9a-f]{64}$/.test(marker.checkpoint_sha256)) return null;
  const digest = createHash('sha256').update(
    `${marker.session_id}\0${marker.checkpoint}\0${marker.checkpoint_created_at}\0${marker.checkpoint_mtime_ms}\0${marker.checkpoint_sha256}`,
  ).digest('hex');
  return `restored-${digest}.json`;
}

function canonicalMarkerRaw(marker) {
  return JSON.stringify({
    session_id: marker.session_id,
    checkpoint: marker.checkpoint,
    checkpoint_created_at: marker.checkpoint_created_at,
    checkpoint_mtime_ms: marker.checkpoint_mtime_ms,
    checkpoint_sha256: marker.checkpoint_sha256,
    claim_id: marker.claim_id,
  });
}

function markerEntryOrder(omcRoot, target, sessionId, name) {
  try {
    const path = join(target.parent.path, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (name === 'restored.json' && stat.nlink !== 1)) return null;
    const resolved = realpathSync(path);
    if (resolved !== path || !isPathWithin(target.context.omcRoot.path, resolved)) return null;
    const raw = readBoundedFile(
      path,
      { path: resolved, dev: stat.dev, ino: stat.ino },
      RESTORE_MARKER_MAX_BYTES,
      name !== 'restored.json',
    );
    if (raw === null) return null;
    const marker = JSON.parse(raw);
    if (marker?.session_id !== sessionId || typeof marker?.checkpoint !== 'string') return null;
    const expectedClaimName = claimNameForMarker(marker);
    if (!expectedClaimName || marker?.claim_id !== expectedClaimName || raw !== canonicalMarkerRaw(marker)) return null;
    if (name === 'restored.json') {
      const claimPath = join(target.parent.path, marker.claim_id);
      const claimStat = lstatSync(claimPath);
      if (!claimStat.isFile() || claimStat.isSymbolicLink()) return null;
      const claimResolved = realpathSync(claimPath);
      const claimRaw = readBoundedFile(
        claimPath,
        { path: claimResolved, dev: claimStat.dev, ino: claimStat.ino },
        RESTORE_MARKER_MAX_BYTES,
        true,
      );
      if (claimRaw !== raw) return null;
    } else if (expectedClaimName !== name) {
      return null;
    }
    const order = checkpointOrderForSession(omcRoot, marker.checkpoint, sessionId);
    return markerOrderMatches(marker, order) && marker.checkpoint === order?.path
      ? { checkpoint: marker.checkpoint, order }
      : null;
  } catch {
    return null;
  }
}

function newestSessionMarkerClaim(omcRoot, target, sessionId) {
  let newest = null;
  try {
    if (!isStableRestoreMarkerTarget(target)) return null;
    const names = readdirSync(target.parent.path).filter((name) => RESTORE_CLAIM_PATTERN.test(name));
    for (const name of names) {
      const entry = markerEntryOrder(omcRoot, target, sessionId, name);
      if (entry && (!newest || compareCheckpointOrder(entry.order, newest.order) > 0)) newest = entry;
    }
  } catch { /* fail closed */ }
  return newest;
}



function isCheckpointRestored(omcRoot, sessionId, checkpointPath) {
  try {
    if (!isValidSessionId(sessionId)) return false;
    const target = getRestoreMarkerTarget(omcRoot, sessionId);
    if (!target) return false;
    const newest = newestSessionMarkerClaim(omcRoot, target, sessionId);
    const candidateOrder = checkpointOrderForSession(omcRoot, checkpointPath, sessionId);
    if (newest && candidateOrder && compareCheckpointOrder(newest.order, candidateOrder) >= 0) return true;
    return false;
  } catch {
    return false;
  }
}

function markCheckpointRestored(omcRoot, sessionId, checkpointPath, checkpointCreatedAt, checkpointMtimeMs, checkpointSha256) {
  if (!isValidSessionId(sessionId)) return 'invalid_session_id';
  try {
    if (!ensureRestoreMarkerTarget(omcRoot, sessionId)) return 'unsupported';
    const target = getRestoreMarkerTarget(omcRoot, sessionId);
    if (!target) return 'failed';
    const candidateOrder = checkpointOrderForSession(omcRoot, checkpointPath, sessionId);
    if (!candidateOrder) return 'failed';
    const canonicalCheckpointPath = candidateOrder.path;
    if (!canonicalCheckpointPath) return 'failed';
    if (checkpointCreatedAt !== undefined && candidateOrder.createdAt !== checkpointCreatedAt) return 'contended';
    if (checkpointMtimeMs !== undefined && candidateOrder.mtimeMs !== normalizeMtimeMs(checkpointMtimeMs)) return 'contended';
    if (checkpointSha256 !== undefined && candidateOrder.contentSha256 !== checkpointSha256) return 'contended';
    const result = runPublisher({
      operation: 'publish',
      sessionId,
      checkpointPath: canonicalCheckpointPath,
      checkpointCreatedAt: candidateOrder.createdAt,
      checkpointMtimeMs: candidateOrder.mtimeMs,
      checkpointSha256: checkpointSha256 ?? candidateOrder.contentSha256,
      checkpointRoot: target.context.checkpoints,
      expectedCwd: target.parent,
    }, target.parent.path);
    if (!isStableRestoreMarkerTarget(target)) return 'failed';
    const publishedOrder = checkpointOrderForSession(omcRoot, canonicalCheckpointPath, sessionId);
    if (!publishedOrder || compareCheckpointOrder(candidateOrder, publishedOrder) !== 0) return 'contended';
    if (result?.status === 'written') {
      const claimName = claimNameForMarker({
        session_id: sessionId,
        checkpoint: canonicalCheckpointPath,
        checkpoint_created_at: candidateOrder.createdAt,
        checkpoint_mtime_ms: candidateOrder.mtimeMs,
        checkpoint_sha256: candidateOrder.contentSha256,
      });
      if (!claimName || !markerEntryOrder(omcRoot, target, sessionId, claimName)) return 'failed';
    }
    if (result?.status === 'existing') {
      const newest = newestSessionMarkerClaim(omcRoot, target, sessionId);
      if (!newest || compareCheckpointOrder(newest.order, candidateOrder) < 0) return 'failed';
    }
    return result?.status === 'written' || result?.status === 'existing' || result?.status === 'contended'
      ? result.status
      : 'failed';
  } catch (error) {
    return error?.code === 'EEXIST' ? 'existing' : 'failed';
  }
}

function parseCheckpoint(omcRoot, candidate, context) {
  try {
    const raw = readBoundedCheckpoint(candidate.path, candidate.verified);
    if (raw === null || !isStableCheckpointContext(omcRoot, context)) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.created_at !== 'string' || !Number.isFinite(Date.parse(parsed.created_at)) ||
      !isValidSessionId(parsed?.session_id)) return null;
    if (parsed.active_modes !== undefined &&
      (parsed.active_modes === null || typeof parsed.active_modes !== 'object' || Array.isArray(parsed.active_modes) ||
       Object.values(parsed.active_modes).some((mode) => mode !== null && (typeof mode !== 'object' || Array.isArray(mode))))) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isWithinAgeBound(createdAt) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return false;
  const age = Date.now() - created;
  return age >= 0 && age <= CHECKPOINT_MAX_AGE_MS;
}

function formatRestoreContext(checkpoint, path) {
  const lines = [
    '[PRECOMPACT CHECKPOINT RESTORED]',
    '',
    `Checkpoint: ${checkpoint.created_at} (trigger: ${checkpoint.trigger})`,
    'Source: PreCompact checkpoint written before the last compaction.',
  ];
  const modes = checkpoint.active_modes || {};
  const entries = Object.entries(modes).filter(([, value]) => value != null);
  if (entries.length > 0) {
    lines.push('', 'Active modes at compaction time:');
    for (const [name, mode] of entries) {
      if (mode === null || typeof mode !== 'object' || Array.isArray(mode)) continue;
      if ('iteration' in mode && typeof mode.iteration === 'number') lines.push(`- ${name} (iteration ${mode.iteration})`);
      else if ('cycle' in mode && typeof mode.cycle === 'number') lines.push(`- ${name} (cycle ${mode.cycle})`);
      else if ('phase' in mode && typeof mode.phase === 'string') lines.push(`- ${name} (phase ${mode.phase})`);
      else lines.push(`- ${name}`);
    }
  }
  const todos = checkpoint.todo_summary || {};
  const todoTotal = (todos.pending || 0) + (todos.in_progress || 0) + (todos.completed || 0);
  if (todoTotal > 0) lines.push('', `TODOs at compaction time: ${todos.pending} pending, ${todos.in_progress} in progress, ${todos.completed} completed.`);
  const refs = checkpoint.plan_refs;
  if (refs?.prd) {
    const prd = refs.prd;
    lines.push('', `Active PRD: ${prd.title || 'untitled'} (status: ${prd.status || 'unknown'}, stories: ${prd.stories_completed || 0}/${prd.stories_total || 0})`);
    lines.push(`PRD file: ${prd.path}`);
  }
  if (refs?.boulder) {
    const boulder = refs.boulder;
    lines.push('', `Active plan (boulder): ${boulder.plan_name || 'unnamed'} — ${(boulder.progress?.completed) || 0}/${(boulder.progress?.total) || 0} steps done.`);
    lines.push(`Plan file: ${boulder.active_plan}`);
  }
  if (checkpoint.wisdom_exported) lines.push('', 'Plan wisdom was exported before compaction (see .omc/state/checkpoints/wisdom-*.md).');
  lines.push('', 'Treat this as prior-session context only. Prioritize the current user request; consult the plan/PRD files above before resuming long-running work.', `Raw checkpoint: ${path}`);
  const text = lines.join('\n');
  return text.length <= RESTORE_CONTEXT_MAX_CHARS ? text : text.slice(0, RESTORE_CONTEXT_MAX_CHARS - 1) + '…';
}

function preparePreCompactCheckpointRestoreOnce(omcRoot, sessionId) {
  try {
    if (!isValidSessionId(sessionId)) return null;
    const context = getCanonicalCheckpointContext(omcRoot);
    if (!context || !isStableCheckpointContext(omcRoot, context)) return null;
    const checkpointDir = join(omcRoot, 'state', 'checkpoints');
    let entries;
    try { entries = readdirSync(checkpointDir); } catch { return null; }
    const candidates = [];
    for (const name of entries) {
      if (!CHECKPOINT_FILE_PATTERN.test(name)) continue;
      const path = join(checkpointDir, name);
      try {
        const verified = resolveContainedRegularPath(context, omcRoot, path);
        if (!verified) continue;
        const stat = lstatSync(verified.path);
        const raw = readBoundedCheckpoint(verified.path, verified);
        if (raw === null) continue;
        const checkpoint = parseCheckpoint(omcRoot, { name, path, mtimeMs: normalizeMtimeMs(stat.mtimeMs), verified }, context);
        if (checkpoint?.session_id !== sessionId) continue;
        try {
          if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(checkpoint)) continue;
        } catch {
          continue;
        }
        candidates.push({ name, path, mtimeMs: normalizeMtimeMs(stat.mtimeMs), checkpoint, contentSha256: createHash('sha256').update(raw).digest('hex') });
      } catch { /* skip unreadable */ }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const order = compareCheckpointOrder(
        { createdAt: a.checkpoint.created_at, mtimeMs: a.mtimeMs, name: a.name, contentSha256: a.contentSha256 },
        { createdAt: b.checkpoint.created_at, mtimeMs: b.mtimeMs, name: b.name, contentSha256: b.contentSha256 },
      );
      return -order;
    });
    for (const candidate of candidates) {
      if (isCheckpointRestored(omcRoot, sessionId, candidate.path)) return null;
      if (!isWithinAgeBound(candidate.checkpoint.created_at)) continue;
      return {
        text: formatRestoreContext(candidate.checkpoint, candidate.path),
        path: candidate.path,
        created_at: candidate.checkpoint.created_at,
        mtime_ms: candidate.mtimeMs,
        checkpoint_sha256: candidate.contentSha256,
      };
    }
    return null;
  } catch {
    return null;
  }
}



export function preparePreCompactCheckpointRestore(omcRoot, sessionId) {
  return preparePreCompactCheckpointRestoreOnce(omcRoot, sessionId);
}

export function claimPreCompactCheckpointRestore(
  omcRoot, sessionId, checkpointPath, checkpointCreatedAt, checkpointMtimeMs, checkpointSha256,
) {
  if (!isValidSessionId(sessionId)) return 'invalid_session_id';
  const currentOrder = checkpointOrderForSession(omcRoot, checkpointPath, sessionId);
  if (!currentOrder || currentOrder.createdAt !== checkpointCreatedAt ||
    currentOrder.mtimeMs !== normalizeMtimeMs(checkpointMtimeMs) ||
    (checkpointSha256 !== undefined && currentOrder.contentSha256 !== checkpointSha256)) return 'contended';
  return markCheckpointRestored(omcRoot, sessionId, checkpointPath, checkpointCreatedAt, checkpointMtimeMs, checkpointSha256);
}

export function commitPreCompactCheckpointRestore(
  omcRoot, sessionId, checkpointPath, checkpointCreatedAt, checkpointMtimeMs, checkpointSha256,
) {
  const marker_status = claimPreCompactCheckpointRestore(
    omcRoot, sessionId, checkpointPath, checkpointCreatedAt, checkpointMtimeMs, checkpointSha256,
  );
  return marker_status === 'written' ? marker_status : null;
}

export function restorePreCompactCheckpoint(omcRoot, sessionId) {
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < RESTORE_LOCK_RETRY_ATTEMPTS; attempt += 1) {
    const prepared = preparePreCompactCheckpointRestore(omcRoot, sessionId);
    if (!prepared) return null;
    const marker_status = markCheckpointRestored(
      omcRoot,
      sessionId,
      prepared.path,
      prepared.created_at,
      prepared.mtime_ms,
      prepared.checkpoint_sha256,
    );
    if (marker_status === 'written') return { ...prepared, marker_status };
    if (marker_status !== 'contended') return null;
    Atomics.wait(waitCell, 0, 0, RESTORE_LOCK_RETRY_MS);
  }
  return null;
}
