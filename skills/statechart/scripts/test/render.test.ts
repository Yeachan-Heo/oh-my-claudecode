import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mermaid as chartText } from "../backends/mermaid.ts";
import type { Graph } from "../ir.ts";
import { walk } from "../passes/reach.ts";
import { project } from "../pipeline.ts";
import { fuzz, type Html, type Mermaid, type Render } from "./labels.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const charts = [];
for (const f of fs.readdirSync(path.join(here, "charts")))
  charts.push(path.join(here, "charts", f));
for (const d of fs.readdirSync(path.join(here, "corpus")))
  charts.push(path.join(here, "corpus", d, "chart.mmd"));
const guide = fs.readFileSync(path.join(here, "../../references/render.md"), "utf8");
const css = guide.match(/```css\n([\s\S]*?)```/);
assert.ok(css, "references/render.md has no css block");
const theme = css[1];
const cache = path.join(
  process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
  "statechart",
);
const install = (name: string, ...packages: string[]) => {
  const dir = path.join(cache, name);
  execFileSync(
    "npm",
    ["install", "--prefix", dir, "--no-audit", "--no-fund", "--save-exact", ...packages],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return createRequire(path.join(dir, "package.json"));
};

let render: Render;
let mermaid: Mermaid;
let html: Html;
before(async () => {
  const pele = install("test-pele-1.9.0", "pele@1.9.0");
  ({ render } = await import(pathToFileURL(pele.resolve("pele")).href));

  const parser = install("test-mermaid-11.16.0", "mermaid@11.16.0", "jsdom@26.1.0");
  const { window } = new (parser("jsdom").JSDOM)("");
  Object.assign(globalThis, { window, document: window.document, DOMParser: window.DOMParser });
  mermaid = (await import(pathToFileURL(parser.resolve("mermaid")).href)).default;
  html = (markup) => {
    const t = window.document.createElement("template");
    t.innerHTML = markup;
    return t.content.textContent ?? "";
  };
});

const classes = new Set<string>();
for (const chart of charts) {
  const name = path.relative(here, chart);
  const text = fs.readFileSync(chart, "utf8");
  const marks = [...text.matchAll(/^ {2}class (\w+) (\w+)$/gm)];
  for (const [, , mark] of marks) classes.add(mark);

  test(`${name} renders in Pele 1.9.0 with each class on its node`, () => {
    const { svg } = render(text);
    assert.match(svg, /^<svg /);
    for (const [, id, mark] of marks)
      assert.match(svg, new RegExp(`class="pele-node[^"]* ${mark}\\b[^"]*" data-id="${id}"`), id);
  });

  test(`${name} parses in mermaid.js, which chat views use`, async () => {
    await mermaid.parse(text);
  });
}

test("random labels and colors keep their text and the chart's shape in Mermaid and Pele", async () => {
  const { drawn, refused, failure } = await fuzz({ seed: 1, charts: 500, render, mermaid, html });
  if (failure) assert.fail(failure);
  assert.ok(drawn > 400 && refused > 20, `${drawn} charts drawn, ${refused} refused`);
});

const pathPoints = (d: string) => {
  const points: number[][] = [];
  let [ax, ay] = [0, 0];
  for (const [, cmd, args] of d.matchAll(/([MLC])([^MLC]*)/g)) {
    const n = args.split(/[ ,]/).filter(Boolean).map(Number);
    const [x, y] = n.slice(-2);
    if (cmd !== "M")
      for (let t = 0; t <= 1; t += 1 / 64) {
        const u = 1 - t;
        points.push(
          cmd === "L"
            ? [ax + (x - ax) * t, ay + (y - ay) * t]
            : [
                u ** 3 * ax + 3 * u * u * t * n[0] + 3 * u * t * t * n[2] + t ** 3 * x,
                u ** 3 * ay + 3 * u * u * t * n[1] + 3 * u * t * t * n[3] + t ** 3 * y,
              ],
        );
      }
    [ax, ay] = [x, y];
  }
  return points;
};

test("an arrow into a parent from its only way in stays out of the parent's title bar in Pele 1.9.0", () => {
  const graph: Graph = { states: new Map(), steps: [] };
  for (const [id, at] of [
    ["ask", "Asking your view for labels"],
    ["flat", "Laying out the chart/Flat"],
    ["parents", "Laying out the chart/Parent states"],
    ["regions", "Laying out the chart/Regions"],
  ])
    graph.states.set(id, { vars: { at }, start: id === "ask", breaks: [] });
  for (const [to, action] of [
    ["flat", "String"],
    ["parents", "Array"],
    ["regions", "Object"],
  ])
    graph.steps.push({ from: "ask", to, action });
  const { chart } = project(graph, walk(graph), { state: (v) => String(v.at).split("/") }, []);
  const { svg } = render(chartText(chart));
  const bars = [
    ...svg.matchAll(
      /<g class="pele-cluster [^"]*" data-id="([^"]*)"><rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)"[^>]*\/><path d="M[\d.]+,([\d.]+)H/g,
    ),
  ].map(([, id, x, y, w, rule]) => ({ id, left: +x, right: +x + +w, top: +y, bottom: +rule }));
  assert.equal(bars.length, 1);
  const crossings: string[] = [];
  for (const [, id, d] of svg.matchAll(
    /<g class="pele-edge pele-transition" data-id="([^"]*)"><path d="([^"]*)"/g,
  ))
    for (const bar of bars)
      if (
        pathPoints(d).some(
          ([x, y]) => x > bar.left && x < bar.right && y > bar.top && y < bar.bottom,
        )
      )
        crossings.push(`${id} crosses the title bar of ${bar.id}`);
  assert.deepEqual(crossings, []);
});

test("the theme in references/render.md colors each class that the charts use", () => {
  assert.ok(classes.size > 0);
  for (const name of classes) assert.match(theme, new RegExp(`\\.pele \\.${name} rect \\{`), name);
});
