import {
  type Bug,
  byText,
  count,
  defaultState,
  type Graph,
  must,
  type PathStep,
  type Rule,
  ruleKey,
  sortBy,
  type State,
  type Walk,
} from "../ir.ts";

export function walk(graph: Graph): Walk {
  const ids: string[] = [];
  const states: State[] = [];
  const nameOf: string[] = [];
  const starts: number[] = [];
  const unique = new Set<string>();
  for (const [id, s] of graph.states) {
    const name = defaultState(s.vars);
    if (s.start) starts.push(ids.length);
    ids.push(id);
    states.push(s);
    nameOf.push(name);
    unique.add(name);
  }
  const names = Array.from(unique).sort(byText);
  const rankOf = new Map<string, number>();
  for (let i = 0; i < names.length; i++) rankOf.set(names[i], i);
  const n = ids.length;
  const index = new Map<string, number>();
  const nameRank = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    index.set(ids[i], i);
    nameRank[i] = must(rankOf, nameOf[i]);
  }
  const m = graph.steps.length;
  const from = new Int32Array(m);
  const to = new Int32Array(m);
  const action = new Int32Array(m);
  const actions = new Map<string, number>();
  for (let j = 0; j < m; j++) {
    const t = graph.steps[j];
    from[j] = must(index, t.from);
    to[j] = must(index, t.to);
    let a = actions.get(t.action);
    if (a === undefined) actions.set(t.action, (a = actions.size));
    action[j] = a;
  }
  const actionRank = new Int32Array(actions.size);
  for (const [i, a] of [...actions.keys()].sort(byText).entries()) actionRank[must(actions, a)] = i;
  const toName = new Int32Array(m);
  for (let j = 0; j < m; j++) {
    action[j] = actionRank[action[j]];
    toName[j] = nameRank[to[j]];
  }
  const first = new Int32Array(n + 1);
  for (let j = 0; j < m; j++) first[from[j] + 1]++;
  for (let i = 0; i < n; i++) first[i + 1] += first[i];
  const fill = first.slice(0, n);
  const next = new Int32Array(m);
  for (const j of sortBy(count(m), [action, toName])) next[fill[from[j]]++] = j;
  starts.sort((a, b) => nameRank[a] - nameRank[b]);
  const depth = new Int32Array(n).fill(-1);
  const via = new Int32Array(n).fill(-1);
  const reached = new Int32Array(n);
  let size = 0;
  for (const s of starts) {
    depth[s] = 0;
    reached[size++] = s;
  }
  for (let q = 0; q < size; q++) {
    const s = reached[q];
    for (let e = first[s]; e < first[s + 1]; e++) {
      const t = to[next[e]];
      if (depth[t] >= 0) continue;
      depth[t] = depth[s] + 1;
      via[t] = next[e];
      reached[size++] = t;
    }
  }
  return {
    ids,
    states,
    index,
    nameOf,
    nameRank,
    from,
    to,
    action,
    depth,
    via,
    reached: reached.subarray(0, size),
    starts,
  };
}

export function drawOrder({ depth, nameRank }: Walk) {
  const n = depth.length;
  let deepest = 0;
  for (let i = 0; i < n; i++) if (depth[i] > deepest) deepest = depth[i];
  const level = new Int32Array(n);
  for (let i = 0; i < n; i++) level[i] = depth[i] < 0 ? deepest + 1 : depth[i];
  const order = sortBy(count(n), [level, nameRank]);
  const rank = new Int32Array(n);
  for (let p = 0; p < n; p++) rank[order[p]] = p;
  return { order, rank };
}

export function bugs(graph: Graph, { ids, from, via, reached }: Walk = walk(graph)) {
  const ends = new Map<string, string>();
  for (const [id, s] of graph.states) for (const rule of s.ends ?? []) ends.set(ruleKey(rule), id);
  const first = new Map<string, { rule: Rule; i: number }>();
  for (const i of reached) {
    const s = must(graph.states, ids[i]);
    for (const rule of s.past ? s.ends : s.breaks) {
      const k = ruleKey(rule);
      if (!first.has(k) && (ends.get(k) ?? ids[i]) === ids[i]) first.set(k, { rule, i });
    }
  }
  const found: Bug[] = [];
  for (const { rule, i } of first.values()) {
    const path: PathStep[] = [];
    let start = i;
    for (let j: number; (j = via[start]) >= 0; start = from[j]) {
      const step = graph.steps[j];
      path.unshift({ action: step.action, state: step.to, step });
    }
    found.push({ rule, start: ids[start], path });
  }
  return found;
}
