import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, PINNED_FLAGS } from "../run.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = path.join(here, "corpus");
const skip = !process.env.TLA2TOOLS && "set TLA2TOOLS to the path of tla2tools.jar to run TLC";
const read = (file: string) => fs.readFileSync(file, "utf8");

for (const name of fs.readdirSync(corpus)) {
  test(`${name} gives the committed chart and report when TLC runs`, { skip }, () => {
    const dir = path.join(corpus, name);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "statechart-corpus-"));
    const tlc = path.join(tmp, "tlc");
    const out = path.join(tmp, "out");
    fs.mkdirSync(tlc);
    const view = path.join(dir, "view.mjs");
    const r = spawnSync(
      process.execPath,
      [
        path.join(here, "../statechart.ts"),
        path.join(dir, `${name}.tla`),
        ...(fs.existsSync(view) ? ["--view", view] : []),
        "--out",
        out,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          JAVA: path.join(here, "java.ts"),
          STATECHART_JAVA: process.env.JAVA ?? "java",
          STATECHART_RECORD: tlc,
        },
      },
    );
    assert.equal(r.stderr, "");
    if (process.env.STATECHART_UPDATE) {
      for (const f of fs.readdirSync(dir))
        if (/\.(out|exit|dot|mmd|md)$/.test(f)) fs.rmSync(path.join(dir, f));
      for (const f of fs.readdirSync(tlc)) fs.copyFileSync(path.join(tlc, f), path.join(dir, f));
      for (const f of ["chart.mmd", "report.md"])
        fs.copyFileSync(path.join(out, f), path.join(dir, f));
    }
    const report = read(path.join(out, "report.md"));
    const first = path.join(dir, "verdict-1.exit");
    const plain = fs.existsSync(first) ? Number(read(first)) : 0;
    assert.equal(r.status, plain === 0 ? 0 : [11, 12, 13].includes(plain) ? 1 : 2);
    assert.equal(report, read(path.join(dir, "report.md")));
    assert.equal(read(path.join(out, "chart.mmd")), read(path.join(dir, "chart.mmd")));
  });
}

test("a spec in a folder whose name is not ASCII checks under the POSIX locale", { skip }, () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "statechart-corpus-")), "spec-é");
  fs.cpSync(path.join(corpus, "Login"), dir, { recursive: true });
  const out = path.join(dir, "out");
  const r = spawnSync(
    process.execPath,
    [
      path.join(here, "../statechart.ts"),
      path.join(dir, "Login.tla"),
      "--view",
      path.join(dir, "view.mjs"),
      "--out",
      out,
    ],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "POSIX", LC_CTYPE: "", LANG: "" } },
  );
  assert.equal(r.stderr, "");
  assert.equal(r.status, 0);
  assert.equal(read(path.join(out, "chart.mmd")), read(path.join(corpus, "Login", "chart.mmd")));
});

test("an invariant named NoDeadlock and a deadlock break as two rules", { skip }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "statechart-corpus-")), "out");
  const r = spawnSync(
    process.execPath,
    [
      path.join(here, "../statechart.ts"),
      path.join(corpus, "UserNoDeadlock", "UserNoDeadlock.tla"),
      "--out",
      out,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.stderr, "");
  assert.equal(r.status, 1);
  const report = read(path.join(out, "report.md"));
  assert.match(
    report,
    /^## NoDeadlock breaks\nThe shortest path has 1 step:\n0\. 0\n1\. Next: 1$/m,
  );
  assert.match(
    report,
    /^## CHECK_DEADLOCK breaks\nThe shortest path has 3 steps:\n(.*\n){3}3\. Next: 3$/m,
  );
});

const writeSpec = (name: string, tla: string[], cfg: string) => {
  const base = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "statechart-corpus-")), name);
  fs.writeFileSync(`${base}.tla`, `${tla.join("\n")}\n`);
  fs.writeFileSync(`${base}.cfg`, cfg);
  return base;
};
const login = path.join(corpus, "Login", "Login");
const broken = () =>
  writeSpec(
    "Broken",
    ["---- MODULE Broken ----", "VARIABLE x", "Init == x = 0", "Next == x' = y", "===="],
    "INIT Init\nNEXT Next\n",
  );

const plainTlc = (base: string) => {
  const name = path.basename(base);
  const r = spawnSync(
    process.env.JAVA ?? "java",
    [
      "-cp",
      String(process.env.TLA2TOOLS),
      "tlc2.TLC",
      ...PINNED_FLAGS,
      "-config",
      `${name}.cfg`,
      `${name}.tla`,
    ],
    { cwd: path.dirname(base), encoding: "utf8" },
  );
  return {
    exit: r.status === 0 ? 0 : [11, 12, 13].includes(r.status ?? -1) ? 1 : 2,
    rule: r.stdout.match(/^Error: Invariant (\w+) is violated\.$/m)?.[1],
    path: [...r.stdout.matchAll(/^State \d+: <(\w+) line/gm)].map((m) => m[1]),
  };
};

const counter = (name: string, before: string[], variables: string[]) => [
  ...before,
  `---- MODULE ${name} ----`,
  "EXTENDS Naturals",
  ...variables,
  "Init == x = 0",
  "Next == x < 2 /\\ x' = x + 1",
  "Spec == Init /\\ [][Next]_x",
  "Low == x < 2",
  "====",
];

for (const [input, name, tla] of [
  [
    "a `(*` inside a `\\*` comment",
    "Paren",
    [
      "---- MODULE Paren ----",
      "EXTENDS Naturals",
      "\\* The reader calls f(*) on each tick.",
      "VARIABLES x, y",
      "Init == x = 0 /\\ y = 0",
      "Tick == x < 2 /\\ x' = x + 1 /\\ UNCHANGED y",
      "Next == Tick",
      "Spec == Init /\\ [][Next]_<<x, y>>",
      "(* x never passes 1 *)",
      "Low == x < 2",
      "====",
    ],
  ],
  [
    "a nested block comment",
    "Nested",
    counter("Nested", [], ["(* outer (* inner *) VARIABLES ghost *)", "VARIABLE x"]),
  ],
  [
    'a "(*" string',
    "Str",
    [
      "---- MODULE Str ----",
      "EXTENDS Naturals",
      "VARIABLE x",
      'Open == "(*"',
      "VARIABLE y",
      'Close == "*)"',
      "Init == x = 0 /\\ y = 0",
      "Next == x < 2 /\\ x' = x + 1 /\\ UNCHANGED y",
      "Spec == Init /\\ [][Next]_<<x, y>>",
      "Low == x < 2",
      "====",
    ],
  ],
  [
    "text before the module header",
    "Pre",
    counter("Pre", ["Notes before the header: VARIABLES fake"], ["VARIABLE x"]),
  ],
] as const) {
  test(`a spec with ${input} gives plain TLC's exit and path`, { skip }, () => {
    const base = writeSpec(name, [...tla], "SPECIFICATION Spec\nINVARIANT Low\n");
    const tlc = plainTlc(base);
    assert.equal(tlc.rule, "Low");
    const out = path.join(path.dirname(base), "out");
    const r = spawnSync(
      process.execPath,
      [path.join(here, "../statechart.ts"), `${base}.tla`, "--out", out],
      { encoding: "utf8" },
    );
    assert.equal(r.stderr, "");
    assert.equal(r.status, tlc.exit);
    const steps = read(path.join(out, "report.md")).match(
      new RegExp(
        `^## ${tlc.rule} breaks\\nThe shortest path has \\d+ steps?:\\n0\\. .*\\n((?:\\d+\\. .*\\n?)*)`,
        "m",
      ),
    );
    assert.ok(steps, `the report has a path for ${tlc.rule}`);
    assert.deepEqual(
      [...steps[1].matchAll(/^\d+\. (\w+): /gm)].map((m) => m[1]),
      tlc.path,
    );
  });
}

test("a property that breaks on a loop draws the loop and reports it", { skip }, () => {
  const base = writeSpec(
    "Cycle",
    [
      "---- MODULE Cycle ----",
      "EXTENDS Integers",
      "VARIABLE x",
      "Init == x = 0",
      "Next == x' = (x + 1) % 3",
      "Spec == Init /\\ [][Next]_x /\\ WF_x(Next)",
      "Prop == <>(x = 5)",
      "====",
    ],
    "SPECIFICATION Spec\nPROPERTY Prop\n",
  );
  const out = path.join(path.dirname(base), "out");
  const r = spawnSync(
    process.execPath,
    [path.join(here, "../statechart.ts"), `${base}.tla`, "--out", out],
    { encoding: "utf8" },
  );
  assert.equal(r.stderr, "");
  assert.equal(r.status, 1);
  assert.match(
    read(path.join(out, "report.md")),
    /^## Prop breaks\nTLC's counterexample is in tlc-Prop\.out\. It has 3 steps:\n0\. 0\n1\. Next: 1\n2\. Next: 2\n3\. Next: 0\nThe run loops through "0", "1" and "2" forever\.$/m,
  );
  assert.equal(read(path.join(out, "chart.mmd")).match(/^ {2}class s\d+ repeats$/gm)?.length, 3);
});

test(
  "a property's loop comes from the whole state graph when TLC explores for over 3 seconds",
  { skip },
  () => {
    const base = writeSpec(
      "SlowLoop",
      [
        "---- MODULE SlowLoop ----",
        "EXTENDS Integers, TLC",
        "VARIABLE x",
        'Late(v) == IF \\E i \\in 1..2000000000 : TLCGet("duration") >= 6 THEN v ELSE v',
        "Init == x = 0",
        "Deep == x \\in 0..14 /\\ x' = IF x = 5 THEN Late(x + 1) ELSE x + 1",
        "Turn == x = 15 /\\ x' = 16",
        "Back == x = 16 /\\ x' = 15",
        "Leave == x = 0 /\\ x' = -1",
        "Return == x = -1 /\\ x' = 0",
        "Next == Deep \\/ Turn \\/ Back \\/ Leave \\/ Return",
        "Spec == Init /\\ [][Next]_x /\\ WF_x(Next)",
        "Prop == <>(x = 99)",
        "====",
      ],
      "SPECIFICATION Spec\nPROPERTY Prop\n",
    );
    const out = path.join(path.dirname(base), "out");
    const r = spawnSync(
      process.execPath,
      [path.join(here, "../statechart.ts"), `${base}.tla`, "--out", out],
      { encoding: "utf8" },
    );
    assert.equal(r.stderr, "");
    assert.equal(r.status, 1);
    assert.match(
      read(path.join(out, "report.md")),
      /^## Prop breaks\nTLC's counterexample is in tlc-Prop\.out\. It has 17 steps:\n0\. 0\n1\. Deep: 1\n(.*\n){14}16\. Turn: 16\n17\. Back: 15\nThe run loops through "15" and "16" forever\.$/m,
    );
  },
);

for (const [width, height, config, status, drawn, chart, header] of [
  [
    20,
    25,
    "INVARIANT Typed",
    0,
    true,
    true,
    "TLC reached 500 states and 955 steps. The chart draws 500 states and 955 arrows.",
  ],
  [
    3,
    167,
    "INVARIANT Typed",
    0,
    false,
    false,
    "TLC reached 501 states, more than the chart budget of 500, so the command wrote no chart.mmd.",
  ],
  [
    40,
    40,
    "INVARIANT Typed",
    0,
    false,
    false,
    "TLC reached 1,600 states, more than the chart budget of 500, so the command wrote no chart.mmd.",
  ],
  [
    40,
    40,
    "INVARIANT Near",
    1,
    true,
    true,
    "TLC reached more states than the chart budget of 500, so the chart draws only the bug paths: 4 states and 3 arrows.",
  ],
  [
    40,
    40,
    "INVARIANT Far",
    1,
    false,
    true,
    "TLC reached more states than the chart budget of 500, so the chart draws only the bug paths: 79 states and 78 arrows.",
  ],
] as const)
  test(
    `TLC keeps the chart within its budget of 500 states on a ${width} by ${height} grid with ${config}`,
    { skip },
    () => {
      const base = writeSpec(
        "Wide",
        [
          "---- MODULE Wide ----",
          "EXTENDS Naturals",
          "VARIABLES x, y",
          "Init == x = 0 /\\ y = 0",
          `IncX == x < ${width - 1} /\\ x' = x + 1 /\\ y' = y`,
          `IncY == y < ${height - 1} /\\ y' = y + 1 /\\ x' = x`,
          "Next == IncX \\/ IncY",
          "Typed == x \\in 0..39",
          "Near == ~(x = 2 /\\ y = 1)",
          `Far == ~(x = ${width - 1} /\\ y = ${height - 1})`,
          "====",
        ],
        `INIT Init\nNEXT Next\n${config}\nCHECK_DEADLOCK FALSE\n`,
      );
      const tlc = path.join(path.dirname(base), "tlc");
      const out = path.join(path.dirname(base), "out");
      fs.mkdirSync(tlc);
      const r = spawnSync(
        process.execPath,
        [path.join(here, "../statechart.ts"), `${base}.tla`, "--out", out],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            JAVA: path.join(here, "java.ts"),
            STATECHART_JAVA: process.env.JAVA ?? "java",
            STATECHART_RECORD: tlc,
          },
        },
      );
      assert.equal(r.stderr, "");
      assert.equal(r.status, status);
      assert.equal(fs.existsSync(path.join(tlc, "ChartRun.out")), drawn);
      assert.equal(fs.existsSync(path.join(out, "chart.mmd")), chart);
      assert.equal(read(path.join(out, "report.md")).split("\n")[2], header);
    },
  );

test(
  "check() leaves no statechart- folder in the temp dir when it returns and when it throws",
  { skip },
  async () => {
    const base = broken();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "statechart-corpus-"));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      await check(`${login}.tla`, `${login}.cfg`);
      await assert.rejects(check(`${base}.tla`, `${base}.cfg`), /SANY could not read/);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    assert.deepEqual(fs.readdirSync(tmp), []);
  },
);
