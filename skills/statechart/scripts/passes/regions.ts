import {
  append,
  type Arrow,
  type Bug,
  byText,
  type Chart,
  type ChartState,
  type ChartStep,
  type Condition,
  hasRule,
  holds,
  type Labels,
  loopOf,
  must,
  type Region,
  type Rule,
  ruleKey,
  seqOf,
  tupleKey,
  unkey,
  type View,
  type Walk,
} from "../ir.ts";

const anyRest: Condition = { kind: "and", otherKeys: [] };

type RegionMove = {
  f: number;
  t: number;
  text: string;
  group: number[];
  other: RegionMove | undefined;
};

export function drawRegions(
  { states: tla, index, from, to }: Walk,
  { names, shapes, drawnLabels, group, keys, kinds, sizes, sorted, pathSteps, notes }: Labels,
  order: Int32Array,
  found: Bug[],
  view: View,
): Chart {
  const n = shapes.length;
  const m = drawnLabels.length;
  const R = names.length;
  const lead = new Uint8Array(n);
  const looped = new Uint8Array(n);
  for (const b of found) {
    for (const i of seqOf(b, index).slice(0, b.loop)) lead[i] = 1;
    for (const i of loopOf(b, index)) looped[i] = 1;
  }
  const loop = (j: number) => R === 1 && pathSteps[j] === 1;
  const stays = (j: number) => {
    for (let r = 0; r < R; r++) if (kinds[r][from[j]] !== kinds[r][to[j]]) return false;
    return true;
  };
  let inside = 0;
  for (const j of sorted) if (stays(j) && !loop(j)) inside++;
  const comboOf =
    R === 1
      ? (i: number) => kinds[0][i]
      : (i: number) => {
          let c = "";
          for (let r = 0; r < R; r++) c += (r ? "," : "") + kinds[r][i];
          return c;
        };
  const dirty = new Map<number | string, number>();
  for (const i of order)
    if (tla[i].breaks.length) {
      const c = comboOf(i);
      if (!dirty.has(c)) dirty.set(c, i);
    }
  const clean = new Uint8Array(n);
  if (dirty.size) for (let i = 0; i < n; i++) clean[i] = dirty.has(comboOf(i)) ? 0 : 1;
  else clean.fill(1);
  const regions: Region[] = [];
  const objects: ChartState[][] = [];
  for (const [r, name] of names.entries()) {
    const key = keys[r];
    const kind = kinds[r];
    const states = new Map<string, ChartState>();
    const objectOf = new Array<ChartState>(sizes[r]);
    const keyOf = new Array<string>(sizes[r]);
    const position = new Int32Array(sizes[r]);
    for (const i of order) {
      const s = tla[i];
      let o = objectOf[kind[i]];
      if (!o) {
        o = {
          path: shapes[i][name],
          start: false,
          members: [],
          works: false,
          lead: false,
          repeats: false,
          breaks: [],
          group: undefined,
        };
        objectOf[kind[i]] = o;
        keyOf[kind[i]] = key[i];
        position[kind[i]] = states.size;
        states.set(key[i], o);
      }
      o.start ||= s.start;
      o.works ||= clean[i] === 1;
      o.lead ||= lead[i] === 1;
      o.repeats ||= looped[i] === 1;
      o.members.push(i);
    }
    const parents = new Set<string>();
    for (const s of states.values())
      for (let i = 1; i < s.path.length; i++) parents.add(tupleKey(s.path.slice(0, i)));
    for (const s of states.values()) {
      if (parents.size && parents.has(tupleKey(s.path)))
        throw new Error(
          `The view's state() returned ${s.path.join(" / ")} both as a state and as a parent state${name ? ` in ${name}` : ""}. Give that state a child name of its own.`,
        );
      const rules = new Map<string, Rule>();
      for (const i of s.members) for (const rule of tla[i].breaks) rules.set(ruleKey(rule), rule);
      s.breaks = [];
      for (const rule of [...rules.values()].sort(
        (a, b) => byText(a.name, b.name) || byText(a.kind, b.kind),
      )) {
        let always = true;
        for (const i of s.members) always &&= hasRule(tla[i].breaks, rule);
        s.breaks.push({ rule, always });
      }
      const groups = new Set<unknown>();
      for (const i of s.members) groups.add(group(i));
      s.group = groups.size === 1 ? [...groups][0] : undefined;
    }
    const others: number[] = [];
    for (let o = 0; o < R; o++) if (o !== r) others.push(o);
    const tuple = (i: number) => {
      const t: string[] = [];
      for (const o of others) t.push(keys[o][i]);
      return t;
    };
    const two = others.length === 1;
    const words = (vs: Iterable<string>) => {
      const texts: string[] = [];
      for (const v of vs) texts.push(unkey(v).join(" / "));
      return texts.sort(byText).join(two ? " or " : ", ");
    };
    const is = (o: number, vs: Set<string>) =>
      two ? `when ${words(vs)}` : `${names[o]} is ${vs.size > 1 ? "one of " : ""}${words(vs)}`;
    const isNot = (o: number, vs: string[]) =>
      two
        ? `unless ${words(vs)}`
        : `${names[o]} is ${vs.length > 1 ? "none of" : "not"} ${words(vs)}`;
    const moves: RegionMove[] = [];
    const pairs = new Map<number, RegionMove>();
    const size = sizes[r];
    for (const j of sorted) {
      const f = kind[from[j]];
      const t = kind[to[j]];
      if (f === t && !loop(j)) continue;
      const text = drawnLabels[j];
      const pair = position[f] * size + position[t];
      let move = pairs.get(pair);
      while (move && move.text !== text) move = move.other;
      if (!move) {
        move = { f, t, text, group: [], other: pairs.get(pair) };
        pairs.set(pair, move);
        moves.push(move);
      }
      if (R > 1) move.group.push(j);
    }
    const tuplesAt = new Map<number, number[]>();
    const seenAt = new Map<number, string[][]>();
    if (R > 1) for (const i of order) append(tuplesAt, kind[i], i);
    const arrows: Arrow[] = [];
    for (const move of moves) {
      const fromKey = keyOf[move.f];
      const toKey = keyOf[move.t];
      if (R === 1) {
        arrows.push({
          from: fromKey,
          to: toKey,
          label: move.text,
          condition: anyRest,
          when: undefined,
        });
        continue;
      }
      const ok = new Set<string>();
      for (const j of move.group) ok.add(tupleKey(tuple(from[j])));
      const takes = (t: string[]) => ok.has(tupleKey(t));
      let seen = seenAt.get(move.f);
      if (!seen) {
        seen = [];
        const seenKeys = new Set<string>();
        for (const i of must(tuplesAt, move.f)) {
          const t = tuple(i);
          const k = tupleKey(t);
          if (seenKeys.has(k)) continue;
          seenKeys.add(k);
          seen.push(t);
        }
        seenAt.set(move.f, seen);
      }
      const all: Set<string>[] = [];
      const and: Set<string>[] = [];
      const or: Set<string>[] = [];
      for (let j = 0; j < others.length; j++) {
        const values = new Set<string>();
        const taken = new Set<string>();
        const untaken = new Set<string>();
        for (const t of seen) {
          values.add(t[j]);
          if (takes(t)) taken.add(t[j]);
          else untaken.add(t[j]);
        }
        const only = new Set<string>();
        for (const v of values) if (!untaken.has(v)) only.add(v);
        all.push(values);
        and.push(taken);
        or.push(only);
      }
      const fits = (condition: Condition) => {
        for (const t of seen) if (holds(condition, t) !== takes(t)) return false;
        return true;
      };
      const andHolds: Condition = { kind: "and", otherKeys: and };
      const orHolds: Condition = { kind: "or", otherKeys: or };
      const text = move.text;
      if (fits(andHolds)) {
        const parts: string[] = [];
        for (let j = 0; j < others.length; j++) {
          const no: string[] = [];
          for (const v of all[j]) if (!and[j].has(v)) no.push(v);
          if (no.length)
            parts.push(and[j].size <= no.length ? is(others[j], and[j]) : isNot(others[j], no));
        }
        arrows.push({
          from: fromKey,
          to: toKey,
          label: text,
          condition: andHolds,
          when: parts.length ? (two ? parts[0] : `when ${parts.join(" and ")}`) : undefined,
        });
      } else if (fits(orHolds)) {
        const parts: string[] = [];
        for (let j = 0; j < others.length; j++) if (or[j].size) parts.push(is(others[j], or[j]));
        arrows.push({
          from: fromKey,
          to: toKey,
          label: text,
          condition: orHolds,
          when: `when ${parts.join(" or ")}`,
        });
      } else
        arrows.push({
          from: fromKey,
          to: toKey,
          label: text,
          condition: { kind: "tuples", otherTuples: ok },
        });
    }
    const steps: ChartStep[] = [];
    for (const [k, a] of arrows.entries())
      steps.push({
        from: objectOf[moves[k].f].path,
        to: objectOf[moves[k].t].path,
        label: a.label,
        when: a.label.endsWith("]") ? undefined : a.when,
      });
    regions.push({ name, states: [...states.values()], steps, arrows });
    objects.push(objectOf);
  }
  const hidden: ChartState[][] = [];
  for (const i of dirty.values()) {
    const ps: ChartState[] = [];
    for (let r = 0; r < R; r++) ps.push(objects[r][kinds[r][i]]);
    let works = true;
    for (const s of ps) works &&= s.works;
    if (works) hidden.push(ps);
  }
  for (const ps of hidden) for (const s of ps) s.works = false;
  const paths: string[] = [];
  const loops: string[] = [];
  for (const b of found) {
    if (b.loop !== 0) paths.push(b.rule.name);
    if (b.loop !== undefined) loops.push(b.rule.name);
  }
  return {
    title: view.title,
    regions,
    notes,
    inside,
    quiet: m - sorted.length,
    colors: view.colors ?? {},
    paths,
    loops,
  };
}
