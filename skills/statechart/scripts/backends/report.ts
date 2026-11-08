import {
  type Bug,
  CHART_STATES,
  type Chart,
  type Graph,
  hasSection,
  list,
  must,
  type Property,
  RERUN_STATES,
  ruleKey,
  type Spec,
  type Stop,
  type Story,
  type Verdict,
} from "../ir.ts";

const stepsOf = (story: Story) => {
  const path: { step?: string; state: string }[] = [];
  for (const { step, state } of story) {
    const parts: string[] = [];
    for (const [name, names] of Object.entries(state))
      parts.push((name ? `${name} ` : "") + names.join(" / "));
    path.push({ step, state: parts.join(", ") });
  }
  return path;
};

const forever = (loop: { state: string }[], stutters: boolean | undefined) => {
  const quoted = new Set<string>();
  for (const p of loop) quoted.add(`"${p.state}"`);
  const runs = [...quoted];
  if (stutters) return `The run stops in ${runs[0]} forever.`;
  return runs.length === 1
    ? `The run stays in ${runs[0]} forever.`
    : `The run loops through ${list(runs)} forever.`;
};

const fenced = (text: string) => ["```", text, "```"].join("\n");

export function report(
  {
    spec,
    graph,
    paths,
    rules,
    properties,
    stop,
    drawing,
    states,
  }: {
    spec: Spec;
    graph: Graph;
    paths: Bug[] | undefined;
    rules: Verdict[];
    properties: Property[];
    stop: Stop | undefined;
    drawing: { status: number | null } | undefined;
    states: { distinct: number; initial: number; complete: boolean; cut: boolean };
  },
  found: Bug[],
  chart: Chart | undefined,
  stories: Map<Bug, Story>,
) {
  let size = 0;
  let arrows = 0;
  for (const r of chart?.regions ?? []) {
    size += r.states.length;
    arrows += r.steps.length;
  }
  let past = 0;
  let pastSteps = 0;
  let excluded = 0;
  for (const s of graph.states.values()) {
    if (s.excluded) excluded++;
    else if (s.past) past++;
  }
  for (const t of graph.steps) if (must(graph.states, t.to).past) pastSteps++;
  const includes = (n: number) =>
    chart ? `, and the chart includes ${n === 1 ? "it" : "them"}` : "";
  const out = [
    `# ${spec.module}`,
    "",
    paths
      ? `TLC reached ${states.complete && !states.cut && states.distinct > CHART_STATES ? `${states.distinct.toLocaleString("en-US")} states, more than` : "more states than"} the chart budget of ${CHART_STATES}, so ${chart ? `the chart draws only the bug paths: ${size} states and ${arrows} arrows` : "the command wrote no chart.mmd"}.`
      : `TLC reached ${graph.states.size - past - excluded} states and ${graph.steps.length - pastSteps} steps. The chart draws ${size} states and ${arrows} arrows.`,
  ];
  if (drawing)
    out.push(
      `TLC stopped the drawing run with exit ${drawing.status}, so the chart draws only the states that it reached before it stopped.`,
    );
  if (!paths && !drawing && graph.states.size === past + excluded)
    out.push(
      states.initial
        ? "Every initial state is outside the constraints, so TLC explores none of them."
        : "TLC found no state that satisfies Init, so no state can break a rule.",
    );
  if (past)
    out.push(
      `${past === 1 ? "1 state outside the constraints ends" : `${past} states outside the constraints each end`} a rule's path${includes(past)}. TLC checks the rules in a state outside the constraints, but it does not explore past it.`,
    );
  if (excluded)
    out.push(
      `${excluded === 1 ? "1 step that the constraints exclude ends" : `${excluded} steps that the constraints exclude each end`} a rule's path${includes(excluded)}. TLC checks the rules after such a step, but it does not take the step.`,
    );
  if (chart?.inside)
    out.push(`The chart does not draw ${chart.inside} steps that stay in one chart state.`);
  if (chart?.quiet)
    out.push(`The view hides ${chart.quiet} steps, so the chart does not draw them.`);
  for (const { rule, outcome } of rules)
    if (
      !paths &&
      rule.kind === "deadlock" &&
      outcome === "broken" &&
      (drawing || hasSection(spec, "CONSTRAINT", "ACTION_CONSTRAINT"))
    )
      out.push(
        drawing
          ? "The chart marks only the deadlock that TLC reports, because the drawing run stopped before it reached every state."
          : "The chart marks only the deadlock that TLC reports. Under a CONSTRAINT or an ACTION_CONSTRAINT, a state with no step in the chart can still have steps that the constraints leave out, and TLC does not count it as a deadlock.",
      );
  if (chart?.lie) out.push(`${chart.lie} So the chart draws parent states in place of regions.`);
  out.push(...(chart?.notes ?? []));
  const merged: string[] = [];
  for (const k of ["VIEW", "SYMMETRY"]) if (hasSection(spec, k)) merged.push(k);
  if (chart && merged.length)
    out.push(
      `With ${list(merged)}, TLC keeps one representative for each group of states that it counts as the same. An arrow can lead to the representative rather than to the state that the step reaches.`,
    );
  for (const bug of found) {
    const steps = `${bug.path.length} step${bug.path.length === 1 ? "" : "s"}`;
    out.push("", `## ${bug.rule.name} breaks`);
    out.push(
      bug.rule.kind === "property"
        ? `TLC's counterexample is in tlc-${bug.rule.name}.out. It has ${steps}:`
        : `The shortest path has ${steps}:`,
    );
    const path = stepsOf(must(stories, bug));
    for (const [i, p] of path.entries()) out.push(`${i}. ${p.step ? `${p.step}: ` : ""}${p.state}`);
    if (bug.loop !== undefined) out.push(forever(path.slice(bug.loop), bug.stutters));
  }
  const drawn = new Set<string>();
  for (const b of found) drawn.add(ruleKey(b.rule));
  const holds: string[] = [];
  const unchecked: string[] = [];
  for (const { rule, outcome, messages } of [...rules, ...properties]) {
    if (outcome === "holds") holds.push(rule.name);
    else if (outcome === "not checked") unchecked.push(rule.name);
    else if (messages && !drawn.has(ruleKey(rule)))
      out.push(
        "",
        `## ${rule.name} breaks`,
        `TLC found a counterexample. It is in tlc-${rule.name}.out.`,
      );
  }
  if (holds.length) out.push("", "## Rules that hold", holds.join(", "));
  if (unchecked.length) out.push("", "## Rules not checked", unchecked.join(", "));
  if (unchecked.length && states.cut)
    out.push(
      `After the first break, each TLC run stops at ${RERUN_STATES.toLocaleString("en-US")} distinct states. A run reached that bound before it checked ${unchecked.length === 1 ? "this rule" : "these rules"} in every state.`,
    );
  if (stop)
    out.push(
      ...(unchecked.length
        ? [
            `TLC stopped with exit ${stop.status} before it checked ${unchecked.length === 1 ? "this rule" : "these rules"}:`,
          ]
        : ["", "## TLC stopped", `TLC stopped with exit ${stop.status}:`]),
      fenced(stop.message),
    );
  for (const p of properties)
    if (p.outcome === "holds" && p.initialOnly)
      out.push(
        `TLC checked ${p.rule.name} only in the initial states, because it has no [], <>, or ~>. List it as an INVARIANT to check every state.`,
      );
  return out.join("\n");
}
