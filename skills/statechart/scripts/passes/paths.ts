import {
  type Bug,
  type Graph,
  hasRule,
  type Lasso,
  must,
  type PathStep,
  type Rule,
  stateKey,
  type Step,
  type Trace,
  type TraceState,
  type Vars,
} from "../ir.ts";

export function pathGraph(names: string[]) {
  const graph: Graph = { states: new Map(), steps: [] };
  const ids = new Map<string, string>();
  const taken = new Map<string, Step>();
  const idOf = (vars: Vars | undefined, start: boolean) => {
    if (!vars) throw new Error("TLC's trace has a state with no values.");
    const k = stateKey(names.map((name) => vars[name]));
    let id = ids.get(k);
    if (id === undefined) {
      ids.set(k, (id = String(ids.size)));
      graph.states.set(id, { vars, start, breaks: [] });
    } else if (start) must(graph.states, id).start = true;
    return id;
  };
  const route = (seq: { action: string; vars: Vars | undefined }[]) => {
    const start = idOf(seq[0].vars, true);
    const path: PathStep[] = [];
    let from = start;
    for (let i = 1; i < seq.length; i++) {
      const { action } = seq[i];
      const to = idOf(seq[i].vars, false);
      const k = `${from} ${to} ${action}`;
      let step = taken.get(k);
      if (!step) {
        taken.set(k, (step = { from, to, action }));
        graph.steps.push(step);
      }
      path.push({ action, state: to, step });
      from = to;
    }
    return { start, path };
  };
  return {
    graph,
    bug: (rule: Rule, trace: TraceState[]): Bug => {
      if (!trace.length) throw new Error(`TLC's trace for ${rule.name} has no states.`);
      const bug = { rule, ...route(trace) };
      const end = must(graph.states, bug.path.at(-1)?.state ?? bug.start);
      if (!hasRule(end.breaks, rule)) end.breaks.push(rule);
      return bug;
    },
    lasso: ({ seq, loop }: Trace): Lasso | undefined =>
      seq.length ? { ...route(seq), loop, stutters: loop === seq.length - 1 } : undefined,
  };
}
