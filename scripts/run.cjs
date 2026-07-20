#!/usr/bin/env node
'use strict';
/**
 * OMC Cross-platform hook runner (run.cjs).
 *
 * Uses process.execPath (the Node binary already running this script) to spawn
 * ordinary hooks. The two trusted UserPromptSubmit hooks run in a Worker so the
 * runner retains ownership of their synchronous timeout boundary.
 */

const { spawn } = require('child_process');
const { existsSync, readFileSync, realpathSync } = require('fs');
const path = require('path');
const { join, basename, dirname } = path;
const { pathToFileURL } = require('url');
const { Worker } = require('worker_threads');


function isPluginRoot(pluginRoot) {
  return existsSync(join(pluginRoot, 'hooks', 'hooks.json')) &&
    existsSync(join(pluginRoot, 'scripts', 'run.cjs')) &&
    existsSync(join(pluginRoot, 'scripts'));
}

function canonicalPluginRoot(pluginRoot) {
  try {
    const canonicalRoot = path.resolve(realpathSync(pluginRoot));
    return isPluginRoot(canonicalRoot) ? canonicalRoot : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the hook script target path, handling stale CLAUDE_PLUGIN_ROOT.
 *
 * A direct target remains valid for the generic child path even without a
 * trusted plugin root. Worker eligibility receives only independently proven
 * configured-root or selected-cache-version provenance.
 */
function resolveTarget(targetPath) {
  const configuredRoot = canonicalPluginRoot(process.env.CLAUDE_PLUGIN_ROOT);

  try {
    if (existsSync(targetPath)) {
      return {
        targetPath: path.resolve(realpathSync(targetPath)),
        trustedPluginRoot: configuredRoot,
      };
    }
  } catch {
    // Continue to stale-cache recovery.
  }

  try {
    const configuredPath = process.env.CLAUDE_PLUGIN_ROOT;
    if (!configuredPath) return null;

    const cacheBase = dirname(configuredPath);
    const scriptRelative = targetPath.slice(configuredPath.length);
    if (!scriptRelative || !existsSync(cacheBase)) return null;

    const { readdirSync } = require('fs');
    const entries = readdirSync(cacheBase).filter(version => /^\d+\.\d+\.\d+/.test(version));
    entries.sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let index = 0; index < 3; index++) {
        if ((pa[index] || 0) !== (pb[index] || 0)) return (pb[index] || 0) - (pa[index] || 0);
      }
      return 0;
    });

    for (const version of entries) {
      const selectedRoot = join(cacheBase, version);
      const candidate = selectedRoot + scriptRelative;
      if (!existsSync(candidate)) continue;
      const trustedPluginRoot = canonicalPluginRoot(selectedRoot);
      return {
        targetPath: path.resolve(realpathSync(candidate)),
        trustedPluginRoot,
      };

    }
  } catch {
    // Any stale-cache recovery error remains fail-open.
  }

  return null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function flattenHookEntries(rawHooks) {
  if (!rawHooks || typeof rawHooks !== 'object') return [];
  return Object.entries(rawHooks).flatMap(([event, entries]) => {
    if (!Array.isArray(entries)) return [];
    return entries.map((entry) => ({ event, entry }));
  });
}

function isDebugHooksEnabled() {
  return process.env.OMC_DEBUG_HOOKS === '1' ||
    process.env.OMC_DEBUG === '1' ||
    process.env.OMC_DEBUG === 'true';
}

function resolveTimeoutCushionMs(manifestTimeoutMs, hookEvent) {
  if (hookEvent !== 'UserPromptSubmit') return TIMEOUT_CUSHION_MS;
  const promptCushion = Math.floor(manifestTimeoutMs * 0.2);
  return Math.min(3000, Math.max(1000, promptCushion));
}

const TIMEOUT_CUSHION_MS = 500;
// = max declared manifest budget (60000ms, setup-maintenance) minus the 500ms cushion; applied ONLY when manifest resolution is null so long legit hooks are not prematurely reaped.
const DEFAULT_GENERIC_TIMEOUT_MS = 59500;


function resolveInnerTimeoutMs(manifestHook) {
  if (!manifestHook) return null;
  return Math.max(1, manifestHook.timeoutMs - resolveTimeoutCushionMs(manifestHook.timeoutMs, manifestHook.event));
}

// Call only after resolveWorkerTarget has verified an exact canonical trusted prompt target.
function resolveTrustedPromptWorkerTimeoutMs(targetPath, manifestHook, trustedPluginRoot) {
  const calculatedTimeoutMs = resolveInnerTimeoutMs(manifestHook);
  const canonicalTarget = normalizedComparisonPath(targetPath);
  const capsByCanonicalTarget = new Map([
    [normalizedComparisonPath(join(trustedPluginRoot, 'scripts', 'keyword-detector.mjs')), 8000],
    [normalizedComparisonPath(join(trustedPluginRoot, 'scripts', 'skill-injector.mjs')), 12000],
  ]);
  const capMs = capsByCanonicalTarget.get(canonicalTarget);
  return capMs ? Math.min(calculatedTimeoutMs, capMs) : calculatedTimeoutMs;
}

function resolveGenericTimeoutMs(manifestHook) {
  return manifestHook ? resolveInnerTimeoutMs(manifestHook) : DEFAULT_GENERIC_TIMEOUT_MS;
}

function resolveHookTimeoutMsFromRoot(pluginRoot, targetPath, extraArgs) {
  const hooksJsonPath = join(pluginRoot, 'hooks', 'hooks.json');
  if (!existsSync(hooksJsonPath)) return null;

  try {
    const hooksJson = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    const scriptName = basename(targetPath);
    const scriptPattern = new RegExp(`[/\\\\]scripts[/\\\\]${escapeRegex(scriptName)}(?:\\s|$)`);
    const argNeedles = extraArgs.filter(arg => typeof arg === 'string' && arg.length > 0);

    for (const { event, entry } of flattenHookEntries(hooksJson?.hooks)) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      for (const hook of hooks) {
        const command = typeof hook?.command === 'string' ? hook.command : '';
        const timeout = Number(hook?.timeout);
        if (!scriptPattern.test(command)) continue;
        if (!Number.isFinite(timeout) || timeout <= 0) continue;
        if (!argNeedles.every(arg => command.includes(` ${arg}`) || command.endsWith(` ${arg}`))) continue;
        return { event, timeoutMs: Math.floor(timeout * 1000) };
      }
    }
  } catch {
    return null;
  }

  return null;
}

function resolveHookTimeoutMs(targetPath, extraArgs) {
  return resolveHookTimeoutMsFromRoot(dirname(dirname(targetPath)), targetPath, extraArgs);
}

function normalizedComparisonPath(value) {
  const canonical = path.resolve(realpathSync(value));
  return process.platform === 'win32'
    ? path.win32.normalize(canonical).toLowerCase()
    : path.normalize(canonical);
}

function isContainedBy(root, targetPath) {
  const pathApi = process.platform === 'win32' ? path.win32 : path;
  const relative = pathApi.relative(root, targetPath);
  return relative !== '' && !pathApi.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`);
}

function resolveWorkerTarget(resolution, extraArgs) {
  const trustedRoot = resolution.trustedPluginRoot;
  if (!trustedRoot || extraArgs.length !== 0) return null;

  try {
    const canonicalRoot = normalizedComparisonPath(trustedRoot);
    const canonicalTarget = normalizedComparisonPath(resolution.targetPath);
    if (!isContainedBy(canonicalRoot, canonicalTarget)) return null;

    const expectedTargets = ['keyword-detector.mjs', 'skill-injector.mjs']
      .map(script => normalizedComparisonPath(join(trustedRoot, 'scripts', script)));
    if (!expectedTargets.includes(canonicalTarget)) return null;

    const manifestHook = resolveHookTimeoutMsFromRoot(trustedRoot, resolution.targetPath, []);
    if (manifestHook?.event !== 'UserPromptSubmit') return null;
    return manifestHook;
  } catch {
    return null;
  }
}

function writeTimeoutDiagnostic(targetPath, manifestHook, timeoutMs) {
  const message = `[run.cjs] Hook ${basename(targetPath)} timed out after ${timeoutMs}ms; exiting fail-open.\n`;
  if (manifestHook?.event !== 'UserPromptSubmit' || isDebugHooksEnabled()) {
    process.stderr.write(message);
  }
}

function reapTree(child) {
  if (process.platform === 'win32') {
    // Fire-and-forget: a slow, denied, or missing taskkill must not block the
    // runner past the outer hooks.json budget. The runner still exits fail-open
    // via child.unref() on the timeout path; taskkill reaps the tree best-effort.
    try {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {});
      killer.unref();
    } catch {
      // best-effort; child.unref() still guarantees the runner exits
    }
    return;
  }

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // best-effort; child.unref() still guarantees the runner exits
    }
  }
}

const RUNNER_TERMINATION_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

function runGenericChild(targetPath, extraArgs, timeoutMs, manifestHook) {
  return new Promise(resolve => {
    let terminal = false;
    let timer;
    const child = spawn(process.execPath, [targetPath, ...extraArgs], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    // The generic child is detached into its own process group (POSIX). If the
    // runner is terminated or cancelled BEFORE the inner timer fires (outer
    // hooks.json timeout, Ctrl-C, parent kill), reap the tree so the detached
    // hook cannot be orphaned — the exact failure class #3493 must not leave open.
    const detachHandlers = () => {
      clearTimeout(timer);
      for (const signal of RUNNER_TERMINATION_SIGNALS) process.off(signal, onRunnerSignal);
      process.off('exit', onRunnerExit);
    };
    function onRunnerSignal() {
      if (terminal) return;
      terminal = true;
      detachHandlers();
      reapTree(child);
      process.exit(0);
    }
    function onRunnerExit() {
      if (terminal) return;
      terminal = true;
      reapTree(child);
    }

    timer = setTimeout(() => {
      if (terminal) return;
      terminal = true;
      detachHandlers();
      reapTree(child);
      // The runner MUST exit fail-open even if the tree reap did not (or could
      // not) complete — the core #3493 symptom is run.cjs parents living for
      // tens of minutes. unref() releases the child handle from the event loop.
      try { child.unref(); } catch { /* handle already released */ }
      writeTimeoutDiagnostic(targetPath, manifestHook, timeoutMs);
      resolve(0);
    }, timeoutMs);

    child.once('exit', (code) => {
      if (terminal) return;
      terminal = true;
      detachHandlers();
      resolve(typeof code === 'number' ? code : 0);
    });
    child.once('error', () => {
      if (terminal) return;
      terminal = true;
      detachHandlers();
      resolve(0);
    });

    for (const signal of RUNNER_TERMINATION_SIGNALS) process.on(signal, onRunnerSignal);
    process.on('exit', onRunnerExit);
  });
}

async function runWorker(targetPath, manifestHook, timeoutMs) {
  let worker;
  let terminal = false;
  let timer;
  let discardOutput = false;
  const stdout = [];
  const stderr = [];

  const cleanupInput = () => {
    if (!worker) return;
    process.stdin.unpipe(worker.stdin);
    worker.stdin.destroy();
  };
  const waitForOutputEnd = stream => stream.readableEnded
    ? Promise.resolve()
    : new Promise(resolve => stream.once('end', resolve));
  const writeBuffer = (stream, buffer) => new Promise(resolve => {
    stream.write(buffer, () => resolve());
  });
  const forwardBuffers = async (workerError) => {
    if (stdout.length) await writeBuffer(process.stdout, Buffer.concat(stdout));
    if (stderr.length) await writeBuffer(process.stderr, Buffer.concat(stderr));
    if (workerError) {
      const diagnostic = workerError.stack || workerError.message || String(workerError);
      await writeBuffer(process.stderr, Buffer.from(`${diagnostic}\n`));
    }
  };
  const waitForWorkerOutput = () => Promise.all([
    waitForOutputEnd(worker.stdout),
    waitForOutputEnd(worker.stderr),
  ]);

  try {
    return await new Promise((resolve) => {
      const finish = async (status, workerError) => {
        if (terminal) return;
        terminal = true;
        clearTimeout(timer);
        cleanupInput();
        if (worker) await waitForWorkerOutput();
        await forwardBuffers(workerError);
        resolve(status);
      };

      timer = setTimeout(async () => {
        if (terminal) return;
        discardOutput = true;
        terminal = true;
        cleanupInput();
        try {
          await worker.terminate();
        } catch {
          // Termination is best-effort; the hook must still fail open.
        }
        writeTimeoutDiagnostic(targetPath, manifestHook, timeoutMs);
        resolve(0);
      }, timeoutMs);

      try {
        worker = new Worker(pathToFileURL(targetPath), {
          stdin: true,
          stdout: true,
          stderr: true,
          env: process.env,
        });
        if (process.stdin.readableEnded) worker.stdin.end();
        else process.stdin.pipe(worker.stdin);
        worker.stdout.on('data', chunk => { if (!discardOutput) stdout.push(chunk); });
        worker.stderr.on('data', chunk => { if (!discardOutput) stderr.push(chunk); });
        worker.once('error', error => {
          void finish(1, error);
        });
        worker.once('exit', code => {
          void finish(code ?? 0);
        });
      } catch (error) {
        void finish(1, error);
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    process.exit(0);
  }

  const resolution = resolveTarget(target);
  if (!resolution) {
    process.exitCode = 0;
  } else {
    const extraArgs = process.argv.slice(3);
    const workerManifestHook = resolveWorkerTarget(resolution, extraArgs);
    if (workerManifestHook) {
      const workerTimeoutMs = resolveTrustedPromptWorkerTimeoutMs(resolution.targetPath, workerManifestHook, resolution.trustedPluginRoot);
      runWorker(resolution.targetPath, workerManifestHook, workerTimeoutMs).then(status => {
        process.exitCode = status;
      });
    } else {
      const manifestHook = resolveHookTimeoutMs(resolution.targetPath, extraArgs);
      const timeoutMs = resolveGenericTimeoutMs(manifestHook);
      runGenericChild(resolution.targetPath, extraArgs, timeoutMs, manifestHook).then(status => {
        process.exitCode = status;
      });
    }
  }
}

module.exports = {
  resolveInnerTimeoutMs,
  resolveTrustedPromptWorkerTimeoutMs,
  resolveWorkerTarget,
  resolveHookTimeoutMs,
  resolveGenericTimeoutMs,
  runGenericChild,
  DEFAULT_GENERIC_TIMEOUT_MS,
};
