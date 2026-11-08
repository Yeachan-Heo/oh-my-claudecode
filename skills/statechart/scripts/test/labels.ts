import { inspect } from "node:util";
import { mermaid as chartText } from "../backends/mermaid.ts";
import { checkView } from "../frontends/view.ts";
import type { Chart, ChartState, State, Step, View } from "../ir.ts";
import { walk } from "../passes/reach.ts";
import { project } from "../pipeline.ts";

export type Render = (text: string) => { svg: string };

type MermaidNode = {
  id: string;
  label?: string;
  shape?: string;
  parentId?: string;
  isGroup?: boolean;
  dir?: string;
};

export type Mermaid = {
  parse: (text: string) => Promise<unknown>;
  mermaidAPI: {
    getDiagramFromText: (text: string) => Promise<{
      db: {
        getData: () => {
          nodes: MermaidNode[];
          edges: { start: string; end: string; label?: string }[];
          direction?: string;
        };
      };
    }>;
  };
};

export type Html = (markup: string) => string;

type Tools = { render: Render; mermaid: Mermaid; html: Html };

const THEME = ["blue", "orange", "purple", "yellow", "teal", "tan", "pink"];
const WORDS = ["Idle", "Run", "a", "b", "x1", "ok", "Done", "waiting", "on", "off", "p q"];
const SYNTAX = [
  "-->",
  "[*]",
  "{",
  "}",
  "[",
  "]",
  "(",
  ")",
  ":",
  ";",
  "#",
  "%%",
  '"',
  "'",
  "`",
  "|",
  "\\",
  ":::",
  "::: x",
  "--",
  "---",
  "<<fork>>",
  "<<join>>",
  "<<choice>>",
  "[[fork]]",
  "[[join]]",
  "[[choice]]",
  "<br>",
  "<b>x</b>",
  "<a",
  "<a=",
  "=",
  "&amp;",
  "&lt;",
  "&#59;",
  "&quot;",
  "#quot;",
  "#59;",
  "#35;",
  "**",
  "__",
  "*",
  "_",
  "~~",
  "$$",
  "${x}",
  "state",
  "as",
  "note",
  "end",
  "class",
  "classDef",
  "style",
  "click",
  "direction LR",
  "direction TB",
  "Direction rl",
  "direction\tBT",
  "direction  LR",
  "accTitle: x",
  "accDescr: y",
  "title: t",
  "%%{",
  "}%%",
  "%%{init: {}}%%",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Dynamic",
  "C4Deployment",
  "&nbsp;",
  "\\n",
  "---\n",
  "`**b**`",
  "ﬂ°°65¶ß",
  "ﬂ°lt¶ß",
  'marker-end="url(a#',
  "<<",
  ">>",
  "<<a>>",
  "|->",
  ":>",
  "@@",
  "/\\",
  "\\/",
  "..",
  '"A"',
  'x="a"',
  "[a |-> 1]",
  "{1, 2}",
  '"\\n"',
  "&",
  "<",
  ">",
  "@",
  "~",
  "^",
  "$",
  "%",
];
const SPACE = [
  " ",
  "  ",
  "\t",
  "\n",
  "\r",
  "\r\n",
  "\v",
  "\f",
  "\u00a0",
  "\u2028",
  "\u2029",
  "\u0085",
  "\u200b",
  "\ufeff",
  "\u3000",
];
const OTHER = [
  "é",
  "ü",
  "中文",
  "😀",
  "👩‍💻",
  "e\u0301",
  "\u202e",
  "\u200f",
  "ß",
  "Ω",
  "\ud800",
  "\x7f",
  "\x80",
  "\x9f",
  "\x1b",
  "\x00",
];
const BAD_COLORS: unknown[] = [
  "pink\n  s99: Ghost state",
  "blue\r\nclassDef x fill:#f00",
  "teal\r",
  " pink",
  "Pink",
  "red",
  "#00f",
  "breaks",
  "mayBreak",
  "bugPath",
  "repeats",
  "toString",
  "",
  null,
  7,
  ["blue"],
];

const random = (seed: number) => {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return {
    int,
    range: (lo: number, hi: number) => lo + int(hi - lo + 1),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]) => items[int(items.length)],
  };
};

type Random = ReturnType<typeof random>;

const label = (r: Random) => {
  let s = "";
  for (let n = r.range(1, 4); n > 0; n--) {
    const k = r.int(13);
    if (k < 4) s += r.pick(WORDS);
    else if (k < 7) s += r.pick(SYNTAX);
    else if (k < 9) s += r.pick(SPACE);
    else if (k < 11) s += r.pick(OTHER);
    else s += String.fromCharCode(32 + r.int(95));
  }
  return s;
};

const color = (r: Random) => {
  if (r.chance(0.85)) return r.pick(THEME);
  const k = r.int(3);
  if (k === 0) return r.pick(BAD_COLORS);
  if (k === 1) return r.pick(THEME) + r.pick(SPACE) + label(r);
  return label(r);
};

const several = <T>(n: number, make: () => T) => {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(make());
  return out;
};

type Shape =
  | { mode: "flat"; leaf: number[] }
  | { mode: "parents"; leaf: number[]; parents: number[]; parentOf: number[] }
  | { mode: "regions"; regions: number[]; pools: number[][]; values: number[][] };

type Groups =
  | { groups?: undefined; colors?: undefined; groupOf?: undefined }
  | { groups: number[]; colors: unknown[]; groupOf: number[] };

type Case = Shape &
  Groups & { n: number; labels: string[]; actions: number[]; steps: number[][]; title?: number };

function generate(r: Random): Case {
  const labels: string[] = [];
  const slot = () => labels.push(label(r)) - 1;
  const k = r.int(10);
  const mode = k < 4 ? "flat" : k < 7 ? "parents" : "regions";
  const n = r.range(2, 4);
  let shape: Shape;
  if (mode === "regions") {
    shape = {
      mode,
      regions: [slot(), slot()],
      pools: [
        [slot(), slot()],
        [slot(), slot()],
      ],
      values: several(n, () => [r.int(2), r.int(2)]),
    };
  } else {
    const leaf = several(n, slot);
    if (mode === "parents") {
      const parents = r.chance(0.5) ? [slot(), slot()] : [slot()];
      const parentOf = several(n, () => (r.chance(0.75) ? r.int(parents.length) : -1));
      shape = { mode, leaf, parents, parentOf };
    } else shape = { mode, leaf };
  }
  const actions = several(r.range(1, 3), slot);
  const steps = several(r.range(1, 5), () => [r.int(n), r.int(n), r.int(actions.length)]);
  let groups: Groups = {};
  if (r.chance(0.4)) {
    const named = several(r.range(1, 2), slot);
    const colors = several(named.length, () => color(r));
    const groupOf = several(n, () => (r.chance(0.8) ? r.int(named.length) : -1));
    groups = { groups: named, colors, groupOf };
  }
  const title = r.chance(0.3) ? slot() : undefined;
  return { ...shape, ...groups, n, labels, actions, steps, title };
}

type RawView = {
  state: (vars: { k: number }) => unknown;
  step: (action: string) => string;
  group?: (vars: { k: number }) => string | undefined;
  colors?: { [group: string]: unknown };
  title?: string;
};

function build(c: Case, labels: string[]) {
  const states = new Map<string, State>();
  for (let i = 0; i < c.n; i++)
    states.set(String(i), { vars: { k: i }, start: i === 0, breaks: [] });
  const steps: Step[] = [];
  for (const [from, to, a] of c.steps)
    steps.push({ from: String(from), to: String(to), action: `A${a}` });
  const view: RawView = {
    state: ({ k }) => {
      if (c.mode === "regions") {
        const shape: [string, string][] = [];
        for (let j = 0; j < c.regions.length; j++)
          shape.push([labels[c.regions[j]], labels[c.pools[j][c.values[k][j]]]]);
        return Object.fromEntries(shape);
      }
      const leaf = labels[c.leaf[k]];
      return c.mode === "parents" && c.parentOf[k] >= 0
        ? [labels[c.parents[c.parentOf[k]]], leaf]
        : leaf;
    },
    step: (action) => labels[c.actions[Number(action.slice(1))]],
  };
  if (c.groups) {
    view.group = ({ k }) => (c.groupOf[k] < 0 ? undefined : labels[c.groups[c.groupOf[k]]]);
    const colors: [string, unknown][] = [];
    for (let j = 0; j < c.groups.length; j++) colors.push([labels[c.groups[j]], c.colors[j]]);
    view.colors = Object.fromEntries(colors);
  }
  if (c.title !== undefined) view.title = labels[c.title];
  return { graph: { states, steps }, view };
}

const visible = (s: string) =>
  s
    .toWellFormed()
    .replace(/(?![\t-\r\x85])[\p{Cc}\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, "")
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
const wrapped = (s: string) => visible(s).replaceAll(" ", "");
const titled = (want: Want) => /[^\0\x80-\x84\x86-\x9f]/.test(want.title ?? "");
const NAMED: { [name: string]: string } = {
  quot: '"',
  lt: "<",
  gt: ">",
  amp: "&",
  apos: "'",
  nbsp: "\u00a0",
};
const WINDOWS_1252 = "€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f\x90‘’“”•–—˜™š›œ\x9džŸ";
const fromRef = (n: number) => {
  if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "\ufffd";
  if (n >= 0x80 && n <= 0x9f) return WINDOWS_1252[n - 0x80];
  return String.fromCodePoint(n);
};
const fromMermaid = (s: string) =>
  s.replace(/ﬂ°°(\d+)¶ß|ﬂ°(\w+)¶ß/g, (_, d, n) =>
    d ? fromRef(Number(d)) : (NAMED[n] ?? `&${n};`),
  );
const decoded = (s: string) =>
  s
    .replace(/ﬂ°°/g, "&#")
    .replace(/ﬂ°/g, "&")
    .replace(/¶ß/g, ";");
const MARKER_END = /marker-end="url\([\d+./:=?A-Za-z-]*?#/g;
const rewritten = (s: string) =>
  /ﬂ°|¶ß/.test(s) || s.replace(MARKER_END, 'marker-end="url(#') !== s;
const fromSvg = (s: string) =>
  s
    .replace(/<\/tspan>\s*<tspan[^>]*>/g, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => fromRef(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromRef(Number(d)))
    .replace(/&(quot|lt|gt|apos|nbsp);/g, (_, n) => NAMED[n])
    .replace(/&amp;/g, "&");

type Node = { text: string; parent: string | null; group: boolean };

type Want = {
  nodes: Map<string, Node>;
  edges: string[][];
  direction: string;
  title: string | undefined;
};

function expected(chart: Chart): Want {
  const nodes = new Map<string, Node>();
  const edges: string[][] = [];
  const ids = new Map<string, string>();
  const id = (region: string, path: string[]) => {
    const key = JSON.stringify([region, path]);
    const found = ids.get(key) ?? `s${ids.size}`;
    ids.set(key, found);
    return found;
  };
  const multi = chart.regions.length > 1;
  const used = new Set<string>();
  if (multi) nodes.set("all", { text: "At the same time", parent: null, group: true });
  for (let i = 0; i < chart.regions.length; i++) {
    const region = chart.regions[i];
    const wrap = multi ? `r${i}` : null;
    if (wrap) nodes.set(wrap, { text: region.name, parent: "all", group: true });
    const tree = (prefix: string[], parent: string | null, below: ChartState[]) => {
      const heads = new Map<string, ChartState[]>();
      for (const s of below) {
        const head = s.path[prefix.length];
        heads.set(head, [...(heads.get(head) ?? []), s]);
      }
      for (const [head, under] of heads) {
        const path = [...prefix, head];
        const inner: ChartState[] = [];
        let leaf: ChartState | undefined;
        for (const s of under)
          if (s.path.length > path.length) inner.push(s);
          else leaf = s;
        const node = id(region.name, path);
        nodes.set(node, { text: head, parent, group: inner.length > 0 });
        if (inner.length) tree(path, node, inner);
        else if (leaf?.group !== undefined) used.add(chart.colors[String(leaf.group)]);
      }
    };
    tree([], wrap, region.states);
    for (const s of region.states)
      if (s.start) edges.push([`${wrap ?? "root"}_start`, id(region.name, s.path), ""]);
    for (const s of region.steps)
      edges.push([
        id(region.name, s.from),
        id(region.name, s.to),
        s.label + (s.when ? ` [${s.when}]` : ""),
      ]);
  }
  let legend = 0;
  for (const [text, cls] of Object.entries(chart.colors))
    if (used.has(cls)) nodes.set(`lg${legend++}`, { text, parent: "legend", group: false });
  if (legend) nodes.set("legend", { text: "Legend", parent: null, group: true });
  return { nodes, edges, direction: multi ? "LR" : "TB", title: chart.title };
}

const edgeKeys = (edges: string[][], withLabels: boolean) => {
  const keys: string[] = [];
  for (const [from, to, text] of edges)
    keys.push(withLabels ? `${from} ${to} ${visible(text)}` : `${from} ${to}`);
  return keys.sort().join("\n");
};

async function readMermaid(text: string, want: Want, { mermaid, html }: Tools, problems: string[]) {
  let data;
  try {
    data = (await mermaid.mermaidAPI.getDiagramFromText(text)).db.getData();
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    problems.push(`mermaid-refuses: ${e.message.split("\n")[0]}`);
    return;
  }
  const byId = new Map<string | undefined, MermaidNode>();
  for (const n of data.nodes) byId.set(n.id, n);
  let count = 0;
  for (const n of data.nodes) {
    if (n.shape === "divider" || n.shape === "stateStart" || n.shape === "stateEnd") continue;
    count++;
    let parent = byId.get(n.parentId);
    while (parent?.shape === "divider") parent = byId.get(parent.parentId);
    const w = want.nodes.get(n.id);
    const shown = fromMermaid(n.label ?? "");
    if (!w || (parent?.id ?? null) !== w.parent || Boolean(n.isGroup) !== w.group)
      problems.push(`mermaid-nodes: Mermaid draws ${n.id} where the chart has no such node`);
    else if (rewritten(shown))
      problems.push(
        `mermaid-text: Mermaid's SVG cleanup rewrites ${n.id}'s ${JSON.stringify(shown)}`,
      );
    else if (visible(html(decoded(n.label ?? ""))) !== visible(w.text))
      problems.push(
        `mermaid-text: ${n.id} shows ${JSON.stringify(html(decoded(n.label ?? "")))} for ${JSON.stringify(w.text)}`,
      );
    if (n.isGroup && n.dir && n.dir !== "TB")
      problems.push(`mermaid-direction: ${n.id} runs ${n.dir}`);
  }
  if (count !== want.nodes.size)
    problems.push(`mermaid-nodes: ${count} nodes for ${want.nodes.size}`);
  if ((data.direction ?? "TB") !== want.direction)
    problems.push(`mermaid-direction: the chart runs ${data.direction}`);
  const head = text.match(/^---\ntitle: (.*)\n---\n/);
  const raw = head ? String(JSON.parse(head[1])) : undefined;
  const title = raw === undefined ? undefined : fromMermaid(raw);
  if ((title !== undefined) !== titled(want))
    problems.push(`mermaid-title: Mermaid draws a title for ${JSON.stringify(want.title)}`);
  else if (raw?.includes("<"))
    problems.push(
      `mermaid-title: Mermaid's sanitizer reads the < in ${JSON.stringify(raw)} as a tag`,
    );
  else if (title?.includes("\0"))
    problems.push(`mermaid-title: a browser draws the NUL in ${JSON.stringify(title)} as U+FFFD`);
  else if (title !== undefined && visible(title) !== visible(want.title ?? ""))
    problems.push(
      `mermaid-text: the title shows ${JSON.stringify(title)} for ${JSON.stringify(want.title)}`,
    );
  const got: string[][] = [];
  const shown: string[][] = [];
  for (const e of data.edges) {
    got.push([e.start, e.end, fromMermaid(e.label ?? "")]);
    shown.push([e.start, e.end, html(decoded(e.label ?? ""))]);
  }
  if (edgeKeys(got, false) !== edgeKeys(want.edges, false))
    problems.push("mermaid-edges: the arrows join other states");
  else if (edgeKeys(shown, true) !== edgeKeys(want.edges, true))
    problems.push("mermaid-text: an arrow shows other text");
  for (const [from, to, text] of got)
    if (rewritten(text))
      problems.push(
        `mermaid-text: Mermaid's SVG cleanup rewrites the arrow from ${from} to ${to}'s ${JSON.stringify(text)}`,
      );
}

function readPele(text: string, want: Want, render: Render, problems: string[]) {
  let svg: string;
  try {
    ({ svg } = render(text));
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    problems.push(`pele-refuses: ${e.message.split("\n")[0]}`);
    return;
  }
  const drawn = new Map<string, string>();
  for (const m of svg.matchAll(
    /<g class="pele-(?:node|cluster) ([^"]*)" data-id="([^"]*)"[^>]*>([\s\S]*?)<\/g>/g,
  )) {
    if (/state-(start|end)/.test(m[1])) continue;
    const t = m[3].match(/<text[^>]*>([\s\S]*?)<\/text>/);
    drawn.set(m[2], t ? fromSvg(t[1]) : "");
  }
  if (drawn.size !== want.nodes.size)
    problems.push(`pele-nodes: ${drawn.size} nodes for ${want.nodes.size}`);
  for (const [node, w] of want.nodes) {
    const shown = drawn.get(node);
    if (shown === undefined) problems.push(`pele-nodes: Pele draws no ${node}`);
    else if (wrapped(shown) !== wrapped(w.text))
      problems.push(
        `pele-text: ${node} shows ${JSON.stringify(shown)} for ${JSON.stringify(w.text)}`,
      );
  }
  let arrows = 0;
  for (const _ of svg.matchAll(/<g class="pele-edge pele-transition"/g)) arrows++;
  if (arrows !== want.edges.length)
    problems.push(`pele-edges: ${arrows} arrows for ${want.edges.length}`);
  for (const m of svg.matchAll(
    /<g class="pele-edge-label" data-id="edge(\d+)"[^>]*>[\s\S]*?<text[^>]*>([\s\S]*?)<\/text>/g,
  )) {
    const w = want.edges[Number(m[1])];
    if (!w) problems.push(`pele-edges: Pele labels edge${m[1]}, which the chart does not have`);
    else if (wrapped(fromSvg(m[2])) !== wrapped(w[2]))
      problems.push(
        `pele-text: edge${m[1]} shows ${JSON.stringify(fromSvg(m[2]))} for ${JSON.stringify(w[2])}`,
      );
  }
  const title = svg.match(/<text class="pele-title"[^>]*>([\s\S]*?)<\/text>/);
  if (Boolean(title) !== titled(want))
    problems.push(`pele-title: Pele draws a title for ${JSON.stringify(want.title)}`);
  else if (title && wrapped(fromSvg(title[1])) !== wrapped(want.title ?? ""))
    problems.push(
      `pele-text: the title shows ${JSON.stringify(fromSvg(title[1]))} for ${JSON.stringify(want.title)}`,
    );
}

type Checked = { refused?: true; text?: string; problems: string[] };

async function check(c: Case, labels: string[], tools: Tools): Promise<Checked> {
  const { graph, view } = build(c, labels);
  let refuse = false;
  for (const [, value] of Object.entries(view.colors ?? {}))
    if (typeof value !== "string" || !THEME.includes(value)) refuse = true;
  let checked: View;
  try {
    checked = checkView(view, inspect);
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    if (refuse && /^The view's colors give /.test(e.message))
      return { refused: true, problems: [] };
    return { problems: [`skill-throws: ${e.message}`] };
  }
  if (refuse) return { problems: ["colors: checkView accepts a color that is not in the theme"] };
  let chart: Chart;
  let text: string;
  try {
    ({ chart } = project(graph, walk(graph), checked, []));
    text = chartText(chart);
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    if (/^The view's (state|step)\(\) returned /.test(e.message))
      return { refused: true, problems: [] };
    return { problems: [`skill-throws: ${e.constructor.name}: ${e.message}`] };
  }
  const want = expected(chart);
  const problems: string[] = [];
  await readMermaid(text, want, tools, problems);
  readPele(text, want, tools.render, problems);
  return { text, problems };
}

const kind = (problem: string) => problem.slice(0, problem.indexOf(":"));

export async function fuzz({
  seed,
  charts,
  ...tools
}: { seed: number; charts: number } & Tools): Promise<{
  drawn: number;
  refused: number;
  failure?: string;
}> {
  await tools.mermaid.parse("stateDiagram-v2\n  s0: a");
  const r = random(seed);
  let drawn = 0;
  let refused = 0;
  for (let i = 1; i <= charts; i++) {
    const c = generate(r);
    const result = await check(c, c.labels, tools);
    if (result.refused) refused++;
    else drawn++;
    if (!result.problems.length) continue;
    const first = kind(result.problems[0]);
    let labels = c.labels;
    for (let j = 0; j < labels.length; j++) {
      const plain = labels.with(j, `n${j}`);
      const again = await check(c, plain, tools);
      let same = false;
      for (const p of again.problems) if (kind(p) === first) same = true;
      if (same) labels = plain;
    }
    const kept = [];
    for (let j = 0; j < labels.length; j++) if (labels[j] !== `n${j}`) kept.push(labels[j]);
    const last = await check(c, labels, tools);
    const colors = c.colors ? ` and the colors ${JSON.stringify(c.colors)}` : "";
    return {
      drawn,
      refused,
      failure: [
        `Chart ${i} of seed ${seed} goes wrong with the labels ${JSON.stringify(kept)}${colors}:`,
        ...last.problems,
        "",
        last.text ?? "",
      ].join("\n"),
    };
  }
  return { drawn, refused };
}
