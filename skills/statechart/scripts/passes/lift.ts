import {
  append,
  type Chart,
  type ChartState,
  type ChartStep,
  must,
  type Region,
  tupleKey,
  unkey,
} from "../ir.ts";

export function liftToParents(states: ChartState[], steps: ChartStep[]) {
  const depths = new Map<string, number>();
  const leaves = new Map<string, number>();
  for (const s of states.values())
    for (let i = 1; i < s.path.length; i++) {
      const prefix = tupleKey(s.path.slice(0, i));
      depths.set(prefix, i);
      leaves.set(prefix, (leaves.get(prefix) ?? 0) + 1);
    }
  if (!depths.size) return steps;
  const leaving = new Map<string, ChartStep[]>();
  for (const s of steps) {
    let same = 0;
    while (same < s.from.length && s.from[same] === s.to[same]) same++;
    for (let i = 1; i < s.from.length; i++) {
      if (i <= same && i < s.to.length) continue;
      const prefix = tupleKey(s.from.slice(0, i));
      if (depths.has(prefix)) append(leaving, prefix, s);
    }
  }
  const removed = new Set<ChartStep>();
  const lifted: ChartStep[] = [];
  for (const [prefix] of [...depths].sort((a, b) => a[1] - b[1])) {
    const groups = new Map<string, ChartStep[]>();
    for (const s of leaving.get(prefix) ?? [])
      if (!removed.has(s)) append(groups, tupleKey([s.label, s.when, s.to]), s);
    const under = must(leaves, prefix);
    for (const group of groups.values()) {
      if (under < 2 || group.length < under) continue;
      for (const s of group) removed.add(s);
      lifted.push({ ...group[0], from: unkey(prefix) });
    }
  }
  const kept: ChartStep[] = [];
  for (const s of steps) if (!removed.has(s)) kept.push(s);
  for (const s of lifted) kept.push(s);
  return kept;
}

export function lift(chart: Chart): Chart {
  const regions: Region[] = [];
  for (const r of chart.regions) {
    const known = new Map<string[], number>();
    for (const s of r.states) known.set(s.path, known.size);
    let numbers: Map<string, number> | undefined;
    const pathIndex = (path: string[]) => {
      let i = known.get(path);
      if (i !== undefined) return i;
      if (!numbers) {
        numbers = new Map();
        for (const s of r.states) numbers.set(tupleKey(s.path), numbers.size);
      }
      const k = tupleKey(path);
      i = numbers.get(k);
      if (i === undefined) numbers.set(k, (i = numbers.size));
      known.set(path, i);
      return i;
    };
    const merged = new Map<number | string, ChartStep>();
    for (const s of liftToParents(r.states, r.steps)) {
      const f = pathIndex(s.from);
      const t = pathIndex(s.to);
      const k =
        s.when === undefined && f < 2 ** 26 && t < 2 ** 26
          ? f * 2 ** 26 + t
          : `${f},${t}:${s.when}`;
      const prior = merged.get(k);
      if (prior) prior.label += ` or ${s.label}`;
      else merged.set(k, { ...s });
    }
    regions.push({ ...r, steps: [...merged.values()] });
  }
  return { ...chart, regions };
}
