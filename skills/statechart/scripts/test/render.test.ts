import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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

test("the theme in references/render.md colors each class that the charts use", () => {
  assert.ok(classes.size > 0);
  for (const name of classes) assert.match(theme, new RegExp(`\\.pele \\.${name} rect \\{`), name);
});
