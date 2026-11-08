/**
 * ASCII progress rendering (graph runtime v2).
 *
 * Event-to-string rendering is pure so tests pin exact strings; the reporter
 * adds exactly one side effect per event — a single out.write of the rendered
 * line plus newline. No colors, no console.*, pure ASCII output.
 */

import type { ProgressReporter, RuntimeProgressEvent } from "./types.js";

/** Minimal writable surface shared by process.stdout and stream.PassThrough. */
type WriteSink = { write(chunk: string): unknown };

type NodeResultOutcome = Extract<
  RuntimeProgressEvent,
  { type: "node_result" }
>["outcome"];

/** node_result outcome -> ASCII tag. */
const OUTCOME_TAGS: Record<NodeResultOutcome, string> = {
  succeeded: "ok",
  failed: "fail",
  approved: "approved",
  denied: "denied",
  join_resolved: "join",
};

/** Renders one progress event as its exact ASCII line. Pure. */
export function renderProgressEvent(event: RuntimeProgressEvent): string {
  switch (event.type) {
    case "run_started":
      return `[run] ${event.run_id} — ${event.goal}`;
    case "replayed":
      return `[replay] ${event.records} record(s) @ epoch ${event.epoch}`;
    case "activation_started":
      return `[node] ${event.node_id} attempt #${event.attempt_no} started`;
    case "node_result":
      return `[${OUTCOME_TAGS[event.outcome]}] ${event.node_id}`;
    case "run_ended":
      return `[done] ${event.terminal} — ${event.summary}`;
  }
}

/**
 * ProgressReporter writing rendered lines to the given sink (default
 * process.stdout), one write per event.
 */
export function createAsciiProgressReporter(out?: WriteSink): ProgressReporter {
  const sink = out ?? process.stdout;
  return {
    onEvent(event: RuntimeProgressEvent): void {
      sink.write(`${renderProgressEvent(event)}\n`);
    },
  };
}
