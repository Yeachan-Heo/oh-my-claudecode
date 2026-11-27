// The janitor for statechart.ts on both platforms. When the command's pipe
// closes it kills the worker's process tree and removes its folders. The
// parent writes "exited" to the pipe when the worker exits on its own; on
// Windows the pid may already belong to another process by then, so the
// janitor spares a worker that exited before the pipe closed.
import fs from "node:fs";
import { finished } from "node:stream/promises";
import { killGroup } from "./kill.ts";

const [pid, ...dirs] = process.argv.slice(2);

let input = "";
process.stdin.setEncoding("utf8").on("data", (chunk: string) => (input += chunk));
await finished(process.stdin).catch(() => {});
const running = !input.includes("exited");
const groupOutlivesWorker = process.platform !== "win32";
if (running || groupOutlivesWorker) await killGroup(Number(pid));
for (const dir of dirs)
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Best-effort: the OS temp cleaner owns whatever a live handle pins.
  }
