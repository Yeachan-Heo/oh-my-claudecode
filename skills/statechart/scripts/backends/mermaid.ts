import { append, byText, type Chart, type ChartState, type Region, tupleKey } from "../ir.ts";

const BLANK = /\p{White_Space}/u;
const SAFE = /^[\p{L}\p{N} !'()+,\-./=?[\]"_|@{}:\\^%<>]$/u;
const HAZARD =
  /:(?=:|$|\S*#)|\\(?=n)|%(?=%)|<(?=[\p{L}/!?])|_(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])_/giu;
const DIRECTION = /(direction)\s+(?=LR|RL|TB|BT)/gi;
const DOUBLE_BRACKET = /\[(?=\[)/g;
const C4 = /C4(?=Container|Component|Dynamic|Deployment)/g;
const UNDRAWN = /[\0\x80-\x9f]/;
const REWRITTEN = ["ﬂ°", "¶ß"];
const MARKER = /(?<=marker-end=)"/g;
const firstOf = new Map<number, number>();
for (const pair of REWRITTEN) {
  const [first, second] = [...pair].map((c) => c.codePointAt(0) ?? 0);
  firstOf.set(second, first);
}
const KEPT = 0;
const BLANKED = 1;
const DROPPED = 2;
const CODED = 3;
const JOINS = 4;
const kindOf = (n: number) => {
  const c = String.fromCodePoint(n);
  const kind =
    c === " "
      ? KEPT
      : BLANK.test(c)
        ? BLANKED
        : UNDRAWN.test(c)
          ? DROPPED
          : SAFE.test(c)
            ? KEPT
            : CODED;
  return firstOf.has(n) ? kind | JOINS : kind;
};
const ASCII = Uint8Array.from({ length: 128 }, (_, n) => kindOf(n));
const wide = new Map<number, number>();
const kindAt = (n: number) => {
  if (n < 128) return ASCII[n];
  let kind = wide.get(n);
  if (kind === undefined) wide.set(n, (kind = kindOf(n)));
  return kind;
};
const encode = (s: string, ref: (n: number) => string) => {
  let out = "";
  let run = 0;
  let last = -1;
  for (let i = 0; i < s.length;) {
    let n = s.charCodeAt(i);
    let width = 1;
    if (n >= 0xd800 && n <= 0xdfff) {
      const low = s.charCodeAt(i + 1);
      if (n <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
        n = 0x10000 + ((n - 0xd800) << 10) + (low - 0xdc00);
        width = 2;
      } else n = 0xfffd;
    }
    let kind = kindAt(n);
    if (kind === DROPPED) {
      out += s.slice(run, i);
      run = i + width;
    } else {
      const joined = kind >= JOINS && firstOf.get(n) === last;
      kind &= ~JOINS;
      if (joined || kind !== KEPT) {
        out += s.slice(run, i);
        if (joined) out += ref(0x2060);
        if (kind === KEPT) run = i;
        else {
          out += kind === BLANKED ? " " : ref(n);
          run = i + width;
        }
      }
      last = n;
    }
    i += width;
  }
  return out + s.slice(run);
};
const code = (s: string, ref: (n: number) => string) =>
  encode(s, ref)
    .replace(MARKER, `${ref(0x2060)}"`)
    .replace(HAZARD, (c) => ref(c.charCodeAt(0)));
const esc = (s: string, quoted = false) => {
  const plain = code(s, (n) => `#${n};`);
  const out = quoted ? plain.replaceAll('"', "#34;") : plain;
  if (!out.trim()) return "#32;";
  const turned = out.replace(DIRECTION, "$1#32;");
  const opened = turned.includes("[[") ? turned.replace(DOUBLE_BRACKET, "#91;") : turned;
  return opened.includes("C4") ? opened.replace(C4, "C#52;") : opened;
};

const or = (names: Iterable<string>) => [...names].sort(byText).join(" or ");

const MARK_STYLES = {
  breaks: "fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834",
  mayBreak: "fill:#fff3e6,stroke:#e8730c,stroke-width:2.5px,color:#b85a06",
};

export function mermaidLines(chart: Chart) {
  let next = 0;
  const marks: string[] = [];
  const used = new Set<string>();
  const rules = { breaks: new Set<string>(), mayBreak: new Set<string>() };
  const region = (r: Region) => {
    const out: string[] = [];
    const topIds = new Map<string, string>();
    const nestedIds = new Map<string, string>();
    const id = (path: string[]) => {
      const top = path.length === 1;
      const named = top ? topIds : nestedIds;
      const k = top ? path[0] : tupleKey(path);
      let s = named.get(k);
      if (s === undefined) named.set(k, (s = `s${next++}`));
      return s;
    };
    const known = new Map<string[], string>();
    const idOf = (path: string[]) => {
      let s = known.get(path);
      if (s === undefined) known.set(path, (s = id(path)));
      return s;
    };
    const tree = (prefix: string[], indent: string, below: ChartState[]) => {
      const heads = new Map<string, ChartState[]>();
      for (const s of below) append(heads, s.path[prefix.length], s);
      for (const [head, under] of heads) {
        const path = [...prefix, head];
        let leaf: ChartState | undefined;
        const inner: ChartState[] = [];
        for (const s of under)
          if (s.path.length > path.length) inner.push(s);
          else leaf = s;
        if (inner.length) {
          out.push(`${indent}state "${esc(head, true)}" as ${id(path)} {`);
          tree(path, indent + "  ", inner);
          out.push(`${indent}}`);
        } else if (leaf) {
          const sid = idOf(leaf.path);
          out.push(`${indent}${sid}: ${esc(head)}`);
          let mark: "breaks" | "mayBreak" | undefined =
            leaf.breaks.length && !leaf.works ? "mayBreak" : undefined;
          if (mark) for (const b of leaf.breaks) if (b.always) mark = "breaks";
          if (mark) for (const b of leaf.breaks) rules[mark].add(b.rule.name);
          const trail = [leaf.lead && "bugPath", leaf.repeats && "repeats"];
          const color = leaf.group === undefined ? undefined : chart.colors[String(leaf.group)];
          for (const cls of [color, mark, ...trail])
            if (cls) {
              used.add(cls);
              marks.push(`  class ${sid} ${cls}`);
            }
        }
      }
    };
    tree([], "  ", r.states);
    for (const s of r.states) if (s.start) out.push(`  [*] --> ${idOf(s.path)}`);
    for (const s of r.steps)
      out.push(
        `  ${idOf(s.from)} --> ${idOf(s.to)}: ${esc(s.label + (s.when ? ` [${s.when}]` : ""))}`,
      );
    return out;
  };
  let body: string[];
  if (chart.regions.length > 1) {
    body = [`  state "At the same time" as all {`];
    for (const [i, r] of chart.regions.entries()) {
      if (i) body.push("    --");
      body.push(`    state "${esc(r.name, true)}" as r${i} {`);
      for (const line of region(r)) body.push(`    ${line}`);
      body.push("    }");
    }
    body.push("  }");
  } else body = region(chart.regions[0]);
  const legend: string[][] = [];
  for (const entry of [
    ...Object.entries(chart.colors),
    [`Breaks ${or(rules.breaks)}`, "breaks"],
    [`Breaks ${or(rules.mayBreak)} in some cases`, "mayBreak"],
    [`Path to the ${or(chart.paths)} bug`, "bugPath"],
    [`Repeats forever, so ${or(chart.loops)} breaks`, "repeats"],
  ])
    if (used.has(entry[1])) legend.push(entry);
  const lines: string[] = [];
  const title = chart.title && code(chart.title, (n) => `ﬂ°°${n}¶ß`).replaceAll("<", "ﬂ°°60¶ß");
  if (title) lines.push("---", `title: ${JSON.stringify(title)}`, "---");
  lines.push("stateDiagram-v2");
  if (chart.regions.length > 1) lines.push("  direction LR");
  if (legend.length) {
    lines.push(`  state "Legend" as legend {`);
    for (const [i, [text]] of legend.entries()) lines.push(`    lg${i}: ${esc(text)}`);
    lines.push("  }");
    for (const [i, [, cls]] of legend.entries()) lines.push(`  class lg${i} ${cls}`);
  }
  for (const line of body) lines.push(line);
  for (const [cls, style] of Object.entries(MARK_STYLES))
    if (used.has(cls)) lines.push(`  classDef ${cls} ${style}`);
  for (const line of marks) lines.push(line);
  return lines;
}

export const mermaid = (chart: Chart) => mermaidLines(chart).join("\n");
