import { mermaidLines } from "./backends/mermaid.ts";
import { plainText } from "./backends/plain-text.ts";
import { report } from "./backends/report.ts";
import {
  type Answers,
  type Bug,
  type Chart,
  type CheckedView,
  type CheckResult,
  type Graph,
  PART,
  ruleKey,
  type Story,
  type View,
  type Walk,
} from "./ir.ts";
import { asParents, ask, labelGraph, storiesOf } from "./passes/label.ts";
import { lift } from "./passes/lift.ts";
import { loopCheck } from "./passes/loop-check.ts";
import { bugs, drawOrder, walk } from "./passes/reach.ts";
import { regionsLie } from "./passes/region-check.ts";
import { drawRegions } from "./passes/regions.ts";

function* inParts(lines: string[]) {
  let start = 0;
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    size += lines[i].length + 1;
    if (size > PART || i === lines.length - 1) {
      yield (start ? "\n" : "") + lines.slice(start, i + 1).join("\n");
      start = i + 1;
      size = 0;
    }
  }
}

const shortestFirst = (a: { path: unknown[] }, b: { path: unknown[] }) =>
  a.path.length - b.path.length;

export function project(graph: Graph, walked: Walk, view: View, found: Bug[]) {
  const { order, rank } = drawOrder(walked);
  const draw = (answers: Answers) => {
    const labels = labelGraph(graph, walked, answers, rank, found);
    return { labels, chart: drawRegions(walked, labels, order, found, view) };
  };
  const answers = ask(graph, walked, view);
  const first = draw(answers);
  const lie = regionsLie(first.chart.regions, first.labels, walked, order);
  const { labels, chart } = lie ? draw(asParents(walked, answers)) : first;
  loopCheck(chart, labels, walked, found);
  return {
    chart: lift(lie ? { ...chart, lie } : chart),
    stories: storiesOf(graph, found, walked, first.labels),
  };
}

export function compile(result: CheckResult, view: CheckedView) {
  const walked = walk(result.graph);
  const found = [...(result.paths ?? bugs(result.graph, walked))].sort(shortestFirst);
  for (const p of result.properties) if (p.bug) found.push({ rule: p.rule, ...p.bug });
  const { chart, stories } =
    found.length || !result.paths
      ? project(result.graph, walked, view, found)
      : { chart: undefined, stories: new Map<Bug, Story>() };
  const text = report(result, found, chart, stories);
  const files = new Map<string, Iterable<string | Uint8Array>>();
  if (chart) files.set("chart.mmd", inParts(mermaidLines(chart)));
  files.set("report.md", [text]);
  files.set("tlc.out", plainText(result.messages));
  const drawn = new Set<string>();
  for (const b of found) if (b.rule.kind !== "property") drawn.add(ruleKey(b.rule));
  for (const { rule, outcome, messages } of [...result.rules, ...result.properties])
    if (outcome === "broken" && messages && !drawn.has(ruleKey(rule)))
      files.set(`tlc-${rule.name}.out`, plainText(messages));
  return { report: text, files, exit: result.exit };
}
