import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { checkView } from "./frontends/view.ts";
import { compile } from "./pipeline.ts";
import { check, messageOf, terminateChildren } from "./run.ts";

// The parent escalates to a group SIGKILL only after this grace window: on
// SIGTERM, kill and await the TLC children first, so a container whose PID 1
// does not reap is not left a defunct JVM per cancellation.
let stopping = false;
const stop = (exitCode: number) => {
  if (stopping) return;
  stopping = true;
  void terminateChildren().then(() => process.exit(exitCode));
};
process.on("SIGTERM", () => stop(2));
process.on("SIGINT", () => stop(130));

const [stage, specFile, configFile, viewFile] = process.argv.slice(2);

try {
  const view = checkView(
    viewFile ? await import(pathToFileURL(path.resolve(viewFile)).href) : {},
    inspect,
  );
  const { files, exit } = compile(await check(specFile, configFile), view);
  const draft = path.join(stage, "draft");
  fs.mkdirSync(draft);
  for (const [name, parts] of files) {
    const fd = fs.openSync(path.join(draft, name), "wx");
    try {
      for (const part of parts)
        fs.writeSync(fd, typeof part === "string" ? Buffer.from(part) : part);
      fs.writeSync(fd, "\n");
    } finally {
      fs.closeSync(fd);
    }
  }
  fs.renameSync(draft, path.join(stage, "done"));
  process.exit(exit);
} catch (error) {
  console.error(messageOf(error));
  process.exit(2);
}
