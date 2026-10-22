#!/usr/bin/env node
// OMC Session Start Hook (Node.js)
// Restores persistent mode states when session starts
// Cross-platform: Windows, macOS, Linux

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, unlinkSync, rmSync, statSync, lstatSync } from 'fs';
import { join, dirname, normalize, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { getClaudeConfigDir, getUpdateCheckCachePath } = await import(pathToFileURL(join(__dirname, 'lib', 'config-dir.mjs')).href);
const configDir = getClaudeConfigDir();
const { resolveSessionStatePathsForHook, resolveOmcStateRoot } = await import(pathToFileURL(join(__dirname, 'lib', 'state-root.mjs')).href);
const { pathIdentity, publishCacheOccupancy, readOccupiedPluginRoots } = await import(pathToFileURL(join(__dirname, 'lib', 'cache-occupancy.mjs')).href);

// Detached update-cache refresh: argv flag and the child's overall deadline.
const REFRESH_UPDATE_CACHE_FLAG = '--refresh-update-cache';
const REFRESH_UPDATE_CACHE_DEADLINE_MS = 3000;

// Import timeout-protected stdin reader (prevents hangs on Linux/Windows, see issue #240, #524)
let readStdin;
try {
  const mod = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
  readStdin = mod.readStdin;
} catch {
  // Fallback: inline timeout-protected readStdin if lib module is missing
  readStdin = (timeoutMs = 5000) => new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; process.stdin.removeAllListeners(); process.stdin.destroy(); resolve(Buffer.concat(chunks).toString('utf-8')); }
    }, timeoutMs);
    process.stdin.on('data', (chunk) => { chunks.push(chunk); });
    process.stdin.on('end', () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf-8')); } });
    process.stdin.on('error', () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(''); } });
    if (process.stdin.readableEnded) { if (!settled) { settled = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf-8')); } }
  });
}

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

const TOOL_FAILURE_TEMP_FILE_PATTERN = /^\.last-tool-error(?:-state)?\.json\.tmp\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOOL_FAILURE_TEMP_MIN_AGE_MS = 60_000;
const SANITIZED_TOOL_FAILURE_ERROR = 'Tool execution failed (details omitted for privacy).';

function unlinkRegularFile(path) {
  try {
    if (lstatSync(path).isFile()) unlinkSync(path);
  } catch {
    // Legacy-state cleanup is best-effort and must not affect SessionStart.
  }
}

function isSanitizedToolFailureState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  const keys = Object.keys(state).sort();
  return keys.length === 4
    && keys[0] === 'error'
    && keys[1] === 'retry_count'
    && keys[2] === 'timestamp'
    && keys[3] === 'tool_name'
    && typeof state.tool_name === 'string'
    && state.tool_name.length > 0
    && state.error === SANITIZED_TOOL_FAILURE_ERROR
    && typeof state.timestamp === 'string'
    && Number.isFinite(Date.parse(state.timestamp))
    && Number.isInteger(state.retry_count);
}

function purgeLegacyToolFailureFile(path) {
  let content;
  try {
    if (!lstatSync(path).isFile()) return;
    content = readFileSync(path, 'utf-8');
  } catch {
    return;
  }

  let state;
  try {
    state = JSON.parse(content);
  } catch {
    unlinkRegularFile(path);
    return;
  }
  if (!isSanitizedToolFailureState(state)) unlinkRegularFile(path);
}

function purgeToolFailureTemps(directory) {
  let entries;
  try {
    if (!lstatSync(directory).isDirectory()) return;
    entries = readdirSync(directory);
  } catch {
    return;
  }

  for (const name of entries) {
    if (!TOOL_FAILURE_TEMP_FILE_PATTERN.test(name)) continue;
    const path = join(directory, name);
    try {
      const stats = lstatSync(path);
      if (!stats.isFile()) continue;
      let state;
      try { state = JSON.parse(readFileSync(path, 'utf-8')); } catch {}
      if (isSanitizedToolFailureState(state) && Date.now() - stats.mtimeMs < TOOL_FAILURE_TEMP_MIN_AGE_MS) continue;
      unlinkRegularFile(path);
    } catch {
      // A concurrent or inaccessible temp file must not affect SessionStart.
    }
  }
}

const POST_TOOL_FAILURE_LOCK_WAIT_MS = 2500;
const POST_TOOL_FAILURE_SQLITE_BUSY_WAIT_MS = 100;
const POST_TOOL_FAILURE_PROCESS_PROBE_MAX_MS = 2000;
const SESSION_START_HOOK_TIMEOUT_MS = 5000;
const SESSION_START_OCCUPANCY_PROBE_MAX_MS = 2000;
const SESSION_START_OUTPUT_RESERVE_MS = 750;
const POST_TOOL_FAILURE_DEFERRED_WAIT_MS = 30_000;
const POST_TOOL_FAILURE_LOCK_RETRY_MS = 50;
const DEFERRED_TOOL_FAILURE_CLEANUP_FLAG = '--purge-legacy-tool-failure-state';
const STABILIZE_TOOL_FAILURE_CLEANUP_FLAG = '--stabilize-legacy-tool-failure-state';
const TOOL_FAILURE_CLEANUP_STABILIZATION_MS = 30_000;
const TOOL_FAILURE_CLEANUP_RESCAN_MS = 250;
const TOOL_FAILURE_PLUGIN_ROOT_RESCAN_MS = 5000;
const TOOL_FAILURE_CLEANUP_LIFETIME_WINDOWS = 10;
const TOOL_FAILURE_CLEANUP_MIN_LIFETIME_MS = 60_000;
let postToolFailureStateLockModule;

function postToolFailureLockWaitMs() {
  if (process.env.NODE_ENV === 'test') {
    const testWaitMs = Number(process.env.OMC_TEST_TOOL_FAILURE_LOCK_WAIT_MS);
    if (Number.isFinite(testWaitMs) && testWaitMs > 0) return Math.min(testWaitMs, POST_TOOL_FAILURE_LOCK_WAIT_MS);
  }
  return POST_TOOL_FAILURE_LOCK_WAIT_MS;
}

async function loadPostToolFailureStateLock() {
  if (!postToolFailureStateLockModule) {
    postToolFailureStateLockModule = await import(pathToFileURL(join(__dirname, 'lib', 'state-lock.mjs')).href);
  }
  return postToolFailureStateLockModule;
}

async function waitForPostToolFailureLock(canonicalPath, deadline) {
  const { acquireStateFileLockAtPathSync, getStateFileLockFailureKind } = await loadPostToolFailureStateLock();
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { lock: null, timedOut: true };
    const lock = acquireStateFileLockAtPathSync(
      `${canonicalPath}.lock`, 1, true, false,
      Math.min(POST_TOOL_FAILURE_SQLITE_BUSY_WAIT_MS, remaining),
      Math.min(POST_TOOL_FAILURE_PROCESS_PROBE_MAX_MS, remaining),
    );
    if (lock) return { lock, timedOut: false };
    if (getStateFileLockFailureKind() !== 'contention') return { lock: null, timedOut: false };
    const remainingAfterAttempt = deadline - Date.now();
    if (remainingAfterAttempt > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(POST_TOOL_FAILURE_LOCK_RETRY_MS, remainingAfterAttempt)));
    }
  }
  return { lock: null, timedOut: true };
}

function releasePostToolFailureLock(lock) {
  return postToolFailureStateLockModule.releaseStateFileLockSync(lock);
}

function hasToolFailureArtifacts(directory, canonicalFilename) {
  try {
    if (!lstatSync(directory).isDirectory()) return false;
    const lockFilename = `${canonicalFilename}.lock`;
    const names = readdirSync(directory);
    if (names.some(name => name === lockFilename || TOOL_FAILURE_TEMP_FILE_PATTERN.test(name))) return true;
    return names.includes(canonicalFilename)
      && !isSanitizedToolFailureState(readJsonFile(join(directory, canonicalFilename)));
  } catch {
    return false;
  }
}

async function purgeToolFailureStateDirectory(directory, canonicalFilename, deadline, lifetimeDeadline = Infinity) {
  if (!hasToolFailureArtifacts(directory, canonicalFilename)) return false;
  const canonicalPath = join(directory, canonicalFilename);
  let postToolFailureLock;
  let lockWait;
  try {
    lockWait = await waitForPostToolFailureLock(canonicalPath, deadline);
  } catch {
    return false;
  }
  postToolFailureLock = lockWait.lock;
  if (!postToolFailureLock) return lockWait.timedOut;
  let releaseFailed = false;
  let pastLifetime = false;
  try {
    // The lock can be granted after the helper's lifetime ended: leave the artifacts.
    pastLifetime = Date.now() >= lifetimeDeadline;
    if (!pastLifetime) {
      purgeLegacyToolFailureFile(canonicalPath);
      purgeToolFailureTemps(directory);
    }
  } finally {
    releaseFailed = !releasePostToolFailureLock(postToolFailureLock);
  }
  return releaseFailed || pastLifetime;
}

function deferLegacyToolFailureCleanup(omcRoot, waitMs = POST_TOOL_FAILURE_DEFERRED_WAIT_MS) {
  try {
    const child = spawn(process.execPath, [__filename, DEFERRED_TOOL_FAILURE_CLEANUP_FLAG, omcRoot, String(waitMs)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, OMC_HOOK_BACKGROUND_CHILD: '1' },
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Deferred cleanup is best-effort and must not delay SessionStart output.
  }
}

function toolFailureCleanupStabilizationMs() {
  if (process.env.NODE_ENV === 'test') {
    const testWindow = Number(process.env.OMC_TEST_TOOL_FAILURE_STABILIZATION_MS);
    if (Number.isFinite(testWindow) && testWindow > 0) return Math.min(testWindow, 5000);
  }
  return TOOL_FAILURE_CLEANUP_STABILIZATION_MS;
}

// Hard lifetime of the detached stabilization helper. Sessions on another plugin
// version can stay open for days, so waiting for them to exit is unbounded. The
// purge is idempotent and every SessionStart purges again and starts a new
// helper, so the helper may stop waiting. A caller-supplied cap can only shorten
// the derived default.
function toolFailureCleanupMaxLifetimeMs(stabilizationMs, requestedMs) {
  const defaultMs = Math.max(
    stabilizationMs * TOOL_FAILURE_CLEANUP_LIFETIME_WINDOWS,
    TOOL_FAILURE_CLEANUP_MIN_LIFETIME_MS,
  );
  return Number.isFinite(requestedMs) && requestedMs > 0 ? Math.min(requestedMs, defaultMs) : defaultMs;
}

function shouldStabilizeToolFailureCleanup() {
  if (process.env.NODE_ENV === 'test') {
    return Number(process.env.OMC_TEST_TOOL_FAILURE_STABILIZATION_MS) > 0;
  }
  return true;
}

function deferToolFailureCleanupStabilization(omcRoot) {
  if (!shouldStabilizeToolFailureCleanup() || process.env.OMC_HOOK_BACKGROUND_CHILD === '1') return;
  try {
    const child = spawn(process.execPath, [__filename, STABILIZE_TOOL_FAILURE_CLEANUP_FLAG, omcRoot, String(toolFailureCleanupStabilizationMs())], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, OMC_HOOK_BACKGROUND_CHILD: '1' },
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Stabilization is best-effort and must not delay SessionStart output.
  }
}

function legacyToolFailureArtifactSnapshot(omcRoot) {
  const stateDir = join(omcRoot, 'state');
  const directories = [[stateDir, 'last-tool-error.json']];
  try {
    const sessionsDir = join(stateDir, 'sessions');
    if (lstatSync(sessionsDir).isDirectory()) {
      for (const sessionId of readdirSync(sessionsDir)) {
        directories.push([join(sessionsDir, sessionId), 'last-tool-error-state.json']);
      }
    }
  } catch {
    // The root-level record can still be inspected when sessions are unavailable.
  }

  const artifacts = [];
  for (const [directory, canonicalFilename] of directories) {
    let names;
    try {
      if (!lstatSync(directory).isDirectory()) continue;
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const isCanonical = name === canonicalFilename;
      const isLock = name === `${canonicalFilename}.lock`;
      const isTemp = TOOL_FAILURE_TEMP_FILE_PATTERN.test(name);
      if (!isCanonical && !isLock && !isTemp) continue;
      try {
        const path = join(directory, name);
        const stat = lstatSync(path);
        if (!stat.isFile()) continue;
        if (!isLock && isSanitizedToolFailureState(readJsonFile(path))) continue;
        artifacts.push(`${directory}\0${name}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`);
      } catch {
        // Ignore artifacts concurrently removed or replaced.
      }
    }
  }
  return artifacts.sort().join('\n');
}

// The identity probe may not outlive `lifetimeDeadline`. A probe that times out or
// has no time left identifies nothing, so every registry record is kept and its
// root counts as occupied.
function hasActiveOlderPluginRoot(lifetimeDeadline = Infinity) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) return false;
  try {
    const currentRoot = pathIdentity(pluginRoot);
    const pluginVersionsDirectory = dirname(currentRoot);
    const { roots, unavailable } = readOccupiedPluginRoots(configDir, {
      probeTimeoutMs: Math.max(0, lifetimeDeadline - Date.now()),
    });
    if (unavailable) return true;
    return [...roots].some(root => root !== currentRoot && dirname(root) === pluginVersionsDirectory);
  } catch {
    return false;
  }
}

function resolveSessionPluginOccupancy(deadline) {
  if (!process.env.CLAUDE_PLUGIN_ROOT) return null;
  const configuredOwnerPid = Number(process.env.OMC_SESSION_OWNER_PID);
  const ownerPid = Number.isSafeInteger(configuredOwnerPid) && configuredOwnerPid > 1 ? configuredOwnerPid : process.ppid;
  const probeTimeoutMs = Math.max(
    0,
    Math.min(
      SESSION_START_OCCUPANCY_PROBE_MAX_MS,
      deadline - Date.now() - SESSION_START_OUTPUT_RESERVE_MS,
    ),
  );
  const occupancy = readOccupiedPluginRoots(configDir, { includePids: [ownerPid], probeTimeoutMs });
  publishCacheOccupancy(process.env.CLAUDE_PLUGIN_ROOT, configDir, ownerPid, occupancy.identities.get(ownerPid) ?? null);
  return occupancy;
}

async function waitForTestArtifactScanRelease(scan) {
  if (process.env.NODE_ENV !== 'test') return;
  const scanPrefix = `OMC_TEST_TOOL_FAILURE_${scan}_SCAN`;
  const readyPath = process.env[`${scanPrefix}_READY_PATH`];
  const releasePath = process.env[`${scanPrefix}_RELEASE_PATH`];
  if (!readyPath || !releasePath) return;
  try {
    writeFileSync(readyPath, 'ready');
    const deadline = Date.now() + 30_000;
    while (!existsSync(releasePath) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } catch {
    // Test-only synchronization must not affect cleanup behavior.
  }
}

function signalTestDeferredToolFailureCleanupReady() {
  if (process.env.NODE_ENV !== 'test') return;
  const readyPath = process.env.OMC_TEST_TOOL_FAILURE_DEFERRED_CLEANUP_READY_PATH;
  if (!readyPath) return;
  try {
    writeFileSync(readyPath, 'ready');
  } catch {
    // Test-only synchronization must not affect cleanup behavior.
  }
}

async function stabilizeLegacyToolFailureState(omcRoot, stabilizationMs, maxLifetimeMs = toolFailureCleanupMaxLifetimeMs(stabilizationMs)) {
  const stateDir = join(omcRoot, 'state');
  const lifetimeDeadline = Date.now() + maxLifetimeMs;
  let olderPluginActive = hasActiveOlderPluginRoot(lifetimeDeadline);
  let quietUntil = Date.now() + stabilizationMs;
  let nextPluginRootCheck = Date.now() + TOOL_FAILURE_PLUGIN_ROOT_RESCAN_MS;
  while (true) {
    const now = Date.now();
    if (now >= lifetimeDeadline) return;
    try {
      if (!lstatSync(stateDir).isDirectory()) return;
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') return;
    }

    if (now >= nextPluginRootCheck) {
      olderPluginActive = hasActiveOlderPluginRoot(lifetimeDeadline);
      nextPluginRootCheck = now + TOOL_FAILURE_PLUGIN_ROOT_RESCAN_MS;
    }
    if (now >= quietUntil && !olderPluginActive) {
      olderPluginActive = hasActiveOlderPluginRoot(lifetimeDeadline);
      nextPluginRootCheck = Date.now() + TOOL_FAILURE_PLUGIN_ROOT_RESCAN_MS;
      if (!olderPluginActive) return;
    }
    const remainingQuietMs = quietUntil - Date.now();
    const pollDelayMs = remainingQuietMs > 0
      ? Math.min(TOOL_FAILURE_CLEANUP_RESCAN_MS, remainingQuietMs)
      : TOOL_FAILURE_CLEANUP_RESCAN_MS;
    await new Promise(resolve => setTimeout(resolve, pollDelayMs));
  }

  const stateLock = await loadPostToolFailureStateLock();
  // The state directory can appear at or after the deadline: bound the lock wait by the remaining lifetime.
  const workerLock = stateLock.acquireStateFileLockAtPathSync(
    join(stateDir, '.legacy-tool-failure-cleanup-worker.lock'), 300, true, false,
    undefined, undefined, Math.max(0, lifetimeDeadline - Date.now()),
  );
  if (!workerLock) return;

  try {
    // The lock can be granted at the deadline: release it without doing any work.
    if (Date.now() >= lifetimeDeadline) return;
    quietUntil = Date.now() + stabilizationMs;
    let artifactSnapshot = legacyToolFailureArtifactSnapshot(omcRoot);
    await waitForTestArtifactScanRelease('INITIAL');
    olderPluginActive = hasActiveOlderPluginRoot(lifetimeDeadline);
    nextPluginRootCheck = Date.now() + TOOL_FAILURE_PLUGIN_ROOT_RESCAN_MS;
    while (true) {
      const now = Date.now();
      if (now >= lifetimeDeadline) return;
      if (now >= nextPluginRootCheck) {
        olderPluginActive = hasActiveOlderPluginRoot(lifetimeDeadline);
        nextPluginRootCheck = now + TOOL_FAILURE_PLUGIN_ROOT_RESCAN_MS;
      }
      const currentArtifactSnapshot = legacyToolFailureArtifactSnapshot(omcRoot);
      if (currentArtifactSnapshot !== artifactSnapshot) {
        artifactSnapshot = currentArtifactSnapshot;
        quietUntil = now + stabilizationMs;
      }
      if (currentArtifactSnapshot) {
        const cleanupPending = await purgeLegacyToolFailureState(omcRoot, POST_TOOL_FAILURE_LOCK_WAIT_MS, false, lifetimeDeadline);
        if (cleanupPending) quietUntil = Date.now() + stabilizationMs;
      }
      if (Date.now() >= quietUntil && !olderPluginActive) {
        olderPluginActive = hasActiveOlderPluginRoot(lifetimeDeadline);
        nextPluginRootCheck = Date.now() + TOOL_FAILURE_PLUGIN_ROOT_RESCAN_MS;
        if (!olderPluginActive) {
          await waitForTestArtifactScanRelease('FINAL');
          const finalArtifactSnapshot = legacyToolFailureArtifactSnapshot(omcRoot);
          if (finalArtifactSnapshot !== artifactSnapshot) {
            artifactSnapshot = finalArtifactSnapshot;
            quietUntil = Date.now() + stabilizationMs;
            if (finalArtifactSnapshot) {
              const cleanupPending = await purgeLegacyToolFailureState(omcRoot, POST_TOOL_FAILURE_LOCK_WAIT_MS, false, lifetimeDeadline);
              if (cleanupPending) quietUntil = Date.now() + stabilizationMs;
            }
            continue;
          }
          break;
        }
      }
      const remainingQuietMs = quietUntil - Date.now();
      const pollDelayMs = remainingQuietMs > 0
        ? Math.min(TOOL_FAILURE_CLEANUP_RESCAN_MS, remainingQuietMs)
        : TOOL_FAILURE_CLEANUP_RESCAN_MS;
      await new Promise(resolve => setTimeout(resolve, pollDelayMs));
    }
  } finally {
    stateLock.releaseStateFileLockSync(workerLock);
  }
}

async function purgeLegacyToolFailureState(omcRoot, waitMs = postToolFailureLockWaitMs(), deferOnTimeout = true, lifetimeDeadline = Infinity) {
  const deadline = Math.min(Date.now() + waitMs, lifetimeDeadline);
  const stateDir = join(omcRoot, 'state');
  try {
    if (!lstatSync(stateDir).isDirectory()) return false;
  } catch {
    return false;
  }

  const directories = [[stateDir, 'last-tool-error.json']];
  const sessionsDir = join(stateDir, 'sessions');
  let sessions;
  try {
    sessions = lstatSync(sessionsDir).isDirectory() ? readdirSync(sessionsDir) : [];
  } catch {
    sessions = [];
  }

  for (const sessionId of sessions) {
    const sessionDir = join(sessionsDir, sessionId);
    try {
      if (lstatSync(sessionDir).isDirectory()) directories.push([sessionDir, 'last-tool-error-state.json']);
    } catch {
      // Skip inaccessible or replaced session directories.
    }
  }

  const cleanupPending = (await Promise.all(
    directories.map(([directory, filename]) => purgeToolFailureStateDirectory(directory, filename, deadline, lifetimeDeadline)),
  )).some(Boolean);
  if (cleanupPending && deferOnTimeout && !shouldStabilizeToolFailureCleanup()) {
    deferLegacyToolFailureCleanup(omcRoot, POST_TOOL_FAILURE_DEFERRED_WAIT_MS);
  }
  return cleanupPending;
}

function writeJsonFile(path, data) {
  try {
    const dir = join(path, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}


const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const WORKFLOW_SLOT_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

async function isWorkflowSlotTombstonedForMode(directory, mode, sessionId) {
  const safeSessionId = typeof sessionId === 'string' && SESSION_ID_ALLOWLIST.test(sessionId) ? sessionId : '';
  const { readPath } = await resolveSessionStatePathsForHook(directory, 'skill-active', safeSessionId || undefined);
  const ledgerPath = readPath;
  const ledger = readJsonFile(ledgerPath);
  const slot = ledger?.active_skills?.[mode];
  if (!slot || typeof slot !== 'object') return false;
  if (typeof slot.completed_at !== 'string' || !slot.completed_at) return false;
  const completedAt = new Date(slot.completed_at).getTime();
  if (!Number.isFinite(completedAt)) return true;
  return Date.now() - completedAt < WORKFLOW_SLOT_TOMBSTONE_TTL_MS;
}

async function shouldRestoreModeState(directory, mode, state, sessionId) {
  if (!state?.active) return false;
  if (await isWorkflowSlotTombstonedForMode(directory, mode, sessionId)) return false;
  return true;
}

// Read version from OMC's own package.json, not the project's (fixes #516)
function resolveOmcVersion() {
  for (let i = 1; i <= 4; i++) {
    const candidate = join(__dirname, ...Array(i).fill('..'), 'package.json');
    const pkg = readJsonFile(candidate);
    if ((pkg?.name === 'oh-my-claude-sisyphus' || pkg?.name === 'oh-my-claudecode') && pkg?.version) {
      return pkg.version;
    }
  }
  return null;
}

// Registry base override. Only honoured when set; tests point it at a closed
// port to exercise the offline/timeout paths without touching the network.
function registryLatestUrl(packageName) {
  const base = process.env.OMC_UPDATE_REGISTRY_BASE;
  const root = base ? base.replace(/\/+$/, '') : 'https://registry.npmjs.org';
  return `${root}/${packageName}/latest`;
}

function readUpdateCheckCache() {
  const cached = readJsonFile(getUpdateCheckCachePath());
  return cached && typeof cached === 'object' && !Array.isArray(cached) ? cached : {};
}

// Merge into the existing cache so unrelated fields (e.g. the Claude Code
// version tracked below) survive an OMC-only refresh. Refresh children from
// concurrent sessions share this file, so serialize the read/modify/write and
// publish a complete JSON document with a same-directory rename.
function mergeUpdateCheckCache(fields) {
  const cachePath = getUpdateCheckCachePath();
  const cacheDir = dirname(cachePath);
  const lockPath = `${cachePath}.lock`;
  const deadline = Date.now() + 1000;
  let locked = false;

  try {
    mkdirSync(cacheDir, { recursive: true });
    while (!locked && Date.now() < deadline) {
      try {
        mkdirSync(lockPath);
        locked = true;
      } catch {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 10_000) {
            rmSync(lockPath, { recursive: true, force: true });
          }
        } catch {}
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } catch {}
      }
    }
    if (!locked) return;

    const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({ ...readUpdateCheckCache(), ...fields }), 'utf-8');
    try {
      renameSync(temporaryPath, cachePath);
    } catch {
      // Windows cannot replace an existing file with rename. The lock keeps
      // other writers out; readers already tolerate a missing cache briefly.
      try { unlinkSync(cachePath); } catch {}
      renameSync(temporaryPath, cachePath);
    }
  } catch {
    // Cache refresh is best-effort and must never affect session startup.
  } finally {
    if (locked) {
      try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
    }
  }
}

// Refresh the cached latest Claude Code version (same 24h window and 2s timeout
// as the OMC check) so the HUD can show a Claude Code update hint. The field is
// simply absent on caches written before this check existed.
async function checkClaudeCodeUpdate() {
  const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
  const cached = readUpdateCheckCache();
  if (cached.claudeCodeCheckedAt && (Date.now() - cached.claudeCodeCheckedAt) < CACHE_DURATION) return;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(registryLatestUrl('@anthropic-ai/claude-code'), {
      signal: controller.signal
    });
    if (!response.ok) return;

    const data = await response.json();
    if (!data?.version) return;
    mergeUpdateCheckCache({ claudeCodeLatestVersion: data.version, claudeCodeCheckedAt: Date.now() });
  } catch {
    // Silent fail - network unavailable or timeout
  } finally { clearTimeout(timeoutId); }
}

async function checkForUpdates(currentVersion) {
  const cacheFile = getUpdateCheckCachePath();
  const now = Date.now();
  const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

  // Check cache first
  const cached = readJsonFile(cacheFile);
  if (cached && cached.timestamp && (now - cached.timestamp) < CACHE_DURATION) {
    return cached.updateAvailable ? cached : null;
  }

  // Fetch latest version from npm
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(registryLatestUrl('oh-my-claude-sisyphus'), {
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error('Network response was not ok');
    }

    const data = await response.json();
    const latestVersion = data.version;

    const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

    const cacheData = {
      timestamp: now,
      latestVersion,
      currentVersion,
      updateAvailable,
      // This hook only queries npm; pin the source so the merge does not
      // preserve a stale marketplace value from an earlier plugin install.
      source: 'npm'
    };

    mergeUpdateCheckCache(cacheData);

    return updateAvailable ? cacheData : null;
  } catch (error) {
    // Silent fail - network unavailable or timeout
    return null;
  } finally { clearTimeout(timeoutId); }
}

// Concurrent: each fetch aborts after 2s, and SessionStart hooks have a 5s
// budget, so running them in sequence would risk a cold-cache timeout.
async function runUpdateChecks() {
  const currentVersion = resolveOmcVersion();
  const [updateInfo] = await Promise.all([
    currentVersion ? checkForUpdates(currentVersion).catch(() => null) : null,
    checkClaudeCodeUpdate().catch(() => {}),
  ]);
  return updateInfo;
}

// Refresh the update caches in a detached child so a slow or unreachable
// registry cannot delay the SessionStart response (the hook budget is 5s).
function refreshUpdateCacheInBackground() {
  if (process.env.OMC_HOOK_BACKGROUND_CHILD === '1') return;
  try {
    const child = spawn(process.execPath, [__filename, REFRESH_UPDATE_CACHE_FLAG], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, OMC_HOOK_BACKGROUND_CHILD: '1' },
    });
    // spawn reports most failures (EMFILE, EPERM, ENOMEM) via an async 'error'
    // event, not a throw; swallow it so the hook never exits non-zero after answering.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Cache refresh is best-effort and must never affect hook output.
  }
}

// Detached child entrypoint: refresh the caches, then exit. The deadline keeps
// the child from lingering if a fetch never settles.
async function refreshUpdateCacheAndExit() {
  const deadline = setTimeout(() => process.exit(0), REFRESH_UPDATE_CACHE_DEADLINE_MS);
  deadline.unref();
  try { await runUpdateChecks(); } catch {}
  clearTimeout(deadline);
  process.exit(0);
}

function compareVersions(v1, v2) {
  const parts1 = v1.replace(/^v/, '').split('.').map(p => parseInt(p, 10) || 0);
  const parts2 = v2.replace(/^v/, '').split('.').map(p => parseInt(p, 10) || 0);

  for (let i = 0; i < 3; i++) {
    const diff = (parts1[i] || 0) - (parts2[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const OMC_STARTUP_COMPACTABLE_SECTIONS = [
  'agent_catalog',
  'skills',
  'team_compositions',
];
const OMC_STARTUP_GUIDANCE_MAX_CHARS = 8000;
const DEFAULT_SESSION_START_CONTEXT_BUDGET = 6000;

// Aggregate character budget shared by everything SessionStart injects.
// Override with OMC_SESSION_START_CONTEXT_BUDGET (positive integer). Any other
// value falls back to the default so a bad setting can never blank the context.
function resolveSessionStartContextBudget() {
  const raw = (process.env.OMC_SESSION_START_CONTEXT_BUDGET || '').trim();
  if (!raw) return DEFAULT_SESSION_START_CONTEXT_BUDGET;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_START_CONTEXT_BUDGET;
}

function sessionStartOmissionNotice(budget) {
  return `[Additional SessionStart context omitted to preserve the ${budget}-character aggregate budget.]`;
}

const { MODEL_ROUTING_OVERRIDE_MESSAGE } = await import(pathToFileURL(join(__dirname, 'lib', 'model-routing-override-message.mjs')).href);

function isTruthyProviderFlag(value) {
  return value === '1' || value === 'true';
}

function getSessionModelId() {
  return process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || '';
}

function isBedrockSession() {
  if (isTruthyProviderFlag(process.env.CLAUDE_CODE_USE_BEDROCK)) return true;
  const modelId = getSessionModelId();
  return Boolean(
    modelId && (
      /^((us|eu|ap|global)\.anthropic\.|anthropic\.claude)/i.test(modelId) ||
      (
        /^arn:aws(-[^:]+)?:bedrock:/i.test(modelId) &&
        /:(inference-profile|application-inference-profile)\//i.test(modelId) &&
        modelId.toLowerCase().includes('claude')
      )
    )
  );
}

function isVertexSession() {
  if (isTruthyProviderFlag(process.env.CLAUDE_CODE_USE_VERTEX)) return true;
  const modelId = getSessionModelId();
  return Boolean(modelId && modelId.toLowerCase().startsWith('vertex_ai/'));
}

async function readRoutingForceInheritFromConfig(directory) {
  const omcRoot = await resolveOmcStateRoot(directory);
  const configPaths = [
    join(configDir, '.omc-config.json'),
    join(omcRoot, 'config.json'),
  ];

  for (const configPath of configPaths) {
    const config = readJsonFile(configPath);
    if (config?.routing?.forceInherit === true) return true;
  }

  return false;
}

async function shouldEmitModelRoutingOverride(directory) {
  if (process.env.OMC_ROUTING_FORCE_INHERIT === 'true') return true;
  if (process.env.OMC_ROUTING_FORCE_INHERIT === 'false') return false;
  if (await readRoutingForceInheritFromConfig(directory)) return true;

  if (isBedrockSession() || isVertexSession()) return true;

  const modelId = getSessionModelId();
  if (modelId && !modelId.toLowerCase().includes('claude')) return true;

  const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
  if (baseUrl && !baseUrl.includes('anthropic.com')) return true;

  return false;
}


function compactBudgetedText(text, maxChars) {
  const notice = '\n...[truncated to preserve SessionStart context budget]';
  if (!text || text.length <= maxChars) return text || '';
  if (maxChars <= notice.length) return notice.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - notice.length).trimEnd()}${notice}`;
}

function looksLikeOmcGuidance(content) {
  return (
    typeof content === 'string' &&
    content.includes('<guidance_schema_contract>') &&
    /oh-my-(claudecode|codex)/i.test(content) &&
    OMC_STARTUP_COMPACTABLE_SECTIONS.some(
      section => content.includes(`<${section}>`) && content.includes(`</${section}>`),
    )
  );
}

function compactOmcStartupGuidance(content) {
  if (!looksLikeOmcGuidance(content)) return content;

  let compacted = content;
  let removedAny = false;

  for (const section of OMC_STARTUP_COMPACTABLE_SECTIONS) {
    const pattern = new RegExp(`\n*<${section}>[\\s\\S]*?</${section}>\n*`, 'g');
    const next = compacted.replace(pattern, '\n\n');
    removedAny = removedAny || next !== compacted;
    compacted = next;
  }

  const normalized = compacted
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n\n---\n\n---\n\n/g, '\n\n---\n\n')
    .trim();

  if (normalized.length <= OMC_STARTUP_GUIDANCE_MAX_CHARS) {
    return removedAny ? normalized : content;
  }

  const notice = '\n\n[OMC startup guidance truncated to preserve an 8000-character budget. Read the source file directly for the full document.]';
  return `${normalized.slice(0, OMC_STARTUP_GUIDANCE_MAX_CHARS - notice.length).trimEnd()}${notice}`;
}

function formatUpdateNoticeForUser(updateInfo, options = {}) {
  const latestVersion = updateInfo?.latestVersion || 'latest';
  const currentVersion = updateInfo?.currentVersion || 'unknown';
  const action = options.autoUpgradePrompt === false
    ? 'To update later, run: omc update'
    : 'Run /update to upgrade now, or use /plugin install oh-my-claudecode';
  return `[OMC UPDATE AVAILABLE] oh-my-claudecode v${latestVersion} is available (current: v${currentVersion}). ${action}`;
}

function buildSessionStartAdditionalContext(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const sections = messages.map((message, index) => ({ index, message }));
  const priorityOrder = [
    /\[MODEL ROUTING OVERRIDE/,
    /\[AUTOPILOT MODE RESTORED\]/,
    /\[RALPH LOOP RESTORED\]/,
    /\[PROJECT MEMORY\]/,
    /\[NOTEPAD PRIORITY CONTEXT LOADED\]/,
    /\[PENDING TASKS DETECTED\]/,
  ];
  const prioritized = [];
  const remaining = [];
  for (const section of sections) {
    const score = priorityOrder.findIndex((pattern) => pattern.test(section.message));
    if (score !== -1) prioritized.push({ ...section, score });
    else remaining.push({ ...section, score: priorityOrder.length + section.index });
  }
  const ordered = [...prioritized.sort((a, b) => a.score - b.score || a.index - b.index), ...remaining]
    .map((entry) => entry.message);

  const budget = resolveSessionStartContextBudget();
  let used = 0;
  const selected = [];
  for (const message of ordered) {
    const separator = selected.length > 0 ? 1 : 0;
    if (used + separator + message.length > budget) {
      const remainingBudget = budget - used - separator;
      if (remainingBudget > 0) {
        selected.push(
          remainingBudget > 120
            ? compactBudgetedText(message, remainingBudget)
            : compactBudgetedText(sessionStartOmissionNotice(budget), remainingBudget),
        );
      }
      break;
    }
    selected.push(message);
    used += separator + message.length;
  }

  return selected.join('\n');
}

// ============================================================================
// Notepad Support
// ============================================================================

const NOTEPAD_FILENAME = 'notepad.md';
const PRIORITY_HEADER = '## Priority Context';
const WORKING_MEMORY_HEADER = '## Working Memory';

/**
 * Get notepad path in .omc directory
 */
async function getNotepadPath(directory) {
  const omcRoot = await resolveOmcStateRoot(directory);
  return join(omcRoot, NOTEPAD_FILENAME);
}

/**
 * Read notepad content
 */
async function readNotepad(directory) {
  const notepadPath = await getNotepadPath(directory);
  if (!existsSync(notepadPath)) {
    return null;
  }
  try {
    return readFileSync(notepadPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Extract a section from notepad content
 */
function extractSection(content, header) {
  // Match from header to next section (## followed by space and non-# char)
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\n([\\s\\S]*?)(?=\\n## [^#]|$)`);
  const match = content.match(regex);
  if (!match) {
    return null;
  }
  // Remove HTML comments and trim
  let section = match[1];
  section = section.replace(/<!--[\s\S]*?-->/g, '').trim();
  return section || null;
}

/**
 * Get Priority Context section (for injection)
 */
async function getPriorityContext(directory) {
  const content = await readNotepad(directory);
  if (!content) {
    return null;
  }
  return extractSection(content, PRIORITY_HEADER);
}

/**
 * Format notepad context for session injection
 */
async function formatNotepadContext(directory) {
  const priorityContext = await getPriorityContext(directory);
  if (!priorityContext) {
    return null;
  }
  return `<notepad-priority>

## Priority Context

${priorityContext}

</notepad-priority>`;
}

/**
 * Validate that a candidate cwd is a real OMC workspace anchor.
 * Returns the candidate unchanged if it is non-empty AND contains a
 * `.omc-workspace` marker OR a `.git` directory.
 * Otherwise emits a one-line warning to stderr and returns null,
 * signalling the caller to skip all state mutations.
 */
function validateCwd(candidate) {
  if (!candidate || typeof candidate !== 'string') {
    process.stderr.write(
      `[OMC] session-start: refusing to use cwd '${candidate}' as workspace anchor (no .omc-workspace or .git marker)\n`
    );
    return null;
  }
  // cwd is commonly a subdirectory of the repo/workspace root, so walk up
  // looking for a `.omc-workspace` marker or `.git` dir. Stop before scanning
  // $HOME (or above) so a stray marker/repo in $HOME cannot validate an
  // unrelated directory. Returns the original candidate so downstream root
  // resolution (getOmcRoot/resolveOmcStateRoot) can anchor it.
  let home = null;
  try { home = homedir(); } catch { home = null; }
  let cursor = candidate;
  while (true) {
    if (home && cursor === home) break;
    if (existsSync(join(cursor, '.omc-workspace')) || existsSync(join(cursor, '.git'))) {
      return candidate;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  process.stderr.write(
    `[OMC] session-start: refusing to use cwd '${candidate}' as workspace anchor (no .omc-workspace or .git marker)\n`
  );
  return null;
}

function normalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  let normalized = resolve(p);
  normalized = normalize(normalized).replace(/[\/\\]+$/, '');
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

async function main() {
  const sessionStartDeadline = Date.now() + SESSION_START_HOOK_TIMEOUT_MS;
  try {
    const input = await readStdin();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const rawDirectory = data.cwd || data.directory || process.cwd();
    const directory = validateCwd(rawDirectory);
    if (directory === null) {
      // No workspace here, but the registry update checks do not need one, so
      // the HUD update cache still refreshes for users who launch Claude Code
      // outside a repo. It runs detached: this path must answer immediately and
      // must not touch workspace state. Only the home-scoped or configured
      // non-git fallback can be touched here.
      try {
        const unscopedOmcRoot = process.env.OMC_STATE_DIR
          ? resolve(process.env.OMC_STATE_DIR, 'non-git')
          : join(homedir(), '.omc');
        resolveSessionPluginOccupancy(sessionStartDeadline);
        await purgeLegacyToolFailureState(unscopedOmcRoot);
        deferToolFailureCleanupStabilization(unscopedOmcRoot);
      } catch {
        // Legacy-state cleanup is best-effort on the no-workspace fast path.
      }
      refreshUpdateCacheInBackground();
      console.log(JSON.stringify({ continue: true }));
      return;
    }
    const sessionId = data.sessionId || data.session_id || data.sessionid || '';
    const omcRoot = await resolveOmcStateRoot(directory);
    await purgeLegacyToolFailureState(omcRoot);
    deferToolFailureCleanupStabilization(omcRoot);
    if (process.env.CLAUDE_PLUGIN_ROOT) {
      // Issue #3995: resolve plugin-cache occupancy ONCE per session start.
      // win32 batched identity host (the only PowerShell spawn on this
      // path) runs a single time; its identities map feeds the owner publish
      // below. The template has no stale-cache GC consumer, so no occupancy
      // state is carried past this point.
      resolveSessionPluginOccupancy(sessionStartDeadline);
    }
    let messages = [];
    const userMessages = [];
    let pendingRestore = null;
    let pendingRestoreMessage = null;

    // Restore the newest PreCompact checkpoint after compaction (issue #3730).
    // Only fires when Claude Code signals the session resumed from compaction
    // (source === 'compact'); never on startup, resume, or clear.
    if (data.source === 'compact' && sessionId) {
      try {
        const { preparePreCompactCheckpointRestore, claimPreCompactCheckpointRestore } = await import(
          pathToFileURL(join(__dirname, 'lib', 'precompact-restore.mjs')).href
        );
        const restoreRoot = await resolveOmcStateRoot(directory);
        const prepared = preparePreCompactCheckpointRestore(restoreRoot, sessionId);
        if (prepared) {
          pendingRestore = { ...prepared, restoreRoot, preparePreCompactCheckpointRestore, claimPreCompactCheckpointRestore };
          pendingRestoreMessage = `<session-restore>\n\n${prepared.text}\n\n</session-restore>\n\n---\n`;
          messages.push(pendingRestoreMessage);
        }
      } catch {
        // Restore is advisory: never break session start on a checkpoint error.
      }
    }

    // Check for updates (non-blocking)
    const currentVersion = resolveOmcVersion();

    // Template-version drift check: warn once per session if installed templates differ from plugin
    if (currentVersion) {
      try {
        const omcRoot = await resolveOmcStateRoot(directory);
        const stampPath = join(omcRoot, 'template-version.json');
        const driftMarkerPath = join(omcRoot, 'state', `drift-warned-${sessionId || 'nosession'}.json`);
        if (existsSync(stampPath) && !existsSync(driftMarkerPath)) {
          const stamp = readJsonFile(stampPath);
          if (stamp?.version && stamp.version !== currentVersion) {
            process.stderr.write(
              `[omc] template version drift: installed=${stamp.version}, plugin=${currentVersion} — run /oh-my-claudecode:omc-setup to refresh\n`
            );
            mkdirSync(join(driftMarkerPath, '..'), { recursive: true });
            writeFileSync(driftMarkerPath, JSON.stringify({ warnedAt: new Date().toISOString() }));
          }
        }
      } catch { /* non-fatal */ }
    }

    const updateInfo = await runUpdateChecks();
    if (updateInfo) {
      const configPath = join(getClaudeConfigDir(), '.omc-config.json');
      const omcConfig = readJsonFile(configPath) || {};
      userMessages.push(formatUpdateNoticeForUser(updateInfo, {
        autoUpgradePrompt: omcConfig.autoUpgradePrompt !== false,
      }));
    }

    if (await shouldEmitModelRoutingOverride(directory)) {
      messages.push(MODEL_ROUTING_OVERRIDE_MESSAGE);
    }

    // Check for incomplete todos (project-local only, not global
    // [$CLAUDE_CONFIG_DIR|~/.claude]/todos/)
    // NOTE: We intentionally do NOT scan the global
    // [$CLAUDE_CONFIG_DIR|~/.claude]/todos/ directory.
    // That directory accumulates todo files from ALL past sessions across all
    // projects, causing phantom task counts in fresh sessions (see issue #354).
    const omcRootForTodos = await resolveOmcStateRoot(directory);
    const localTodoPaths = [
      join(omcRootForTodos, 'todos.json'),
      join(directory, '.claude', 'todos.json')
    ];
    let incompleteCount = 0;
    for (const todoFile of localTodoPaths) {
      if (existsSync(todoFile)) {
        try {
          const data = readJsonFile(todoFile);
          const todos = data?.todos || (Array.isArray(data) ? data : []);
          incompleteCount += todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length;
        } catch {}
      }
    }

    if (incompleteCount > 0) {
      messages.push(`<session-restore>

[PENDING TASKS DETECTED]

You have ${incompleteCount} incomplete tasks from a previous session.
Please continue working on these tasks.

</session-restore>

---
`);
    }

    // Check for notepad Priority Context (ALWAYS loaded on session start)
    const notepadContext = await formatNotepadContext(directory);
    if (notepadContext) {
      messages.push(`<session-restore>

[NOTEPAD PRIORITY CONTEXT LOADED]

${notepadContext}

</session-restore>

---
`);
    }

    // Load root AGENTS.md if it exists (deepinit output - issue #613)
    // This ensures AI-readable directory documentation is available from session start
    const agentsMdPath = join(directory, 'AGENTS.md');
    if (existsSync(agentsMdPath)) {
      try {
        const agentsContent = compactOmcStartupGuidance(readFileSync(agentsMdPath, 'utf-8').trim());
        if (agentsContent) {
          messages.push(`<session-restore>

[ROOT AGENTS.md LOADED]

The following project documentation was generated by deepinit to help AI agents understand the codebase:

${agentsContent}

</session-restore>

---
`);
        }
      } catch {
        // Skip if file can't be read
      }
    }

    let additionalContext = '';
    if (pendingRestore && pendingRestoreMessage) {
      additionalContext = buildSessionStartAdditionalContext(messages);
      if (additionalContext.includes(pendingRestoreMessage)) {
        let markerStatus = null;
        const waitCell = new Int32Array(new SharedArrayBuffer(4));
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const status = pendingRestore.claimPreCompactCheckpointRestore(
            pendingRestore.restoreRoot,
            sessionId,
            pendingRestore.path,
            pendingRestore.created_at,
            pendingRestore.mtime_ms,
            pendingRestore.checkpoint_sha256,
          );
          if (status === 'written') {
            markerStatus = status;
            break;
          }
          if (status !== 'contended') break;
          Atomics.wait(waitCell, 0, 0, 10);
          const refreshed = pendingRestore.preparePreCompactCheckpointRestore(
            pendingRestore.restoreRoot,
            sessionId,
          );
          if (!refreshed) break;
          const refreshedMessage = `<session-restore>\n\n${refreshed.text}\n\n</session-restore>\n\n---\n`;
          const refreshedMessages = messages.map((message) => (
            message === pendingRestoreMessage ? refreshedMessage : message
          ));
          const refreshedContext = buildSessionStartAdditionalContext(refreshedMessages);
          if (!refreshedContext.includes(refreshedMessage)) break;
          pendingRestore = {
            ...refreshed,
            restoreRoot: pendingRestore.restoreRoot,
            preparePreCompactCheckpointRestore: pendingRestore.preparePreCompactCheckpointRestore,
            claimPreCompactCheckpointRestore: pendingRestore.claimPreCompactCheckpointRestore,
          };
          pendingRestoreMessage = refreshedMessage;
          messages = refreshedMessages;
          additionalContext = refreshedContext;
        }
        if (!markerStatus) {
          messages = messages.filter((message) => message !== pendingRestoreMessage);
          additionalContext = buildSessionStartAdditionalContext(messages);
        }
      } else {
        // The complete restore sentinel did not fit the aggregate budget;
        // do not commit a replay marker for context that was not delivered.
        messages = messages.filter((message) => message !== pendingRestoreMessage);
        additionalContext = buildSessionStartAdditionalContext(messages);
      }
    } else if (messages.length > 0) {
      additionalContext = buildSessionStartAdditionalContext(messages);
    }

    if (messages.length > 0 || userMessages.length > 0) {
      const output = {
        continue: true,
      };
      if (userMessages.length > 0) {
        output.systemMessage = userMessages.join('\n');
      }
      if (messages.length > 0) {
        output.hookSpecificOutput = {
          hookEventName: 'SessionStart',
          additionalContext,
        };
      }
      console.log(JSON.stringify(output));
    } else {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    }
  } catch (error) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

if (process.argv.includes(REFRESH_UPDATE_CACHE_FLAG)) {
  refreshUpdateCacheAndExit();
} else if (process.argv[2] === DEFERRED_TOOL_FAILURE_CLEANUP_FLAG) {
  const omcRoot = process.argv[3];
  if (!omcRoot) {
    process.exit(0);
  }
  signalTestDeferredToolFailureCleanupReady();
  const requestedWaitMs = Number(process.argv[4]);
  const waitMs = Number.isFinite(requestedWaitMs) && requestedWaitMs > 0
    ? Math.min(requestedWaitMs, POST_TOOL_FAILURE_DEFERRED_WAIT_MS)
    : POST_TOOL_FAILURE_DEFERRED_WAIT_MS;
  purgeLegacyToolFailureState(omcRoot, waitMs)
    .catch(() => {})
    .finally(() => process.exit(0));
} else if (process.argv[2] === STABILIZE_TOOL_FAILURE_CLEANUP_FLAG) {
  const omcRoot = process.argv[3];
  if (!omcRoot) {
    process.exit(0);
  }
  const requestedWindow = Number(process.argv[4]);
  const stabilizationMs = Number.isFinite(requestedWindow) && requestedWindow > 0
    ? Math.min(requestedWindow, TOOL_FAILURE_CLEANUP_STABILIZATION_MS)
    : TOOL_FAILURE_CLEANUP_STABILIZATION_MS;
  stabilizeLegacyToolFailureState(omcRoot, stabilizationMs, toolFailureCleanupMaxLifetimeMs(stabilizationMs, Number(process.argv[5])))
    .catch(() => {})
    .finally(() => process.exit(0));
} else {
  main();
}
