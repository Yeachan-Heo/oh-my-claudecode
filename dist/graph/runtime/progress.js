/**
 * ASCII progress rendering (graph runtime v2).
 *
 * Event-to-string rendering is pure so tests pin exact strings; the reporter
 * adds exactly one side effect per event — a single out.write of the rendered
 * line plus newline. No colors, no console.*, pure ASCII output.
 */
/** node_result outcome -> ASCII tag. */
const OUTCOME_TAGS = {
    succeeded: "ok",
    failed: "fail",
    approved: "approved",
    denied: "denied",
    join_resolved: "join",
};
/** Renders one progress event as its exact ASCII line. Pure. */
export function renderProgressEvent(event) {
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
export function createAsciiProgressReporter(out) {
    const sink = out ?? process.stdout;
    return {
        onEvent(event) {
            sink.write(`${renderProgressEvent(event)}\n`);
        },
    };
}
//# sourceMappingURL=progress.js.map