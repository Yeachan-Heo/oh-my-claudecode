import {
  type Answers,
  type Bug,
  type Graph,
  type Hidden,
  isRecord,
  key,
  type Labels,
  list,
  loopOf,
  must,
  type Rule,
  type Shape,
  sortBy,
  stateText,
  type Step,
  type Story,
  tupleKey,
  type Vars,
  type View,
  type Walk,
} from "../ir.ts";

const isLabel = (l: unknown): l is string =>
  typeof l === "string" && l !== "" && !/\bundefined\b|\bNaN\b|\[object Object\]/.test(l);

const shapeOf = (shape: unknown, vars: Vars): Shape => {
  function fail(): never {
    throw new Error(
      `The view's state() returned ${JSON.stringify(shape) ?? "undefined"} for the state ${stateText(vars)}. Return a string, an array of strings, or an object of those.`,
    );
  }
  const path = (p: unknown) => {
    const labels: string[] = [];
    for (const l of [p].flat()) {
      if (!isLabel(l)) fail();
      labels.push(l);
    }
    if (!labels.length) fail();
    return labels;
  };
  const regions: [string, unknown][] = isRecord(shape) ? Object.entries(shape) : [["", shape]];
  const pairs: [string, string[]][] = [];
  for (const [k, v] of regions) pairs.push([k, path(v)]);
  return pairs.length ? Object.fromEntries(pairs) : fail();
};

const stepOf = (view: View) => (action: string, from: Vars, to: Vars) => {
  const label = (view.step ?? ((a: string) => a))(action, from, to);
  if (label === null || isLabel(label)) return label;
  throw new Error(
    `The view's step() returned ${JSON.stringify(label) ?? "undefined"} for the step ${action}.`,
  );
};

function unlabeled(
  action: string,
  before: Vars,
  after: Vars,
  bug: { rule: Rule; loop?: number },
): never {
  const changed: string[] = [];
  for (const k of Object.keys(after)) if (key(before[k]) !== key(after[k])) changed.push(k);
  throw new Error(
    `The view's step() returned null for the step ${action} that changes ${changed.join(", ") || "nothing"}. It is on the path to the ${bug.rule.name} bug${bug.loop === undefined ? "" : " or leaves its loop"}, so label it.`,
  );
}

export function ask(graph: Graph, { states: tla, nameOf, from, to }: Walk, view: View): Answers {
  const n = nameOf.length;
  const m = from.length;
  const state = view.state;
  const shapes = new Array<Shape>(n);
  for (let i = 0; i < n; i++)
    shapes[i] = shapeOf(state ? state(tla[i].vars) : nameOf[i], tla[i].vars);
  const names = Object.keys(shapes[0] ?? { "": [] });
  const regionsKey = tupleKey(names);
  for (let i = 0; i < n; i++)
    if (tupleKey(Object.keys(shapes[i])) !== regionsKey)
      throw new Error(
        `The view's state() returned the regions ${names.join(", ")} for one state and ${Object.keys(shapes[i]).join(", ")} for the state ${stateText(tla[i].vars)}. Return the same regions for every state.`,
      );
  const step = stepOf(view);
  const labels = new Array<string | Hidden>(m);
  for (let j = 0; j < m; j++)
    labels[j] = step(graph.steps[j].action, tla[from[j]].vars, tla[to[j]].vars);
  const groups = new Array<unknown>(n);
  const asked = new Uint8Array(n);
  const group = (i: number) => {
    if (view.group && !asked[i]) {
      groups[i] = view.group(tla[i].vars);
      asked[i] = 1;
    }
    return groups[i];
  };
  return { names, shapes, labels, group };
}

export function asParents(
  { states: tla }: Walk,
  { names, shapes, labels, group }: Answers,
): Answers {
  const parents = new Array<Shape>(shapes.length);
  for (let i = 0; i < shapes.length; i++) {
    const path: string[] = [];
    for (const n of names) for (const p of shapes[i][n]) path.push(`${n} ${p}`);
    parents[i] = shapeOf(path, tla[i].vars);
  }
  return { names: [""], shapes: parents, labels, group };
}

export function labelGraph(
  graph: Graph,
  { index, from, to, action }: Walk,
  answers: Answers,
  rank: Int32Array,
  found: Bug[],
): Labels {
  const { names, shapes, labels: stepLabels } = answers;
  const n = shapes.length;
  const m = stepLabels.length;
  const onPath = new Set<Step>();
  for (const b of found) for (const p of b.path) onPath.add(p.step);
  const pathStepIndex = new Map<Step, number>();
  if (onPath.size)
    for (let j = 0; j < m; j++)
      if (onPath.has(graph.steps[j])) pathStepIndex.set(graph.steps[j], j);
  const R = names.length;
  const keys: string[][] = [];
  const kinds: Int32Array[] = [];
  const sizes: number[] = [];
  for (const name of names) {
    const key = new Array<string>(n);
    const kind = new Int32Array(n);
    const tops = new Map<string, number>();
    const nested = new Map<string, number>();
    const keyOf: string[] = [];
    for (let i = 0; i < n; i++) {
      const path = shapes[i][name];
      const top = path.length === 1;
      const seen = top ? tops : nested;
      const k = top ? path[0] : tupleKey(path);
      let c = seen.get(k);
      if (c === undefined) {
        seen.set(k, (c = keyOf.length));
        keyOf.push(top ? tupleKey(path) : k);
      }
      key[i] = keyOf[c];
      kind[i] = c;
    }
    keys.push(key);
    kinds.push(kind);
    sizes.push(keyOf.length);
  }
  for (const b of found) {
    let t: Step | undefined;
    for (const p of b.path)
      if (stepLabels[must(pathStepIndex, p.step)] === null) {
        t = p.step;
        break;
      }
    if (!t) {
      const inLoop = loopOf(b, index);
      if (inLoop.size)
        for (let j = 0; j < m; j++)
          if (inLoop.has(from[j]) && !inLoop.has(to[j]) && stepLabels[j] === null) {
            t = graph.steps[j];
            break;
          }
    }
    if (t) unlabeled(t.action, must(graph.states, t.from).vars, must(graph.states, t.to).vars, b);
  }
  const drawn: number[] = [];
  const drawnLabels = new Array<string>(m);
  for (let j = 0; j < m; j++) {
    const label = stepLabels[j];
    if (label === null) continue;
    drawn.push(j);
    drawnLabels[j] = label;
  }
  const fromRank = new Int32Array(m);
  const toRank = new Int32Array(m);
  for (let j = 0; j < m; j++) {
    fromRank[j] = rank[from[j]];
    toRank[j] = rank[to[j]];
  }
  const sorted = sortBy(Int32Array.from(drawn), [fromRank, toRank, action]);
  const pathSteps = new Uint8Array(m);
  for (const j of pathStepIndex.values()) pathSteps[j] = 1;
  const byLabel = new Map<string, { changed: Uint8Array; sets: Set<string> }>();
  if (R > 1)
    for (const j of sorted) {
      let entry = byLabel.get(drawnLabels[j]);
      if (!entry)
        byLabel.set(drawnLabels[j], (entry = { changed: new Uint8Array(R), sets: new Set() }));
      const changed: string[] = [];
      for (let r = 0; r < R; r++)
        if (kinds[r][from[j]] !== kinds[r][to[j]]) {
          changed.push(names[r]);
          entry.changed[r] = 1;
        }
      if (changed.length > 1) entry.sets.add(list(changed));
    }
  const together = new Set<string>();
  for (const [text, { sets }] of byLabel) if (sets.size) together.add(text);
  const notes: string[] = [];
  for (const [text, entry] of byLabel) {
    const changed: string[] = [];
    for (let r = 0; r < R; r++) if (entry.changed[r]) changed.push(names[r]);
    if (changed.length < 2) continue;
    if (!together.has(text)) {
      notes.push(`The step ${text} changes only one of ${list(changed)} at a time.`);
      continue;
    }
    const sets = [...entry.sets];
    notes.push(
      `The step ${text} changes ${sets.length > 1 ? `${sets.join(", or ")},` : sets[0]} at the same time.`,
    );
  }
  return {
    ...answers,
    drawnLabels,
    keys,
    kinds,
    sizes,
    sorted,
    pathStepIndex,
    pathSteps,
    together,
    notes,
  };
}

type Told<Id> = { rule: Rule; start: Id; path: { action: string; state: Id }[]; loop?: number };

function tell<Id, B extends Told<Id>>(
  states: ReadonlyMap<Id, { vars: Vars }>,
  found: B[],
  shapeAt: (id: Id) => Shape,
  labelAt: (bug: B, k: number, from: Id) => string | Hidden,
) {
  const vars = (id: Id) => must(states, id).vars;
  const stories = new Map<B, Story>();
  for (const bug of found) {
    const story: Story = [{ state: shapeAt(bug.start) }];
    let from: Id = bug.start;
    for (const [k, p] of bug.path.entries()) {
      const step = labelAt(bug, k, from);
      if (step === null) unlabeled(p.action, vars(from), vars(p.state), bug);
      story.push({ step, state: shapeAt(p.state) });
      from = p.state;
    }
    stories.set(bug, story);
  }
  return stories;
}

export const storiesOf = (
  graph: Graph,
  found: Bug[],
  { index }: Walk,
  { shapes, drawnLabels, pathStepIndex }: Labels,
) =>
  tell(
    graph.states,
    found,
    (id) => shapes[must(index, id)],
    (bug, k) => drawnLabels[must(pathStepIndex, bug.path[k].step)],
  );
