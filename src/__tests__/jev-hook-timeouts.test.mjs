import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
const { resolveJevTimeoutMs } = await import(pathToFileURL(join(ROOT, 'scripts', 'jev-resolve.mjs')).href);
const { activeResolverBufferMs } = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'jev-shadow.mjs')).href);

// In active mode a hook waits for each Jev request with spawnSync, so the
// requests of one hook process add up. run.cjs stops a hook at its manifest
// timeout minus a cushion (500 ms POSIX, 1500 ms Windows, scripts/run.cjs) and
// throws away everything the hook printed.
const WINDOWS_CUSHION_MS = 1500;
// scripts/persistent-mode.mjs: BRIDGE_DELEGATION_TIMEOUT_MS, shared by all
// bridge attempts in one Stop event; it runs between the two Jev requests.
const BRIDGE_DELEGATION_MS = 6000;

// Hooks that wait for Jev, with the requests one process can send in a row.
// Known gap, not covered here: keyword-detector.mjs can send three requests
// (skill-trigger, intent, task-size), but run.cjs caps its Worker at 8 s
// whatever the manifest says (TRUSTED_WORKER_HOOKS in scripts/run.cjs), so a
// manifest timeout cannot fix it.
const JEV_HOOKS = [
  { script: 'pre-tool-enforcer.mjs', event: 'PreToolUse', points: ['model-routing', 'slop-warning'], extraMs: 0 },
  { script: 'post-tool-verifier.mjs', event: 'PostToolUse', points: ['context-pruning'], extraMs: 0 },
  {
    script: 'persistent-mode.mjs',
    event: 'Stop',
    // loop-continuation is asked once per mode that can block; when ralph lets
    // the Stop through, the autopilot handler asks it a second time.
    points: ['learner-extraction', 'loop-continuation', 'loop-continuation'],
    extraMs: BRIDGE_DELEGATION_MS,
  },
  { script: 'code-simplifier.mjs', event: 'Stop', points: ['simplifier-trigger'], extraMs: 0 },
];

function manifestTimeoutMs(event, script) {
  for (const group of MANIFEST.hooks[event] ?? []) {
    for (const hook of group.hooks ?? []) {
      const invocation = [hook.command, ...(hook.args ?? [])].join(' ');
      if (invocation.endsWith(`/scripts/${script}`)) return hook.timeout * 1000;
    }
  }
  throw new Error(`${script} is not registered for ${event} in hooks/hooks.json`);
}

function worstCaseMs({ points, extraMs }) {
  return (
    points.reduce(
      (sum, point) => sum + resolveJevTimeoutMs({}, activeResolverBufferMs(point)),
      0,
    ) + extraMs
  );
}

describe('hook timeouts for hooks that wait for Jev', () => {
  it('uses the default request timeout of 2 s', () => {
    expect(resolveJevTimeoutMs({}, 0)).toBe(2000);
  });

  it('uses the bridge delegation budget that the table assumes', () => {
    const source = readFileSync(join(ROOT, 'scripts', 'persistent-mode.mjs'), 'utf8');
    expect(source).toContain(`BRIDGE_DELEGATION_TIMEOUT_MS = ${BRIDGE_DELEGATION_MS};`);
  });

  it.each(JEV_HOOKS)('$script sends the points listed here', ({ script, points }) => {
    const source = readFileSync(join(ROOT, 'scripts', script), 'utf8');
    for (const point of new Set(points)) expect(source).toMatch(new RegExp(`point: ['"]${point}['"]`));
  });

  it.each(JEV_HOOKS)(
    '$script has a timeout that holds the Jev requests listed here at the defaults',
    (hook) => {
      const innerLimitMs = manifestTimeoutMs(hook.event, hook.script) - WINDOWS_CUSHION_MS;
      expect(innerLimitMs).toBeGreaterThanOrEqual(worstCaseMs(hook));
    },
  );

  it('gives the model-routing resolver more time than the other points', () => {
    expect(activeResolverBufferMs('model-routing')).toBeGreaterThan(activeResolverBufferMs('slop-warning'));
    expect(activeResolverBufferMs('slop-warning')).toBe(500);
  });

  it('passes the per-point buffer to the resolver timeout of the active spawn', () => {
    const source = readFileSync(join(ROOT, 'scripts', 'lib', 'jev-shadow.mjs'), 'utf8');
    expect(source).toMatch(/resolveJevTimeoutMs\(\s*process\.env,\s*activeResolverBufferMs\(point\),?\s*\)/);
  });
});
