import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { checkView } from "../frontends/view.ts";
import {
  type CheckResult,
  EC,
  LEVEL,
  type Rule,
  type Spec,
  stateRules,
  type Verdict,
} from "../ir.ts";
import { compile } from "../pipeline.ts";

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const sources = (target: string) => {
  const full = path.join(scripts, target);
  if (!fs.statSync(full).isDirectory()) return [target];
  return fs
    .readdirSync(full, { recursive: true, encoding: "utf8" })
    .map((entry) => path.join(target, entry))
    .filter((file) => fs.statSync(path.join(scripts, file)).isFile());
};

const RECORD = `
const edges = [];
const { registerHooks } = await import("node:module");
if (typeof registerHooks === "function") {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (context.parentURL !== import.meta.url) edges.push([context.parentURL, resolved.url]);
      return resolved;
    },
  });
  for (const url of process.argv.slice(1)) await import(url);
}
console.log(JSON.stringify(edges));
`;
// Node 20 has no module.registerHooks, so the hook recorder above prints an
// empty edge list there. Every runtime import in these sources is a static
// `import ... from "<file>.ts"` (the RUNTIME check asserts no dynamic
// import() exists at all), so a static scan produces the same edge list —
// excluding `import type`/`export type`, which type-stripping erases and the
// runtime recorder therefore never sees.
const STATIC_SPEC = /\bimport\b(?!\s+type\b)\s*[\w$*\s{},]*?\bfrom\b\s*["']([^"']+)["']|\bimport\b(?!\s+type\b)\s*["']([^"']+)["']|\bexport\b(?!\s+type\b)\s*[\w$*\s{},]*?\bfrom\b\s*["']([^"']+)["']/g;
const staticLoads = (...targets: string[]) => {
  const edges: string[][] = [];
  const seenFile = new Set<string>();
  const seenEdge = new Set<string>();
  const walk = (file: string) => {
    if (seenFile.has(file)) return;
    seenFile.add(file);
    for (const m of codeOf(file).matchAll(STATIC_SPEC)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith("node:") || !spec.startsWith(".")) {
        edges.push([file, spec]);
        continue;
      }
      const to = path
        .relative(scripts, path.resolve(scripts, path.dirname(file), spec))
        .split(path.sep)
        .join("/");
      const key = `${file}->${to}`;
      if (!seenEdge.has(key)) {
        seenEdge.add(key);
        edges.push([file, to]);
      }
      if (fs.existsSync(path.join(scripts, to))) walk(to);
    }
  };
  for (const target of targets)
    for (const file of sources(target)) walk(file.split(path.sep).join("/"));
  return edges;
};
const loads = (...targets: string[]) => {
  const urls = targets.flatMap(sources).map((file) => pathToFileURL(path.join(scripts, file)).href);
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", RECORD, ...urls], {
    encoding: "utf8",
  });
  if (JSON.parse(out).length === 0 && urls.length > 0) return staticLoads(...targets);
  const name = (url: string) =>
    url.startsWith("file:") ? path.relative(scripts, fileURLToPath(url)) : url;
  return (JSON.parse(out) as string[][]).map(([from, to]) => [name(from), name(to)]);
};

const COMMENT =
  /("(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const codeOf = (file: string) =>
  fs.readFileSync(path.join(scripts, file), "utf8").replace(COMMENT, (_, text) => text ?? " ");

const RUNTIME =
  /\b(?:process|require|globalThis|global|Deno|Bun|Buffer|setImmediate|clearImmediate|fetch)\b|\bimport\s*\(/g;
const TYPE_IMPORT =
  /\b(?:import|export)\s+type\b\s*(?:[\w$]+|\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"']*)["']/g;
const typeImports = (file: string) =>
  Array.from(codeOf(file).matchAll(TYPE_IMPORT), (m) => path.join(path.dirname(file), m[1]));

test("ir.ts imports nothing", () => {
  assert.deepEqual(loads("ir.ts"), []);
  assert.deepEqual(typeImports("ir.ts"), []);
});

test("each pass imports only ir.ts", () => {
  const files = sources("passes");
  assert.deepEqual(
    files.filter((file) => !file.endsWith(".ts")),
    [],
  );
  const found = loads("passes");
  assert.ok(found.length > 0);
  for (const [from, to] of found) assert.equal(to, "ir.ts", `${from} imports ${to}`);
  for (const file of files)
    for (const to of typeImports(file))
      assert.equal(to, "ir.ts", `${file} imports types from ${to}`);
});

test("pipeline.ts reaches no node: module", () => {
  assert.deepEqual(
    loads("pipeline.ts").filter(([, to]) => to.startsWith("node:")),
    [],
  );
  for (const to of typeImports("pipeline.ts"))
    assert.equal(to, "ir.ts", `pipeline.ts imports types from ${to}`);
});

test("ir.ts, the passes, pipeline.ts, the frontends, the backends, and every file they load are .ts files that name no listed runtime global and call no import()", () => {
  const targets = ["ir.ts", "passes", "pipeline.ts", "frontends", "backends"];
  const reached = loads(...targets).flatMap(([, to]) => (to.startsWith("node:") ? [] : [to]));
  const files = [...new Set([...targets.flatMap(sources), ...reached])];
  assert.deepEqual(
    files.filter((file) => !file.endsWith(".ts")),
    [],
  );
  for (const file of files) assert.deepEqual(codeOf(file).match(RUNTIME), null, file);
});

test("no frontend or backend loads a node: module when imported, even through another file", () => {
  for (const folder of ["frontends", "backends"]) {
    const files = fs
      .readdirSync(path.join(scripts, folder), { encoding: "utf8", recursive: true })
      .filter((f) => f.endsWith(".ts"));
    assert.ok(files.length > 0, folder);
    for (const f of files)
      for (const [, to] of loads(path.join(folder, f)))
        assert.ok(!to.startsWith("node:"), `${folder}/${f} reaches ${to}`);
  }
});

const small: Rule = { kind: "invariant", name: "Small" };

const noView = checkView({}, inspect);

const holding = (spec: Spec) => {
  const verdicts: Verdict[] = [];
  for (const rule of stateRules(spec))
    verdicts.push({ rule, outcome: "holds", messages: undefined });
  return verdicts;
};

const twoStates = (breaks: Rule[], property = "Settles"): CheckResult => ({
  spec: {
    module: "Two",
    variables: ["x"],
    invariants: ["Small"],
    properties: [property],
    deadlock: false,
    written: [],
    folder: "",
  },
  paths: undefined,
  graph: {
    states: new Map([
      ["1", { vars: { x: 0 }, start: true, breaks: [] }],
      ["2", { vars: { x: 1 }, start: false, breaks }],
    ]),
    steps: [{ from: "1", to: "2", action: "Grow" }],
  },
  rules: [{ rule: small, outcome: breaks.length ? "broken" : "holds", messages: undefined }],
  properties: [
    {
      rule: { kind: "property", name: property },
      outcome: breaks.length ? "broken" : "holds",
      messages: [
        {
          code: EC.TLC_STATE_PRINT2,
          level: LEVEL.STATE,
          body: ["1: <Initial predicate>", "x = 0"],
        },
      ],
      bug: undefined,
      initialOnly: false,
    },
  ],
  exit: breaks.length ? 1 : 0,
  stop: undefined,
  drawing: undefined,
  states: { distinct: 2, initial: 1, complete: true, cut: false },
  messages: [{ code: EC.TLC_FINISHED, level: LEVEL.NONE, body: ["Finished in 394ms at (T)"] }],
});

const body = (files: Map<string, Iterable<string | Uint8Array>>, name: string) => {
  let text = "";
  for (const part of files.get(name) ?? [])
    text += typeof part === "string" ? part : new TextDecoder().decode(part);
  return text;
};

test("the pipeline turns a hand-built graph into the out folder's files with no TLC", () => {
  const broken = compile(twoStates([small]), noView);
  assert.equal(broken.exit, 1);
  assert.deepEqual(
    [...broken.files.keys()],
    ["chart.mmd", "report.md", "tlc.out", "tlc-Settles.out"],
  );
  assert.equal(body(broken.files, "report.md"), broken.report);
  assert.equal(body(broken.files, "tlc.out"), "Finished in 00s at (T)\n");
  assert.equal(body(broken.files, "tlc-Settles.out"), "State 1: <Initial predicate>\nx = 0\n");
  assert.equal(
    broken.report,
    [
      "# Two",
      "",
      "TLC reached 2 states and 1 steps. The chart draws 2 states and 1 arrows.",
      "",
      "## Small breaks",
      "The shortest path has 1 step:",
      "0. 0",
      "1. Grow: 1",
      "",
      "## Settles breaks",
      "TLC found a counterexample. It is in tlc-Settles.out.",
    ].join("\n"),
  );
  assert.match(
    body(broken.files, "chart.mmd"),
    /^ {2}(s\d+) --> (s\d+): Grow\n[\s\S]*^ {2}class \2 breaks$/m,
  );

  const holds = compile(twoStates([]), noView);
  assert.equal(holds.exit, 0);
  assert.deepEqual([...holds.files.keys()], ["chart.mmd", "report.md", "tlc.out"]);
  assert.match(holds.report, /^## Rules that hold\nSmall, Settles$/m);
  assert.doesNotMatch(body(holds.files, "chart.mmd"), /breaks/);
});

test("an invariant and a property with one name stay two rules", () => {
  const reportWithSmallProperty = (breaks: Rule[]) => {
    const result = twoStates(breaks);
    const step = result.graph.steps[0];
    result.spec.properties = ["Small"];
    result.properties = [
      {
        rule: { kind: "property", name: "Small" },
        outcome: "broken",
        messages: [],
        bug: { start: "1", path: [{ action: "Grow", state: "2", step }], loop: 1, stutters: true },
        initialOnly: false,
      },
    ];
    return compile(result, noView).report;
  };
  const both = reportWithSmallProperty([small]);
  assert.match(both, /^## Small breaks\nThe shortest path has 1 step:$/m);
  assert.match(
    both,
    /^## Small breaks\nTLC's counterexample is in tlc-Small\.out\. It has 1 step:$/m,
  );
  assert.match(reportWithSmallProperty([]), /^## Rules that hold\nSmall$/m);
});

test("a PROPERTY that breaks with no path writes TLC's counterexample", () => {
  const result = twoStates([]);
  result.properties[0].outcome = "broken";
  const { report, files } = compile(result, noView);
  assert.match(
    report,
    /^## Settles breaks\nTLC found a counterexample\. It is in tlc-Settles\.out\.$/m,
  );
  assert.equal(body(files, "tlc-Settles.out"), "State 1: <Initial predicate>\nx = 0\n");
});

test("a rule named NoDeadlock leaves the deadlock rule a name of its own", () => {
  const holds = (result: CheckResult) => {
    result.spec.deadlock = true;
    result.rules = holding(result.spec);
    return compile(result, noView).report.match(/^## Rules that hold\n(.*)$/m)?.[1];
  };
  const invariant = twoStates([]);
  invariant.spec.invariants = ["NoDeadlock"];
  assert.equal(holds(invariant), "NoDeadlock, CHECK_DEADLOCK, Settles");
  assert.equal(holds(twoStates([], "NoDeadlock")), "Small, CHECK_DEADLOCK, NoDeadlock");
  assert.equal(holds(twoStates([])), "Small, NoDeadlock, Settles");
});

test("a run that does not check for deadlock never names CHECK_DEADLOCK", () => {
  const invariant = twoStates([]);
  invariant.spec.invariants = ["Small", "NoDeadlock"];
  for (const result of [invariant, twoStates([], "NoDeadlock")]) {
    result.rules = holding(result.spec);
    assert.doesNotMatch(compile(result, noView).report, /CHECK_DEADLOCK/);
  }
});
