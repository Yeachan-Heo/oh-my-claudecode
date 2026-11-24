/**
 * ASCII progress rendering (graph runtime v2).
 *
 * Event-to-string rendering is pure so tests pin exact strings; the reporter
 * adds exactly one side effect per event — a single out.write of the rendered
 * line plus newline. No colors, no console.*, pure ASCII output.
 */
import type { ProgressReporter, RuntimeProgressEvent } from "./types.js";
/** Minimal writable surface shared by process.stdout and stream.PassThrough. */
type WriteSink = {
    write(chunk: string): unknown;
};
/** Renders one progress event as its exact ASCII line. Pure. */
export declare function renderProgressEvent(event: RuntimeProgressEvent): string;
/**
 * ProgressReporter writing rendered lines to the given sink (default
 * process.stdout), one write per event.
 */
export declare function createAsciiProgressReporter(out?: WriteSink): ProgressReporter;
export {};
//# sourceMappingURL=progress.d.ts.map