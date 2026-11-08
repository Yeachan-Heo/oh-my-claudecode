import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeSync,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
import { basename, dirname, isAbsolute, join, relative, sep } from 'path';

const MARKER_ROOT_NAME = 'checkpoints-restored';
const MARKER_MAX_BYTES = 16 * 1024;
const CHECKPOINT_MAX_BYTES = 256 * 1024;
const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const WINDOWS_RESERVED_SESSION_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const CLAIM_PATTERN = /^restored-[0-9a-f]{64}\.json$/;
const CHECKPOINT_PATTERN = /^checkpoint-.+\.json$/;

function validSession(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_ALLOWLIST.test(sessionId) &&
    !WINDOWS_RESERVED_SESSION_ID.test(sessionId);
}

function code(error) {
  return error?.code;
}

function normalizeMtimeMs(value) {
  return Math.trunc(value);
}

function verifyCwd(expected) {
  try {
    const stat = lstatSync('.');
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      stat.dev === expected.dev && stat.ino === expected.ino &&
      realpathSync('.') === expected.path;
  } catch {
    return false;
  }
}

function verifyRelativeDirectory(path, expectedPath) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === expectedPath ? stat : null;
  } catch {
    return null;
  }
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function verifyCheckpointRoot(expected) {
  try {
    const stat = lstatSync(expected.path);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino &&
      realpathSync(expected.path) === expected.path;
  } catch {
    return false;
  }
}

function readFileBounded(path, maxBytes, allowHardlinks = false) {
  const readOnly = constants.O_RDONLY;
  if (typeof readOnly !== 'number') return null;
  const noFollow = constants.O_NOFOLLOW;
  let fd = null;
  try {
    const beforePath = lstatSync(path);
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || (!allowHardlinks && beforePath.nlink > 1) || beforePath.size > maxBytes) return null;
    fd = openSync(path, readOnly | (typeof noFollow === 'number' && noFollow !== 0 ? noFollow : 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.isSymbolicLink() || (!allowHardlinks && before.nlink > 1) || before.size > maxBytes) return null;
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, null);
      if (!Number.isInteger(count) || count <= 0) return null;
      offset += count;
    }
    const after = fstatSync(fd);
    const afterPath = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || (!allowHardlinks && after.nlink > 1) || after.size !== before.size ||
      after.dev !== before.dev || after.ino !== before.ino || afterPath.dev !== before.dev ||
      afterPath.ino !== before.ino || afterPath.isSymbolicLink() || (!allowHardlinks && afterPath.nlink > 1)) return null;
    return data;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function writeExclusive(path, bytes) {
  const create = constants.O_CREAT;
  const exclusive = constants.O_EXCL;
  const writeOnly = constants.O_WRONLY;
  if (typeof create !== 'number' || typeof exclusive !== 'number' || typeof writeOnly !== 'number') return null;
  const noFollow = constants.O_NOFOLLOW;
  const flags = create | exclusive | writeOnly | (typeof noFollow === 'number' && noFollow !== 0 ? noFollow : 0);
  let fd = null;
  try {
    fd = openSync(path, flags, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isInteger(count) || count <= 0) return null;
      offset += count;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === bytes.length ? stat : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function checkpointMatches(request, checkpointRoot = request.checkpointRoot) {
  try {
    if (!checkpointRoot || !verifyCheckpointRoot(checkpointRoot) || !isAbsolute(request.checkpointPath) ||
      !isWithin(checkpointRoot.path, request.checkpointPath) || dirname(request.checkpointPath) !== checkpointRoot.path ||
      !CHECKPOINT_PATTERN.test(basename(request.checkpointPath))) return false;
    const stat = lstatSync(request.checkpointPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false;
    if (realpathSync(request.checkpointPath) !== request.checkpointPath) return false;
    const raw = readFileBounded(request.checkpointPath, CHECKPOINT_MAX_BYTES);
    if (raw === null || createHash('sha256').update(raw).digest('hex') !== request.checkpointSha256) return false;
    const checkpoint = JSON.parse(raw.toString('utf8'));
    if (checkpoint?.session_id !== request.sessionId || checkpoint?.created_at !== request.checkpointCreatedAt ||
      !Number.isFinite(Date.parse(checkpoint.created_at))) return false;
    if (checkpoint.active_modes !== undefined &&
      (checkpoint.active_modes === null || typeof checkpoint.active_modes !== 'object' || Array.isArray(checkpoint.active_modes) ||
       Object.values(checkpoint.active_modes).some((mode) => mode !== null && (typeof mode !== 'object' || Array.isArray(mode))))) return false;
    return normalizeMtimeMs(stat.mtimeMs) === normalizeMtimeMs(request.checkpointMtimeMs);
  } catch {
    return false;
  }
}

function claimNameFor(marker) {
  if (!validSession(marker?.session_id) || typeof marker?.checkpoint !== 'string' ||
    typeof marker?.checkpoint_created_at !== 'string' || typeof marker?.checkpoint_mtime_ms !== 'number' ||
    typeof marker?.checkpoint_sha256 !== 'string' || !Number.isFinite(Date.parse(marker.checkpoint_created_at)) ||
    !Number.isSafeInteger(marker.checkpoint_mtime_ms) || marker.checkpoint_mtime_ms < 0 ||
    !/^[0-9a-f]{64}$/.test(marker.checkpoint_sha256)) return null;
  const digest = createHash('sha256').update(
    `${marker.session_id}\0${marker.checkpoint}\0${marker.checkpoint_created_at}\0${marker.checkpoint_mtime_ms}\0${marker.checkpoint_sha256}`,
  ).digest('hex');
  return `restored-${digest}.json`;
}

function canonicalMarkerBytes(marker) {
  return Buffer.from(JSON.stringify({
    session_id: marker.session_id,
    checkpoint: marker.checkpoint,
    checkpoint_created_at: marker.checkpoint_created_at,
    checkpoint_mtime_ms: marker.checkpoint_mtime_ms,
    checkpoint_sha256: marker.checkpoint_sha256,
    claim_id: marker.claim_id,
  }), 'utf8');
}

function orderFromMarker(marker) {
  const claimId = claimNameFor(marker);
  if (!claimId || marker.claim_id !== claimId) return null;
  return {
    checkpoint: marker.checkpoint,
    createdAt: marker.checkpoint_created_at,
    mtimeMs: marker.checkpoint_mtime_ms,
    name: basename(marker.checkpoint),
    contentSha256: marker.checkpoint_sha256,
    claimId,
  };
}

function compareOrder(a, b) {
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  if (at !== bt) return at - bt;
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
  const names = Buffer.compare(Buffer.from(a.name), Buffer.from(b.name));
  if (names !== 0) return names;
  return Buffer.compare(Buffer.from(a.contentSha256), Buffer.from(b.contentSha256));
}

function readClaim(name, checkpointRoot) {
  try {
    if (!CLAIM_PATTERN.test(name)) return null;
    const raw = readFileBounded(name, MARKER_MAX_BYTES, true);
    if (raw === null) return null;
    const marker = JSON.parse(raw.toString('utf8'));
    const order = orderFromMarker(marker);
    if (!order || order.claimId !== name || !raw.equals(canonicalMarkerBytes(marker)) || !checkpointMatches({
      sessionId: marker.session_id,
      checkpointPath: marker.checkpoint,
      checkpointCreatedAt: marker.checkpoint_created_at,
      checkpointMtimeMs: marker.checkpoint_mtime_ms,
      checkpointSha256: marker.checkpoint_sha256,
    }, checkpointRoot)) return null;
    return { marker, order, raw };
  } catch {
    return null;
  }
}

function newestClaim(sessionId, checkpointRoot) {
  let newest = null;
  for (const name of readdirSync('.')) {
    if (!CLAIM_PATTERN.test(name)) continue;
    const entry = readClaim(name, checkpointRoot);
    if (!entry || entry.marker.session_id !== sessionId) continue;
    if (!newest || compareOrder(entry.order, newest.order) > 0) newest = entry;
  }
  return newest;
}

function createStage(request, prefix, bytes) {
  if (!verifyCwd(request.expectedCwd)) return null;
  const path = `.restored-stage-${prefix}-${randomUUID()}`;
  const stat = writeExclusive(path, bytes);
  if (!stat || !verifyCwd(request.expectedCwd)) return null;
  return { path, dev: stat.dev, ino: stat.ino };
}

function project(request, bytes) {
  const stage = createStage(request, 'projection', bytes);
  if (!stage) return false;
  try {
    if (!verifyCwd(request.expectedCwd)) return false;
    try {
      const projection = lstatSync('restored.json');
      if (!projection.isFile() || projection.isSymbolicLink() || projection.nlink !== 1 || realpathSync('restored.json') !== join(realpathSync('.'), 'restored.json')) return false;
    } catch (error) {
      if (code(error) !== 'ENOENT') return false;
    }
    renameSync(stage.path, 'restored.json');
    return true;
  } catch {
    return false;
  }
}

function publish(request) {
  if (!validSession(request.sessionId) || !checkpointMatches(request)) return { status: 'contended' };
  const candidate = {
    checkpoint: request.checkpointPath,
    createdAt: request.checkpointCreatedAt,
    mtimeMs: request.checkpointMtimeMs,
    name: basename(request.checkpointPath),
    contentSha256: request.checkpointSha256,
  };
  const existing = newestClaim(request.sessionId, request.checkpointRoot);
  if (existing && compareOrder(existing.order, candidate) >= 0) return { status: 'existing' };

  try {
    const marker = {
      session_id: request.sessionId,
      checkpoint: request.checkpointPath,
      checkpoint_created_at: request.checkpointCreatedAt,
      checkpoint_mtime_ms: request.checkpointMtimeMs,
      checkpoint_sha256: request.checkpointSha256,
    };
    const claimName = claimNameFor(marker);
    if (!claimName) return { status: 'failed' };
    marker.claim_id = claimName;
    const bytes = canonicalMarkerBytes(marker);

    if (!checkpointMatches(request) || !project(request, bytes)) return { status: 'failed' };
    const stage = createStage(request, 'claim', bytes);
    if (!stage || !checkpointMatches(request)) return { status: 'contended' };

    let created = false;
    try {
      linkSync(stage.path, claimName);
      created = true;
      const createdClaim = readClaim(claimName, request.checkpointRoot);
      if (!createdClaim || !createdClaim.raw.equals(bytes)) return { status: 'failed' };
    } catch (error) {
      if (code(error) !== 'EEXIST') return { status: 'failed' };
      const claim = readClaim(claimName, request.checkpointRoot);
      if (!claim || !claim.raw.equals(bytes)) return { status: 'failed' };
    }

    const claim = readClaim(claimName, request.checkpointRoot);
    if (!claim || !claim.raw.equals(bytes) || !checkpointMatches(request)) return { status: 'contended' };
    const authoritative = newestClaim(request.sessionId, request.checkpointRoot);
    if (!authoritative) return { status: 'failed' };
    if (compareOrder(authoritative.order, candidate) > 0) {
      project(request, authoritative.raw);
      return { status: 'existing' };
    }
    if (!authoritative.raw.equals(bytes)) return { status: 'existing' };
    project(request, bytes);
    return { status: created ? 'written' : 'existing' };
  } finally { /* claim witnesses and uncertain stages are retained; never delete through a raced pathname */ }
}

function ensureChild(request, childName) {
  if (!verifyCwd(request.expectedCwd)) return { status: 'failed' };
  try {
    mkdirSync(childName, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (code(error) !== 'EEXIST') return { status: 'failed' };
  }
  const child = verifyRelativeDirectory(childName, join(request.expectedCwd.path, childName));
  return child ? { status: 'ready', dev: child.dev, ino: child.ino, path: realpathSync(childName) } : { status: 'failed' };
}

function main() {
  let request;
  try { request = JSON.parse(readFileSync(0, 'utf8')); } catch { request = null; }
  if (!request) return { status: 'failed' };
  if (request.operation === 'ensure-root') return ensureChild(request, MARKER_ROOT_NAME);
  if (request.operation === 'ensure-session' && validSession(request.sessionId)) return ensureChild(request, request.sessionId);
  if (request.operation === 'publish') {
    if (!verifyCwd(request.expectedCwd)) return { status: 'failed' };
    return publish(request);
  }
  return { status: 'failed' };
}

let result;
try {
  result = main();
} catch {
  result = { status: 'failed' };
}
process.stdout.write(JSON.stringify(result));
