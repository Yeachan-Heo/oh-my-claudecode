import assert from "node:assert/strict";
import { test } from "node:test";
import { agrees, skip } from "./tlc.ts";

const late = [
  "---- MODULE Late ----",
  "EXTENDS Naturals, TLC",
  "CONSTANT Mode",
  "VARIABLES x",
  "f == [i \\in 0..2 |-> 0]",
  "Init == x = 0",
  "Grow == x < 5 /\\ x' = x + 1",
  'Bad == x = 3 /\\ \\/ Mode = "assert" /\\ Assert(FALSE, "late error") /\\ x\' = 0',
  '                \\/ Mode = "div" /\\ x\' = 1 \\div 0',
  "Next == Grow \\/ Bad",
  "Small == x < 1",
  "Below == x < 2",
  "InDomain == f[x] = 0",
  "====",
];
const lateCfg = (mode: string, rules: string) =>
  `CONSTANT Mode = "${mode}"\nINIT Init\nNEXT Next\nINVARIANTS ${rules}\n`;

test(
  "a rule that breaks before another rule fails to evaluate breaks in either order",
  { skip },
  () => {
    const first = agrees("Late", { Late: late }, lateCfg("none", "Below InDomain"));
    const last = agrees("Late", { Late: late }, lateCfg("none", "InDomain Below"));
    assert.equal(first.status, 1);
    assert.deepEqual(first.breaks, new Map([["Below", 2]]));
    assert.deepEqual(first.holds, []);
    assert.deepEqual(first.unchecked, ["InDomain", "NoDeadlock"]);
    assert.deepEqual(last, first);
  },
);

test("a rule that breaks before a step fails to evaluate breaks", { skip }, () => {
  for (const mode of ["div", "assert"]) {
    const v = agrees("Late", { Late: late }, lateCfg(mode, "Small"));
    assert.equal(v.status, 1);
    assert.deepEqual(v.breaks, new Map([["Small", 1]]));
    assert.deepEqual(v.unchecked, ["NoDeadlock"]);
  }
});

const warnPath = (next: string) => [
  "---- MODULE WarnPath ----",
  "EXTENDS Naturals",
  "VARIABLES x",
  "f == [i \\in 0..1 |-> i]",
  "Init == x = 0",
  "One == x < 3 /\\ x' = x + 1",
  "Two == x < 3 /\\ x' = x + 2",
  `Next == ${next}`,
  "Zero == f[x] = 0",
  "====",
];

test("a rule that breaks before it fails to evaluate breaks", { skip }, () => {
  const v = agrees(
    "WarnPath",
    { WarnPath: warnPath("One \\/ Two") },
    "INIT Init\nNEXT Next\nINVARIANT Zero\n",
  );
  assert.equal(v.status, 1);
  assert.equal(v.breaks.get("Zero"), 1);
});

test("a rule that fails to evaluate before TLC reaches a break exits 2", { skip }, () => {
  for (const deadlock of ["", "CHECK_DEADLOCK FALSE\n"]) {
    const v = agrees(
      "WarnPath",
      { WarnPath: warnPath("Two \\/ One") },
      `INIT Init\nNEXT Next\nINVARIANT Zero\n${deadlock}`,
    );
    assert.equal(v.status, 2);
    assert.deepEqual(v.holds, []);
  }
});

test("a rule that no verdict run checks stays not checked under a SYMMETRY", { skip }, () => {
  const v = agrees(
    "Hide",
    {
      Hide: [
        "---- MODULE Hide ----",
        "EXTENDS Naturals, TLC",
        "CONSTANTS a, b, S",
        "VARIABLES x, n",
        "Perms == Permutations(S)",
        "Init == x \\in S /\\ n = 0",
        "Next == n < 4 /\\ n' = n + 1 /\\ UNCHANGED x",
        "Early == n # 1",
        "Bad == x = a",
        'Boom == n < 3 \\/ Assert(FALSE, "boom")',
        "====",
      ],
    },
    "CONSTANTS a = a b = b S = {a, b}\nSYMMETRY Perms\nINIT Init\nNEXT Next\nINVARIANTS Early Boom Bad\n",
  );
  assert.equal(v.status, 1);
  assert.deepEqual(v.breaks, new Map([["Early", 1]]));
  assert.deepEqual(v.holds, []);
  assert.deepEqual(v.unchecked, ["Bad", "Boom", "NoDeadlock"]);
});

test("a deadlock breaks whatever shape the SPECIFICATION has", { skip }, () => {
  const live = agrees(
    "Live",
    {
      Live: [
        "---- MODULE Live ----",
        "EXTENDS Naturals",
        "VARIABLE x",
        "Init == x = 0",
        "Next == x < 2 /\\ x' = x + 1",
        "Spec == Init /\\ [][Next]_x",
        "LiveSpec == Spec /\\ WF_x(Next)",
        "TypeOK == x \\in 0..2",
        "====",
      ],
    },
    "SPECIFICATION LiveSpec\nINVARIANT TypeOK\n",
  );
  assert.deepEqual(live.breaks, new Map([["NoDeadlock", 2]]));
  assert.deepEqual(live.holds, ["TypeOK"]);
  for (const next of ["[][Next \\/ Tick]_vars", "[][\\E i \\in 1..2 : Step(i)]_vars"]) {
    const v = agrees(
      "Shape",
      {
        Shape: [
          "---- MODULE Shape ----",
          "EXTENDS Naturals",
          "VARIABLES x, t",
          "vars == <<x, t>>",
          "Init == x = 0 /\\ t = 0",
          "Step(i) == x < 2 /\\ x' = x + i /\\ UNCHANGED t",
          "Next == Step(1)",
          "Tick == t < 1 /\\ t' = 1 /\\ UNCHANGED x",
          `Spec == Init /\\ ${next}`,
          "====",
        ],
      },
      "SPECIFICATION Spec\n",
    );
    assert.equal(v.status, 1);
    assert.ok(v.breaks.has("NoDeadlock"));
  }
});

test("a SPECIFICATION from an INSTANCE checks deadlock and finds none", { skip }, () => {
  const v = agrees(
    "Outer",
    {
      Inner: [
        "---- MODULE Inner ----",
        "EXTENDS Naturals",
        "VARIABLE x",
        "Spec == x = 0 /\\ [][x' = (x + 1) % 3]_x",
        "====",
      ],
      Outer: [
        "---- MODULE Outer ----",
        "VARIABLE x",
        "I == INSTANCE Inner",
        "Spec == I!Spec",
        "====",
      ],
    },
    "SPECIFICATION Spec\n",
  );
  assert.equal(v.status, 0);
  assert.deepEqual(v.holds, ["NoDeadlock"]);
});

test("a state at a CONSTRAINT bound is no deadlock", { skip }, () => {
  const v = agrees(
    "Bound",
    {
      Bound: [
        "---- MODULE Bound ----",
        "EXTENDS Naturals",
        "VARIABLE x",
        "Init == x = 0",
        "Next == x' = x + 1",
        "Small == x < 3",
        "====",
      ],
    },
    "INIT Init\nNEXT Next\nCONSTRAINT Small\n",
  );
  assert.equal(v.status, 0);
  assert.deepEqual(v.holds, ["NoDeadlock"]);
  assert.doesNotMatch(v.chart, /^ {2}class s\d+ breaks$/m);
});

test(
  "a model with no initial state passes as it does in TLC, and the report says why",
  { skip },
  () => {
    const v = agrees(
      "NoInit",
      {
        NoInit: [
          "---- MODULE NoInit ----",
          "EXTENDS Naturals",
          "VARIABLE x",
          "Init == x = 0 /\\ x > 0",
          "Next == x' = x + 1",
          "Small == x < 3",
          "====",
        ],
      },
      "INIT Init\nNEXT Next\nINVARIANT Small\n",
    );
    assert.equal(v.status, 0);
    assert.deepEqual(v.holds, ["NoDeadlock", "Small"]);
    assert.match(
      v.report,
      /^TLC found no state that satisfies Init, so no state can break a rule\.$/m,
    );
  },
);

test(
  "a run after a break stops at the state bound and leaves its rules not checked",
  { skip },
  () => {
    const v = agrees(
      "Cycle",
      {
        Cycle: [
          "---- MODULE Cycle ----",
          "EXTENDS Naturals",
          "VARIABLE x",
          "Next == x' = (x + 1) % 100005",
          "Spec == x = 0 /\\ [][Next]_x /\\ WF_x(Next)",
          "Early == x # 3",
          "Back == []<>(x = 0)",
          "====",
        ],
      },
      "SPECIFICATION Spec\nINVARIANT Early\nPROPERTY Back\n",
    );
    assert.equal(v.status, 1);
    assert.deepEqual(v.breaks, new Map([["Early", 3]]));
    assert.deepEqual(v.holds, []);
    assert.deepEqual(v.unchecked, ["Back", "NoDeadlock"]);
    assert.match(
      v.report,
      /^After the first break, each TLC run stops at 100,000 distinct states\./m,
    );
  },
);
