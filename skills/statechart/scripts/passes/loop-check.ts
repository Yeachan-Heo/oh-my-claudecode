import {
  append,
  type Arrow,
  type Bug,
  type Chart,
  holds,
  type Labels,
  loopOf,
  must,
  tupleKey,
  unkey,
  type Walk,
} from "../ir.ts";

export function loopCheck(
  { regions, loops }: Chart,
  { names, keys, drawnLabels, sorted }: Labels,
  { index, from, to }: Walk,
  found: Bug[],
) {
  const R = names.length;
  const combo = (i: number) => {
    const parts: string[] = [];
    for (let r = 0; r < R; r++) parts.push(keys[r][i]);
    return tupleKey(parts);
  };
  const stepsFrom = new Map<number, number[]>();
  const arrowsFrom: Map<string, Arrow[]>[] = [];
  if (loops.length) {
    for (const j of sorted) append(stepsFrom, from[j], j);
    for (const { arrows } of regions) {
      const out = new Map<string, Arrow[]>();
      for (const a of arrows) append(out, a.from, a);
      arrowsFrom.push(out);
    }
  }
  for (const b of found) {
    if (b.loop === undefined) continue;
    const inLoop = new Set<string>();
    const twinsOf = new Map<string, number[]>();
    for (const i of loopOf(b, index)) {
      inLoop.add(combo(i));
      append(twinsOf, combo(i), i);
    }
    for (const i of loopOf(b, index)) {
      const twins = must(twinsOf, combo(i));
      for (const [r, name] of names.entries()) {
        const takes = (a: Arrow) => {
          for (const s of twins)
            for (const j of stepsFrom.get(s) ?? [])
              if (drawnLabels[j] === a.label && keys[r][to[j]] === a.to) return true;
          return false;
        };
        const rest: string[] = [];
        for (let o = 0; o < R; o++) if (o !== r) rest.push(keys[o][i]);
        for (const a of arrowsFrom[r].get(keys[r][i]) ?? []) {
          if (!holds(a.condition, rest)) continue;
          const next: string[] = [];
          for (let o = 0; o < R; o++) next.push(o === r ? a.to : keys[o][i]);
          if (!inLoop.has(tupleKey(next)) && !takes(a))
            throw new Error(
              `The chart draws the step ${a.label} out of ${name ? `${name} ` : ""}${unkey(a.from).join(" / ")}, but the ${b.rule.name} loop cannot take it there. Show in a label what stops it.`,
            );
        }
      }
    }
  }
}
