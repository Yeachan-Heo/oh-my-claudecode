// The Windows janitor for statechart.ts. Windows has no process groups and no /bin/sh, so when
// the command's pipe closes this kills the worker's process tree and removes its folders.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const [pid, ...dirs] = process.argv.slice(2);

process.stdin.on("end", () => {
  spawnSync("taskkill", ["/T", "/F", "/PID", pid], { stdio: "ignore", windowsHide: true });
  // One handle-held dir must not stop the others from being removed.
  for (const dir of dirs)
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // Best-effort: the OS temp cleaner owns whatever a live handle pins.
    }
});
process.stdin.resume();
