export type Value =
  | boolean
  | number
  | string
  | { kind: "model"; name: string }
  | { kind: "bigint"; digits: string }
  | { kind: "set"; members: Value[] }
  | { kind: "interval"; lo: number; hi: number; rawLo?: string; rawHi?: string; lossy?: boolean }
  | { kind: "function"; printedAs: "tuple" | "record" | "pairs"; keys: Value[]; values: Value[] };

export type Vars = { [name: string]: Value };

export type Rule = { kind: "invariant" | "deadlock" | "property"; name: string };

type StateBase = { vars: Vars; start: boolean; breaks: Rule[] };

export type PastState = StateBase & { ends: Rule[]; past: true; excluded: boolean };

export type State =
  | (StateBase & { ends?: Rule[]; past?: undefined; excluded?: undefined })
  | PastState;

export type Step = { from: string; to: string; action: string };

export type Graph = { states: Map<string, State>; steps: Step[] };

export type PathStep = { action: string; state: string; step: Step };

export type Output = Iterable<Uint8Array>;

export type Lasso = {
  start: string;
  path: PathStep[];
  loop: number | undefined;
  stutters: boolean;
};

export type Mark = { values: Value[]; broken: string[] };

export type Past = Map<string, Set<Rule>>;

export type TraceState = { action: string; vars: Vars };

export type Trace = {
  seq: { action: string; vars: Vars | undefined }[];
  loop: number | undefined;
};

export type Find<Id> = (values: Value[]) => Id | undefined;

export type Bug = {
  rule: Rule;
  start: string;
  path: PathStep[];
  loop?: number;
  stutters?: boolean;
};

export type ConfigSection = { key: string; line: number; tokens: string[] };

export type Config = {
  sections: ConfigSection[];
  invariants: string[];
  properties: string[];
  constraints: string[];
  actionConstraints: string[];
  checkDeadlock?: boolean;
  init?: string;
  next?: string;
  spec?: string;
  view?: string;
  symmetry?: string;
  type?: string;
  typeConstraint?: string;
};

export type Spec = {
  module: string;
  variables: string[];
  invariants: string[];
  properties: string[];
  deadlock: boolean;
  written: ConfigSection[];
};

export type Message = { code: number; level: number; body: Part[]; beforeMarker?: string };

export type Line = string;

export type Part = Line | Message;

export const EC = {
  TLC_INVARIANT_VIOLATED_INITIAL: 2107,
  TLC_PROPERTY_VIOLATED_INITIAL: 2108,
  TLC_INVARIANT_VIOLATED_BEHAVIOR: 2110,
  TLC_ACTION_PROPERTY_VIOLATED_BEHAVIOR: 2112,
  TLC_DEADLOCK_REACHED: 2114,
  TLC_TEMPORAL_PROPERTY_VIOLATED: 2116,
  TLC_BACK_TO_STATE: 2122,
  TLC_FINISHED: 2186,
  TLC_INIT_GENERATED1: 2190,
  TLC_INIT_GENERATED2: 2191,
  TLC_STATS: 2199,
  TLC_PROGRESS_STATS: 2200,
  TLC_STATE_PRINT2: 2217,
  TLC_STATE_PRINT3: 2218,
  TLC_SANY_END: 2219,
  TLC_SANY_START: 2220,
} as const;

export const LEVEL = { NONE: 0, ERROR: 1, TLCBUG: 2, WARNING: 3, STATE: 4 } as const;

export type Outcome = "broken" | "holds" | "not checked";

export type Verdict = {
  rule: Rule;
  outcome: Outcome;
  messages: Iterable<Part> | undefined;
};

export type Property = Verdict & { bug: Lasso | undefined; initialOnly: boolean };

export type Stop = { status: number | null; message: string };

export type CheckResult = {
  spec: Spec & { folder: string };
  graph: Graph;
  paths: Bug[] | undefined;
  rules: Verdict[];
  properties: Property[];
  exit: 0 | 1 | 2;
  stop: Stop | undefined;
  drawing: { status: number | null } | undefined;
  states: { distinct: number; initial: number; complete: boolean; cut: boolean };
  messages: Iterable<Part>;
};

export const RERUN_STATES = 100_000;

export const CHART_STATES = 500;

export type View = {
  state?: (vars: Vars) => unknown;
  step?: (action: string, from: Vars, to: Vars) => unknown;
  group?: (vars: Vars) => unknown;
  colors?: { [group: string]: string };
  title?: string;
};

export const checked = Symbol("checked");

export type CheckedView = View & { readonly [checked]: true };

export type Shape = { [region: string]: string[] };

export type Walk = {
  ids: string[];
  states: State[];
  index: Map<string, number>;
  nameOf: string[];
  nameRank: Int32Array;
  from: Int32Array;
  to: Int32Array;
  action: Int32Array;
  depth: Int32Array;
  via: Int32Array;
  reached: Int32Array;
  starts: number[];
};

export type Hidden = null;

export type Answers = {
  names: string[];
  shapes: Shape[];
  labels: (string | Hidden)[];
  group: (i: number) => unknown;
};

export type Labels = Answers & {
  drawnLabels: string[];
  keys: string[][];
  kinds: Int32Array[];
  sizes: number[];
  sorted: Int32Array;
  pathStepIndex: Map<Step, number>;
  pathSteps: Uint8Array;
  together: Set<string>;
  notes: string[];
};

export type Story = { step?: string; state: Shape }[];

export type ChartState = {
  path: string[];
  start: boolean;
  members: number[];
  works: boolean;
  lead: boolean;
  repeats: boolean;
  breaks: { rule: Rule; always: boolean }[];
  group: unknown;
};

export type Condition =
  | { kind: "and" | "or"; otherKeys: Set<string>[] }
  | { kind: "tuples"; otherTuples: Set<string> };

export type Arrow = {
  from: string;
  to: string;
  label: string;
  condition: Condition;
  when?: string;
};

export type ChartStep = {
  from: string[];
  to: string[];
  label: string;
  when: string | undefined;
};

export type Region = {
  name: string;
  states: ChartState[];
  steps: ChartStep[];
  arrows: Arrow[];
};

export type Chart = {
  title: string | undefined;
  regions: Region[];
  notes: string[];
  inside: number;
  quiet: number;
  colors: { [group: string]: string };
  paths: string[];
  loops: string[];
  lie?: string;
};

export const isRecord = (v: unknown): v is { [key: string]: unknown } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

export const PART = 1 << 24;

export const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const list = (items: string[], and = "and") =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${and} ${items.at(-1)}`;

const ESCAPES: { [c: string]: string } = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\t": "\\t",
  "\r": "\\r",
  "\f": "\\f",
};
const quote = (s: string) => `"${s.replace(/["\\\n\t\r\f]/g, (c) => ESCAPES[c])}"`;

const joined = (items: Value[], sep: string) => {
  let s = "";
  for (let i = 0; i < items.length; i++) s += (i ? sep : "") + show(items[i]);
  return s;
};

export const show = (v: Value): string => {
  switch (typeof v) {
    case "boolean":
      return v ? "TRUE" : "FALSE";
    case "number":
      return String(v);
    case "string":
      return quote(v);
  }
  switch (v.kind) {
    case "model":
      return v.name;
    case "bigint":
      return v.digits;
    case "interval":
      // Lossy raw endpoints keep values past Number.MAX_SAFE_INTEGER exact.
      return v.lossy && v.rawLo && v.rawHi ? `${v.rawLo}..${v.rawHi}` : `${v.lo}..${v.hi}`;
    case "set":
      return `{${joined(v.members, ", ")}}`;
    case "function": {
      if (v.printedAs === "tuple") return `<<${joined(v.values, ", ")}>>`;
      const record = v.printedAs === "record";
      let s = record ? "[" : "(";
      for (let i = 0; i < v.keys.length; i++)
        s += record
          ? `${i ? ", " : ""}${String(v.keys[i])} |-> ${show(v.values[i])}`
          : `${i ? " @@ " : ""}${show(v.keys[i])} :> ${show(v.values[i])}`;
      return s + (record ? "]" : ")");
    }
  }
};

export const must = <K, V>(map: ReadonlyMap<K, V>, key: K): V => {
  const value = map.get(key);
  if (value === undefined) throw new Error(`The chart lost track of ${JSON.stringify(key)}.`);
  return value;
};

export const append = <K, V>(groups: Map<K, V[]>, key: K, item: V) => {
  const group = groups.get(key);
  if (group) group.push(item);
  else groups.set(key, [item]);
};

export const seqOf = (bug: Bug, index: ReadonlyMap<string, number>) => {
  const seq = [must(index, bug.start)];
  for (const p of bug.path) seq.push(must(index, p.state));
  return seq;
};

export const loopOf = (bug: Bug, index: ReadonlyMap<string, number>) =>
  new Set(bug.loop === undefined ? [] : seqOf(bug, index).slice(bug.loop));

export const defaultState = (vars: Vars) => {
  const entries = Object.entries(vars);
  if (entries.length === 1) return show(entries[0][1]);
  const parts: string[] = [];
  for (const [k, v] of entries) parts.push(`${k}=${show(v)}`);
  return parts.join(" ");
};

export const stateText = (vars: Vars) => {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(vars)) parts.push(`${k} = ${show(v)}`);
  return parts.join(" /\\ ");
};

export const count = (n: number) => {
  const items = new Int32Array(n);
  for (let i = 0; i < n; i++) items[i] = i;
  return items;
};

export const sortBy = (items: Int32Array, keys: Int32Array[]) => {
  for (let k = keys.length - 1; k >= 0; k--) {
    const key = keys[k];
    let size = 0;
    for (let p = 0; p < items.length; p++) if (key[items[p]] >= size) size = key[items[p]] + 1;
    const start = new Int32Array(size + 1);
    for (let p = 0; p < items.length; p++) start[key[items[p]] + 1]++;
    for (let v = 0; v < size; v++) start[v + 1] += start[v];
    const sorted = new Int32Array(items.length);
    for (let p = 0; p < items.length; p++) sorted[start[key[items[p]]]++] = items[p];
    items = sorted;
  }
  return items;
};

export const tupleKey = (parts: unknown[]) => JSON.stringify(parts);
export const unkey = (k: string) => {
  const parts: unknown = JSON.parse(k);
  if (!isStrings(parts)) throw new Error(`The chart cannot read the key ${k}.`);
  return parts;
};

export function holds(condition: Condition, others: string[]) {
  switch (condition.kind) {
    case "and":
      for (let j = 0; j < others.length; j++)
        if (!condition.otherKeys[j].has(others[j])) return false;
      return true;
    case "or":
      for (let j = 0; j < others.length; j++)
        if (condition.otherKeys[j].has(others[j])) return true;
      return false;
    case "tuples":
      return condition.otherTuples.has(tupleKey(others));
  }
}

export const ruleKey = (rule: Rule) => tupleKey([rule.kind, rule.name]);

export const hasRule = (rules: Rule[], rule: Rule) => {
  for (const r of rules) if (r.kind === rule.kind && r.name === rule.name) return true;
  return false;
};

const ascending = (keys: string[]) => {
  for (let i = 1; i < keys.length; i++) if (keys[i - 1] > keys[i]) return false;
  return true;
};

const span = (lo: number, hi: number) => (hi > lo ? `${lo}..${hi}` : String(lo));

const setKey = (members: Value[]) => {
  const ints: number[] = [];
  let others: string[] = [];
  for (const m of members)
    if (typeof m === "number") ints.push(m);
    else others.push(key(m));
  for (let i = 1; i < ints.length; i++)
    if (ints[i - 1] >= ints[i]) {
      ints.sort((a, b) => a - b);
      break;
    }
  if (!ascending(others)) others = others.sort(byText);
  let s = "{";
  for (let i = 0; i < ints.length;) {
    let j = i;
    while (j + 1 < ints.length && ints[j + 1] - ints[j] <= 1) j++;
    s += `${s.length > 1 ? "," : ""}${span(ints[i], ints[j])}`;
    i = j + 1;
  }
  for (let i = 0; i < others.length; i++)
    if (!i || others[i] !== others[i - 1]) s += (s.length > 1 ? "," : "") + others[i];
  return s + "}";
};

const functionKey = ({ keys, values }: { keys: Value[]; values: Value[] }) => {
  const order: number[] = [];
  const keyTexts: string[] = [];
  let ints = 0;
  for (let i = 0; i < keys.length; i++) {
    order.push(i);
    keyTexts.push(key(keys[i]));
    if (typeof keys[i] === "number") ints++;
  }
  const rank = (i: number) => (typeof keys[i] === "number" ? (keys[i] as number) : Infinity);
  order.sort((a, b) => rank(a) - rank(b) || byText(keyTexts[a], keyTexts[b]) || a - b);
  let tuple = ints === keys.length;
  for (let i = 0; tuple && i < order.length; i++) tuple = keys[order[i]] === i + 1;
  let s = tuple ? "<<" : "(";
  for (let i = 0, kept = 0; i < order.length; i++) {
    const k = order[i];
    if (i && keyTexts[k] === keyTexts[order[i - 1]]) continue;
    const v = key(values[k]);
    s += tuple ? `${kept++ ? "," : ""}${v}` : `${kept++ ? "@@" : ""}${keyTexts[k]}:>${v}`;
  }
  return s + (tuple ? ">>" : ")");
};

const keys = new WeakMap<object, string>();

export const key = (v: Value): string => {
  switch (typeof v) {
    case "boolean":
      return v ? "TRUE" : "FALSE";
    case "number":
      return String(v);
    case "string":
      return JSON.stringify(v);
  }
  if (v.kind === "model") return v.name;
  if (v.kind === "bigint") return `${v.digits}n`;
  let k = keys.get(v);
  if (k === undefined) {
    k =
      v.kind === "interval"
        ? // Lossy raw endpoints: rounded numbers can collapse distinct
          // intervals, so the raw tokens decide the key when lossy.
          `{${v.lossy && v.rawLo && v.rawHi ? `${v.rawLo}..${v.rawHi}` : v.lo > v.hi ? "" : span(v.lo, v.hi)}}`
        : v.kind === "set"
          ? setKey(v.members)
          : functionKey(v);
    keys.set(v, k);
  }
  return k;
};

export const stateKey = (values: Value[]) => {
  let k = "";
  for (let i = 0; i < values.length; i++) k += (i ? "," : "") + key(values[i]);
  return k;
};

export const memo = <K, V>(make: (k: K) => V, limit = 1 << 16) => {
  const cache = new Map<K, V>();
  return (k: K) => {
    let v = cache.get(k);
    if (v === undefined) {
      if (cache.size >= limit) cache.clear();
      cache.set(k, (v = make(k)));
    }
    return v;
  };
};

export const valuesOf = (vars: Vars, names: string[]) => {
  const values: Value[] = [];
  for (const n of names) values.push(vars[n]);
  return values;
};

export const findTrace = <Id>(
  counterexample: TraceState[],
  names: string[],
  rule: Rule,
  find: Find<Id>,
) => {
  const trace: (TraceState & { values: Value[]; id: Id | undefined })[] = [];
  for (const { action, vars } of counterexample) {
    const values = valuesOf(vars, names);
    trace.push({ action, vars, values, id: find(values) });
  }
  const end = trace.length - 1;
  if (end < 0) throw new Error(`TLC's trace for ${rule.name} has no states.`);
  for (let i = 0; i < end; i++)
    if (trace[i].id === undefined)
      throw new Error(
        `TLC's trace for ${rule.name} has a state before its last that the dump does not list.`,
      );
  return trace;
};

export const findLoop = <Id>({ seq, loop }: Trace, names: string[], find: Find<Id>) => {
  const found: { action: string; id: Id | undefined }[] = [];
  for (const { action, vars } of seq)
    found.push({ action, id: vars && find(valuesOf(vars, names)) });
  return { seq: found, loop };
};

export const pastState = (
  vars: Vars,
  start: boolean,
  marked: Iterable<Rule>,
  excluded: boolean,
): PastState => {
  const breaks: Rule[] = [];
  for (const r of marked) if (!hasRule(breaks, r)) breaks.push(r);
  return { vars, start, breaks, ends: [], past: true, excluded };
};

export const CHECK_DEADLOCK = "CHECK_DEADLOCK";

const deadlockRule = ({ invariants, properties }: Spec): Rule => ({
  kind: "deadlock",
  name:
    invariants.includes("NoDeadlock") || properties.includes("NoDeadlock")
      ? CHECK_DEADLOCK
      : "NoDeadlock",
});

export const hasSection = ({ written }: Spec, ...keys: string[]) => {
  for (const s of written) if (keys.includes(s.key)) return true;
  return false;
};

export const stateRules = (spec: Spec) => {
  const rules: Rule[] = [];
  for (const name of spec.invariants) rules.push({ kind: "invariant", name });
  if (spec.deadlock) rules.push(deadlockRule(spec));
  return rules;
};
