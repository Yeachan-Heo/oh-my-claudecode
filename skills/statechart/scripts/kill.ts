import { spawn } from "node:child_process";

// The group kill runs from the parent and from the janitor, on both
// platforms: Windows has no process groups, so taskkill walks the tree;
// POSIX kills the process group the worker was spawned into, without a
// /bin/sh child, because native Windows has no shell to spawn either.
export const killGroup = (pid: number) =>
  new Promise<void>((resolve) => {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" })
        .on("error", () => resolve())
        .on("exit", () => resolve());
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    resolve();
  });
