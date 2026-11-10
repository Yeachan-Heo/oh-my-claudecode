import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";

const here = path.dirname(fileURLToPath(import.meta.url));
const skip = !process.env.TLA2TOOLS && "set TLA2TOOLS to the path of tla2tools.jar to run TLC";

const PROTOTYPE_KEYS = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"];
const NAMES = [
  ...PROTOTYPE_KEYS,
  "x",
  "y",
  "phase",
  "mode",
  "Go",
  "Stop",
  "Undo",
  "Tick",
  "Reset",
  "Flip",
  "Ok",
  "Safe",
  "Bound",
  "Live",
  "NoJump",
  "red",
  "green",
  "blue",
  "idle",
  "busy",
  "done",
];
const LABELS = ["a b", ...PROTOTYPE_KEYS, "Lease held, write pending", "Ünï ✓"];
const STEPS = ["you press play", ...PROTOTYPE_KEYS, "the connect fails [while offline]"];
const GROUPS = ["paying", "a b", ...PROTOTYPE_KEYS];
const COLORS = ["blue", "orange", "purple", "yellow"];

const INT = fc.integer({ min: -3, max: 3 }).map(String);
const STRING = fc.constantFrom(
  String.raw`""`,
  String.raw`"a b"`,
  String.raw`"say \"hi\""`,
  String.raw`"back\\slash"`,
  String.raw`"tab\tstop"`,
  String.raw`"two\nlines"`,
  String.raw`"__proto__"`,
);
const values = (value: fc.Arbitrary<string>, maxLength = 4) =>
  fc.uniqueArray(value, { minLength: 1, maxLength });
const tuple = (items: string[]) => `<<${items.join(", ")}>>`;

type Domain = string[] | { modelValues: number };
const DOMAIN: fc.Arbitrary<Domain> = fc.oneof(
  values(INT),
  values(STRING),
  values(fc.constantFrom("TRUE", "FALSE"), 2),
  fc.integer({ min: 1, max: 4 }).map((modelValues) => ({ modelValues })),
  values(fc.tuple(INT, STRING).map(([i, s]) => `[constructor |-> ${i}, __proto__ |-> ${s}]`)),
  values(
    fc
      .uniqueArray(fc.tuple(INT, STRING), { maxLength: 2 })
      .map((ps) => `{${ps.map(tuple).join(", ")}}`),
  ),
  values(fc.array(INT, { maxLength: 2 }).map(tuple)),
);

const ATOM = fc.record({ v: fc.nat(2), i: fc.nat(3), not: fc.boolean() });
type Atom = { v: number; i: number; not: boolean };

const MODEL = fc.record({
  module: fc.constantFrom("Model", "prototype"),
  names: fc.shuffledSubarray(NAMES, { minLength: NAMES.length }),
  vars: fc.array(
    fc.record({ domain: DOMAIN, init: fc.array(fc.nat(3), { minLength: 1, maxLength: 2 }) }),
    { minLength: 1, maxLength: 3 },
  ),
  actions: fc.array(
    fc.record({
      guard: fc.array(ATOM, { maxLength: 2 }),
      set: fc.array(
        fc.record({ v: fc.nat(2), to: fc.array(fc.nat(3), { minLength: 1, maxLength: 2 }) }),
        { minLength: 1, maxLength: 2 },
      ),
    }),
    { minLength: 1, maxLength: 6 },
  ),
  invariants: fc.array(fc.array(ATOM, { minLength: 1, maxLength: 2 }), { maxLength: 2 }),
  deadlock: fc.boolean(),
  initNext: fc.boolean(),
  constraint: fc.option(ATOM, { freq: 2 }),
  actionConstraint: fc.option(fc.record({ v: fc.nat(2), from: fc.nat(3), to: fc.nat(3) }), {
    freq: 2,
  }),
  property: fc.option(
    fc.record({
      form: fc.nat(3),
      atoms: fc.tuple(ATOM, ATOM),
      fairness: fc.option(fc.record({ strong: fc.boolean(), on: fc.option(fc.nat(5)) })),
    }),
  ),
  view: fc.option(
    fc.record({
      form: fc.constantFrom("string", "parents", "regions"),
      labels: fc.uniqueArray(fc.constantFrom(...LABELS), { minLength: 1, maxLength: 4 }),
      regions: fc.uniqueArray(fc.constantFrom("Session", ...LABELS), {
        minLength: 1,
        maxLength: 3,
      }),
      steps: fc.option(fc.array(fc.option(fc.constantFrom(...STEPS)), { maxLength: 6 })),
      title: fc.option(fc.constantFrom("A b c", "constructor")),
      groups: fc.option(fc.uniqueArray(fc.constantFrom(...GROUPS), { minLength: 1, maxLength: 3 })),
    }),
  ),
});
type Model = typeof MODEL extends fc.Arbitrary<infer M> ? M : never;
type Case = {
  module: string;
  tla: string;
  view?: string;
  base: string[];
  invariants: string[];
  deadlock: boolean;
  property?: string;
};

const configOf = (c: Case) => {
  const cfg = [...c.base];
  if (c.invariants.length) cfg.push(`INVARIANTS ${c.invariants.join(" ")}`);
  if (!c.deadlock) cfg.push("CHECK_DEADLOCK FALSE");
  if (c.property) cfg.push(`PROPERTY ${c.property}`);
  return `${cfg.join("\n")}\n`;
};

function caseOf(m: Model): Case {
  let next = 0;
  const name = () => m.names[next++];
  const vars = m.vars.map(name);
  const domains = m.vars.map(({ domain }) =>
    Array.isArray(domain) ? domain : Array.from({ length: domain.modelValues }, name),
  );
  const modelValues = m.vars.flatMap(({ domain }, k) => (Array.isArray(domain) ? [] : domains[k]));
  const value = (v: number, i: number) =>
    domains[v % vars.length][i % domains[v % vars.length].length];
  const atom = ({ v, i, not }: Atom) =>
    `${vars[v % vars.length]} ${not ? "#" : "="} ${value(v, i)}`;
  const set = (v: number, is: number[]) =>
    `{${[...new Set(is.map((i) => value(v, i)))].join(", ")}}`;
  const defs = [`vars == <<${vars.join(", ")}>>`];
  defs.push(`Init == ${vars.map((x, k) => `${x} \\in ${set(k, m.vars[k].init)}`).join(" /\\ ")}`);
  const actions = m.actions.map((a) => {
    const changed = new Map<number, number[]>();
    for (const s of a.set)
      if (!changed.has(s.v % vars.length)) changed.set(s.v % vars.length, s.to);
    const parts = a.guard.map(atom);
    for (const [k, to] of changed) parts.push(`${vars[k]}' \\in ${set(k, to)}`);
    const kept = vars.filter((_, k) => !changed.has(k));
    if (kept.length) parts.push(`UNCHANGED <<${kept.join(", ")}>>`);
    const action = name();
    defs.push(`${action} == ${parts.join(" /\\ ")}`);
    return action;
  });
  defs.push(`Next == ${actions.join(" \\/ ")}`);
  const base = modelValues.length
    ? [`CONSTANTS ${modelValues.map((c) => `${c} = ${c}`).join(" ")}`]
    : [];
  const p = m.property;
  const f = p?.fairness;
  const fair = f
    ? ` /\\ ${f.strong ? "SF" : "WF"}_vars(${f.on === null ? "Next" : actions[f.on % actions.length]})`
    : "";
  defs.push(`Spec == Init /\\ [][Next]_vars${fair}`);
  base.push(m.initNext && !p ? "INIT Init\nNEXT Next" : "SPECIFICATION Spec");
  const invariants = m.invariants.map((atoms) => {
    const rule = name();
    defs.push(`${rule} == ~(${atoms.map(atom).join(" /\\ ")})`);
    return rule;
  });
  if (m.constraint) {
    const bound = name();
    defs.push(`${bound} == ~(${atom(m.constraint)})`);
    base.push(`CONSTRAINT ${bound}`);
  }
  if (m.actionConstraint) {
    const { v, from, to } = m.actionConstraint;
    const x = vars[v % vars.length];
    const bound = name();
    defs.push(`${bound} == ~(${x} = ${value(v, from)} /\\ ${x}' = ${value(v, to)})`);
    base.push(`ACTION_CONSTRAINT ${bound}`);
  }
  let property: string | undefined;
  if (p) {
    const [a, b] = p.atoms.map(atom);
    property = name();
    defs.push(
      `${property} == ${[`<>(${a})`, `[]<>(${a})`, `(${a}) ~> (${b})`, `[](${a})`][p.form]}`,
    );
  }
  const tla = [
    `---- MODULE ${m.module} ----`,
    "EXTENDS Integers",
    ...(modelValues.length ? [`CONSTANTS ${modelValues.join(", ")}`] : []),
    `VARIABLES ${vars.join(", ")}`,
    ...defs,
    "====",
    "",
  ].join("\n");
  return {
    module: m.module,
    tla,
    view: m.view ? viewOf(m.view, vars, actions) : undefined,
    base,
    invariants,
    deadlock: m.deadlock,
    property,
  };
}

function viewOf(v: NonNullable<Model["view"]>, vars: string[], actions: string[]) {
  const json = JSON.stringify;
  const state = {
    string: `pick(VARS.map((n) => v[n]), 0)`,
    parents: `[pick(v[VARS[0]], 1), pick(VARS.map((n) => v[n]), 2)]`,
    regions: `Object.fromEntries(${json(v.regions)}.map((r, k) => [r, pick(v[VARS[k % VARS.length]], k)]))`,
  }[v.form];
  const lines = [
    `const VARS = ${json(vars)};`,
    `const LABELS = ${json(v.labels)};`,
    "const pick = (value, salt, from = LABELS) => {",
    "  let h = salt;",
    '  for (const c of JSON.stringify(value) ?? "") h = (h * 31 + c.codePointAt(0)) >>> 0;',
    "  return from[h % from.length];",
    "};",
    `export const state = (v) => ${state};`,
  ];
  const { steps } = v;
  if (steps) {
    const labels = actions.map((a, k) => [a, k < steps.length ? steps[k] : a]);
    lines.push(
      `const STEPS = new Map(${json(labels)});`,
      "export const step = (action) => STEPS.get(action);",
    );
  }
  if (v.title) lines.push(`export const title = ${json(v.title)};`);
  if (v.groups) {
    const colors = v.groups.map((g, k) => [g, COLORS[k]]);
    lines.push(
      `export const colors = Object.fromEntries(${json(colors)});`,
      `export const group = (v) => pick(v[VARS[0]], 3, ${json(v.groups)});`,
    );
  }
  return `${lines.join("\n")}\n`;
}

type Run = { status: number | null; stdout: string; stderr: string };

const run = (command: string, args: string[], cwd: string) =>
  new Promise<Run>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C.UTF-8" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => stdout.push(b));
    child.stderr.on("data", (b: Buffer) => stderr.push(b));
    child.on("error", reject);
    child.on("close", (status) =>
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      }),
    );
  });

const plainTlc = (dir: string, c: Case, name: string, lines: string[]) => {
  fs.writeFileSync(path.join(dir, `${name}.cfg`), `${[...c.base, ...lines].join("\n")}\n`);
  fs.mkdirSync(path.join(dir, `tmp-${name}`));
  return run(
    process.env.JAVA || "java",
    [
      `-Djava.io.tmpdir=${path.join(dir, `tmp-${name}`)}`,
      "-cp",
      String(process.env.TLA2TOOLS),
      "tlc2.TLC",
      "-tool",
      "-workers",
      "1",
      "-config",
      `${name}.cfg`,
      "-metadir",
      path.join(dir, `meta-${name}`),
      c.module,
    ],
    dir,
  );
};

type Claim = { breaks: boolean; steps?: number };

const claimOf = (r: Run, breaks: number[], traced: boolean): Claim => {
  if (r.status === 0) return { breaks: false };
  if (r.status === null || !breaks.includes(r.status))
    throw new Error(`plain TLC exited ${r.status}:\n${r.stdout}${r.stderr}`);
  if (!traced) return { breaks: true };
  const states = r.stdout.split("@!@!@STARTMSG 2217:").length - 1;
  return { breaks: true, steps: Math.max(states, 1) - 1 };
};

async function plainAnswers(dir: string, c: Case) {
  const rules = new Map<string, Promise<Claim>>();
  for (const name of c.invariants)
    rules.set(
      name,
      plainTlc(dir, c, `inv-${name}`, [`INVARIANT ${name}`, "CHECK_DEADLOCK FALSE"]).then((r) =>
        claimOf(r, [12], true),
      ),
    );
  if (c.deadlock)
    rules.set(
      "NoDeadlock",
      plainTlc(dir, c, "deadlock", []).then((r) => claimOf(r, [11], true)),
    );
  if (c.property)
    rules.set(
      c.property,
      plainTlc(dir, c, "property", [`PROPERTY ${c.property}`, "CHECK_DEADLOCK FALSE"]).then((r) =>
        claimOf(r, [12, 13], false),
      ),
    );
  const states = plainTlc(dir, c, "states", ["CHECK_DEADLOCK FALSE"]).then((r) => {
    const found = /([\d,]+) distinct states found/.exec(r.stdout);
    if (r.status !== 0 || !found)
      throw new Error(`plain TLC exited ${r.status}:\n${r.stdout}${r.stderr}`);
    return Number(found[1].replaceAll(",", ""));
  });
  const answers = new Map<string, Claim>();
  for (const [name, claim] of rules) answers.set(name, await claim);
  const broke = [...answers.values()].some((a) => a.breaks);
  return { status: broke ? 1 : 0, states: await states, rules: answers };
}

function compilerAnswers(r: Run, c: Case) {
  const lines = r.stdout.split("\n");
  const rules = new Map<string, Claim>();
  for (const [i, line] of lines.entries()) {
    const broken = /^## (\S+) breaks$/.exec(line);
    if (broken) {
      const shortest = /^The shortest path has (\d+) steps?:$/.exec(lines[i + 1]);
      rules.set(
        broken[1],
        broken[1] === c.property
          ? { breaks: true }
          : { breaks: true, steps: Number(shortest?.[1]) },
      );
    }
    if (line === "## Rules that hold")
      for (const name of lines[i + 1].split(", ")) rules.set(name, { breaks: false });
  }
  const states = /^TLC reached (\d+) states/m.exec(r.stdout);
  return { status: r.status, states: states ? Number(states[1]) : r.stderr, rules };
}

async function answer(c: Case) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statechart-differential-"));
  try {
    fs.writeFileSync(path.join(dir, `${c.module}.tla`), c.tla);
    fs.writeFileSync(path.join(dir, `${c.module}.cfg`), configOf(c));
    if (c.view !== undefined) fs.writeFileSync(path.join(dir, "view.mjs"), c.view);
    const compile = (view: string[]) =>
      run(
        process.execPath,
        [path.join(here, "../statechart.ts"), `${c.module}.tla`, ...view, "--out", "out"],
        dir,
      );
    const [viewed, plain] = await Promise.all([
      compile(c.view === undefined ? [] : ["--view", "view.mjs"]),
      plainAnswers(dir, c),
    ]);
    const refused =
      c.view !== undefined &&
      viewed.status === 2 &&
      /^(The view's |The chart draws the step )/.test(viewed.stderr);
    const compiled = refused ? await compile([]) : viewed;
    assert.deepEqual(compilerAnswers(compiled, c), plain);
    return compiled.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "the compiler answers each rule as plain TLC does for generated models",
  { skip },
  async () => {
    await fc.assert(
      fc.asyncProperty(MODEL.map(caseOf), async (c) => {
        await answer(c);
      }),
      {
        numRuns: Number(process.env.STATECHART_DIFFERENTIAL_RUNS ?? 20),
        seed: process.env.STATECHART_DIFFERENTIAL_SEED
          ? Number(process.env.STATECHART_DIFFERENTIAL_SEED)
          : undefined,
        includeErrorInReport: true,
      },
    );
  },
);

const moduleText = (name: string, ...lines: string[]) =>
  [`---- MODULE ${name} ----`, ...lines, "====", ""].join("\n");

const counting = (print: string) =>
  moduleText(
    "Count",
    "EXTENDS Naturals, TLC",
    "VARIABLE x",
    "Init == x = 0",
    `Next == x < 2 /\\ x' = x + 1 /\\ PrintT(${print})`,
    "Spec == Init /\\ [][Next]_x",
    "Ok == x <= 2",
  );

for (const [what, c, says] of [
  [
    "a string and a model value with one name are two states, and the path to the string has no steps",
    {
      module: "Collide",
      tla: moduleText(
        "Collide",
        "CONSTANT A",
        "VARIABLE x",
        'Init == x = "A"',
        String.raw`ToModel == x = "A" /\ x' = A`,
        String.raw`Back == x = A /\ x' = "A"`,
        "Next == ToModel \\/ Back",
        "Spec == Init /\\ [][Next]_x",
        'NotString == x # "A"',
      ),
      base: ["CONSTANT A = A", "SPECIFICATION Spec"],
      invariants: ["NotString"],
      deadlock: true,
    },
    ['The shortest path has 0 steps:\n0. "A"\n'],
  ],
  [
    "a state that holds an interval reads, and equals the set that TLC builds for it",
    {
      module: "Interval",
      tla: moduleText(
        "Interval",
        "EXTENDS FiniteSets, Naturals",
        "VARIABLE x",
        "Init == x = 1..3",
        String.raw`Next == x' = IF x = 1..3 THEN 1..4 ELSE x \ {4}`,
        "Spec == Init /\\ [][Next]_x",
        "Small == Cardinality(x) < 4",
      ),
      base: ["SPECIFICATION Spec"],
      invariants: ["Small"],
      deadlock: true,
    },
    ["0. 1..3\n1. Next: 1..4\n"],
  ],
  [
    "a string with quotes, backslashes, newlines, and tabs prints escaped on one path line",
    {
      module: "Odd",
      tla: moduleText(
        "Odd",
        "EXTENDS Naturals, Sequences",
        "VARIABLES s, i",
        String.raw`Words == <<"plain", "a\"b", "back\\slash", "line\nbreak", "tab\tstop", "x\n/\\ i = 99", "end\\">>`,
        "Init == i = 1 /\\ s = Words[1]",
        "Next == i < Len(Words) /\\ i' = i + 1 /\\ s' = Words[i + 1]",
        "Spec == Init /\\ [][Next]_<<s, i>>",
        "NotLast == i < Len(Words)",
      ),
      base: ["SPECIFICATION Spec"],
      invariants: ["NotLast"],
      deadlock: false,
    },
    [
      [
        String.raw`0. i=1 s="plain"`,
        String.raw`1. Next: i=2 s="a\"b"`,
        String.raw`2. Next: i=3 s="back\\slash"`,
        String.raw`3. Next: i=4 s="line\nbreak"`,
        String.raw`4. Next: i=5 s="tab\tstop"`,
        String.raw`5. Next: i=6 s="x\n/\\ i = 99"`,
        String.raw`6. Next: i=7 s="end\\"`,
        "",
      ].join("\n"),
    ],
  ],
  [
    "a variable and a record field named __proto__ reach the view as their own fields",
    {
      module: "Proto",
      tla: moduleText(
        "Proto",
        "VARIABLES __proto__, r",
        'Init == __proto__ = 0 /\\ r = [__proto__ |-> "a"]',
        String.raw`Next == __proto__ = 0 /\ __proto__' = 1 /\ r' = [__proto__ |-> "b"]`,
        "Spec == Init /\\ [][Next]_<<__proto__, r>>",
        "First == __proto__ = 0",
      ),
      view: "export const state = (v) => JSON.stringify(v);\n",
      base: ["SPECIFICATION Spec"],
      invariants: ["First"],
      deadlock: false,
    },
    [
      [
        String.raw`0. {"__proto__":0,"r":{"__proto__":"a"}}`,
        String.raw`1. Next: {"__proto__":1,"r":{"__proto__":"b"}}`,
        "",
      ].join("\n"),
    ],
  ],
  [
    "a spec that prints a line in the shape of a mark breaks no rule",
    {
      module: "Count",
      tla: counting('<<"chart", <<x + 1>>, {"Ok"}>>'),
      base: ["SPECIFICATION Spec"],
      invariants: ["Ok"],
      deadlock: true,
    },
    ["## NoDeadlock breaks\nThe shortest path has 2 steps:"],
  ],
  [
    "a spec that prints a line in the shape of a bad mark is not an error",
    {
      module: "Count",
      tla: counting('<<"chart", 1>>'),
      base: ["SPECIFICATION Spec"],
      invariants: ["Ok"],
      deadlock: false,
    },
    ["## Rules that hold\nOk\n"],
  ],
  [
    "a spec that prints a mark for a rule the config does not have is not an error",
    {
      module: "Count",
      tla: counting('<<"chart", <<x + 1>>, {"Nope"}>>'),
      base: ["SPECIFICATION Spec"],
      invariants: ["Ok"],
      deadlock: false,
    },
    ["## Rules that hold\nOk\n"],
  ],
] satisfies [string, Case, string[]][])
  test(`${what}, as plain TLC answers`, { skip }, async () => {
    const report = await answer(c);
    for (const said of says) assert.ok(report.includes(said), `${said}\nis not in\n${report}`);
  });
