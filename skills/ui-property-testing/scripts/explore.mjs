// The ui-property-testing explorer: loads a spec (properties + action
// generators), drives the UI through a driver module, evaluates every
// property on every captured state, and on violation records, shrinks, and
// confirms the trace before reporting.
//
// Usage:
//   node explore.mjs --driver ./drivers/playwright.mjs --spec ./spec.ts \
//     --url https://example.com [--seed 1234] [--max-steps 60] [--headless]
//   node explore.mjs --driver ./drivers/fake.mjs --spec ./spec.mjs --json
//
// For a .ts spec on a node without type stripping, start the process with
// `--import tsx`. Exit 0 = clean run; exit 1 = violations (report on stdout
// as JSON); exit 2 = usage/driver errors (stderr).

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const driverPath = flag("driver");
const specPath = flag("spec");
const url = flag("url");
const seed = Number(flag("seed", "1234"));
const maxSteps = Number(flag("max-steps", "60"));
const jsonOut = has("json") || !has("human");

if (!driverPath || !specPath) {
  console.error("usage: explore.mjs --driver <path> --spec <path> [--url <url>] [--seed n] [--max-steps n]");
  process.exit(2);
}

// Seeded RNG (mulberry32): the same seed explores the same sequence, so
// evidence stays reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The spec imports runtime.mjs for its scaffolding. Import order here makes
// this process hold one runtime instance; the spec's own import of the same
// file resolves to the same module (runtime.mjs is a globalThis singleton),
// so the cells and properties the spec populates are the ones explored.
await import(pathToFileURL(join(import.meta.dirname, "runtime.mjs")).href);
const runtime = globalThis.__uiPropertyRuntime;
console.error('[runner] runtime instance:', runtime === undefined ? 'undefined' : 'present');
console.error('[runner] runtime cells:', runtime?.cells?.length, 'properties:', runtime?.properties?.length, 'generators:', runtime?.generators?.length);
const spec = await import(pathToFileURL(resolve(specPath)).href);
console.error("[debug] spec exports:", Object.keys(spec));
console.error("[debug] runtime ref:", runtime === globalThis.__uiPropertyRuntime);
console.error("[debug] cells:", runtime.cells.length, "props:", runtime.properties.length, "gens:", runtime.generators.length);
for (const [name, value] of Object.entries(spec)) {
  const property = runtime.properties.find((p) => p === value);
  if (property) property.name = name;
}
console.error('[runner] after spec: cells:', runtime.cells.length, 'properties:', runtime.properties.length, 'generators:', runtime.generators.length);

const driverModule = await import(pathToFileURL(resolve(driverPath)).href);
const launchDriver = driverModule.launch ?? driverModule.default?.launch;
if (typeof launchDriver !== "function") {
  console.error(`driver ${driverPath} does not export launch()`);
  process.exit(2);
}

// Built-in default properties, always shipped: the crash-and-transport
// signals bombadil ships as defaults.
function defaultProperties(snapshot) {
  const problems = [];
  for (const text of snapshot.uncaught ?? []) problems.push(`uncaught exception: ${text}`);
  for (const text of snapshot.consoleErrors ?? []) problems.push(`console error: ${text}`);
  for (const response of snapshot.failedResponses ?? []) problems.push(`failed response: ${response}`);
  return problems;
}

function mulberry32(s) {
  let a = s >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function capture(instance) {
  const snapshot = await instance.snapshot();
  for (const cell of runtime.cells) cell.current = cell.fn(snapshot);
  return snapshot;
}

function evaluateAlways() {
  for (const property of runtime.properties) {
    if (property.op !== "always") continue;
    if (!property.thunk()) return property;
  }
  return null;
}

// Custom actions execute through the instance's facade; built-ins through
// the driver's apply.
async function applyTemplate(instance, facade, template) {
  if (template.action === "custom") {
    const fn = runtime.customActions.get(template.name);
    if (!fn) throw new Error(`unknown custom action: ${template.name}`);
    await fn(facade, ...template.args);
    return;
  }
  await instance.apply(template);
}

async function runTrace(trace, { property, url, seed: runSeed, maxSteps }) {
  const instance = await launchDriver({ headless: true, seed: runSeed });
  const facade = instance.facade ?? instance;
  const localRng = mulberry32(runSeed);
  let violated = false;
  try {
    if (url) await instance.goto(url);
    for (let i = 0; i < trace.length; i++) {
      await applyTemplate(instance, facade, trace[i]);
      await instance.settle?.();
      const snapshot = await capture(instance);
      const failure = defaultProperties(snapshot);
      if (failure.length > 0) return { violated: true, at: i, snapshot };
      if (property.op === "always" && !property.thunk()) return { violated: true, at: i, snapshot };
    }
  } finally {
    await instance.close?.();
  }
  return { violated, at: trace.length, snapshot: null };
}

async function runExploration({ url, seed: runSeed, maxSteps }) {
  const instance = await launchDriver({ headless: true, seed: runSeed });
  const facade = instance.facade ?? instance;
  const localRng = mulberry32(runSeed);
  const trace = [];
  const deadlines = new Map();
  const start = Date.now();
  let violation = null;
  try {
    if (url) await instance.goto(url);
    for (let step = 0; step < maxSteps; step++) {
      const snapshot = await capture(instance);
      const failure = defaultProperties(snapshot);
      if (failure.length > 0) {
        violation = { property: "defaults", snapshot };
        break;
      }
      const broken = evaluateAlways();
      if (broken) {
        violation = { property: broken.name ?? "always", snapshot };
        break;
      }
      for (const property of runtime.properties) {
        if (property.op !== "eventually") continue;
        if (!deadlines.has(property.name)) {
          deadlines.set(property.name, {
            start: Date.now(),
            withinMs: property.withinMs ?? maxSteps * 1000,
          });
        }
        if (property.thunk()) deadlines.get(property.name).satisfied = true;
      }
      const candidates = runtime.generators.flatMap((gen) => gen(facade, snapshot) ?? []);
      if (candidates.length === 0) break;
      const template = candidates[Math.floor(localRng() * candidates.length)];
      trace.push(template);
      await applyTemplate(instance, facade, template);
      await instance.settle?.();
      for (const [name, deadline] of deadlines) {
        if (!deadline.satisfied && Date.now() - deadline.start > deadline.withinMs) {
          violation = { property: name, snapshot: await instance.snapshot() };
          break;
        }
      }
      if (violation) break;
    }
  } catch (error) {
    violation = { property: "driver", snapshot: { error: String(error) } };
    trace.push({ action: "driver-error", message: String(error) });
  } finally {
    await instance.close?.();
  }
  const elapsed = Date.now() - start;
  if (!violation) {
    for (const [name, deadline] of deadlines) {
      if (!deadline.satisfied) {
        violation = { property: name, snapshot: { reason: "eventually deadline expired" } };
        break;
      }
    }
  }
  return { trace, violation, steps: trace.length, elapsedMs: elapsed };
}

async function replayViolates(trace, property) {
  const instance = await launchDriver({ headless: true, seed });
  const facade = instance.facade ?? instance;
  let violated = false;
  try {
    if (url) await instance.goto(url);
    for (const template of trace) {
      await applyTemplate(instance, facade, template);
      await instance.settle?.();
      await capture(instance);
      if (property.op === "always" && !property.thunk()) {
        violated = true;
        break;
      }
    }
  } catch {
    violated = true;
  } finally {
    await instance.close?.();
  }
  return violated;
}

async function shrink(trace, property) {
  let current = [...trace];
  let changed = true;
  while (changed) {
    changed = false;
    for (let size = Math.floor(current.length / 2); size >= 1; size = Math.floor(size / 2)) {
      const candidate = current.slice(0, size);
      if (candidate.length > 0 && (await replayViolates(candidate, property))) {
        current = candidate;
        changed = true;
      }
    }
    for (let i = 0; i < current.length; ) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      if (candidate.length > 0 && (await replayViolates(candidate, property))) {
        current = candidate;
        changed = true;
      } else i++;
    }
  }
  let confirmations = 0;
  for (let run = 0; run < 2; run++) if (await replayViolates(current, property)) confirmations++;
  return { minimizedTrace: current, confirmations };
}

const exploration = await runExploration({ url, seed, maxSteps });
const report = {
  spec: resolve(specPath),
  driver: resolve(driverPath),
  seed,
  steps: exploration.steps,
  exploredMs: exploration.elapsedMs,
  violations: [],
};

if (exploration.violation) {
  const name = exploration.violation.property;
  const property = runtime.properties.find((p) => p.name === name) ?? { op: "always", thunk: () => false };
  const { minimizedTrace, confirmations } = await shrink(exploration.trace, property);
  report.violations.push({
    property: name,
    op: property.op,
    discoveryTraceLength: exploration.trace.length,
    minimizedTrace,
    minimizedLength: minimizedTrace.length,
    confirmationRuns: 2,
    confirmations,
    snapshotAtViolation: exploration.violation.snapshot,
    reproduce: `re-run with --driver ${driverPath} --spec ${specPath} --seed ${seed} and replay the minimized trace`,
  });
}

if (jsonOut) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`explorer: ${report.steps} steps, ${report.violations.length} violation(s)`);
  for (const v of report.violations) {
    console.log(`violated: ${v.property} (${v.op}) — minimized ${v.minimizedLength} of ${v.discoveryTraceLength} actions, confirmed ${v.confirmations}/2`);
  }
}
process.exit(report.violations.length > 0 ? 1 : 0);
