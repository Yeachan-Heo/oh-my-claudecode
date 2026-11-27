/**
 * Tool, agent and skill call counts of transcripts larger than the tail window
 * that the parser reads for its other data.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { parseTranscript } from "../../hud/transcript.js";
import { countCall, countTranscriptCalls } from "../../hud/call-counter.js";

const MB = 1024 * 1024;
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hud-call-counts-"));
  tempDirs.push(dir);
  return dir;
}

function entry(content: unknown): string {
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", content },
  }) + "\n";
}

function call(id: string, name = "Read", input: unknown = {}): string {
  return entry([{ type: "tool_use", id, name, input }]);
}

function calls(prefix: string, count: number, name = "Read"): string {
  let lines = "";
  for (let i = 0; i < count; i++) lines += call(`${prefix}_${i}`, name);
  return lines;
}

/** A local API request record that carries a copy of a call */
function requestCopy(id: string, name = "Read"): string {
  return JSON.stringify({
    type: "api-request-blob",
    message: { content: [{ type: "tool_use", id, name, input: {} }] },
  }) + "\n";
}

/** Lines without calls, about `bytes` long in total */
function filler(bytes: number, lineBytes = 64 * 1024): string {
  const line = entry([{ type: "text", text: "x".repeat(lineBytes) }]);
  return line.repeat(Math.ceil(bytes / line.length));
}

/** One line without calls, exactly `bytes` long */
function padding(bytes: number): string {
  const empty = entry([{ type: "text", text: "" }]);
  return entry([{ type: "text", text: "x".repeat(bytes - empty.length) }]);
}

/** 6 tool, 2 agent and 1 skill calls */
const HEAD =
  calls("head", 3) +
  call("head_task", "Task") +
  call("head_agent", "proxy_Agent") +
  call("head_skill", "Skill", { skill: "demo" });
/** 3 tool, 1 agent and 1 skill calls */
const TAIL =
  call("tail_read") +
  call("tail_agent", "Agent") +
  call("tail_skill", "proxy_Skill", { skill: "demo" });

const counts = (toolCallCount: number, agentCallCount = 0, skillCallCount = 0) => ({
  toolCallCount,
  agentCallCount,
  skillCallCount,
});

describe("parseTranscript call counts", () => {
  it("counts the calls before the last 4 MB of a large transcript", async () => {
    const dir = tempDir();
    const path = join(dir, "large.jsonl");
    writeFileSync(path, HEAD + filler(5 * MB) + TAIL);

    const result = await parseTranscript(path, {
      callCountStatePath: join(dir, "state.json"),
    });

    expect(result).toMatchObject(counts(9, 3, 2));
  });

  it("counts them without a state file too", async () => {
    const path = join(tempDir(), "large.jsonl");
    writeFileSync(path, HEAD + filler(5 * MB) + TAIL);

    expect(await parseTranscript(path)).toMatchObject(counts(9, 3, 2));
  });

  it("counts every call once as the transcript grows around the tail window", async () => {
    const dir = tempDir();
    const path = join(dir, "growing.jsonl");
    const options = { callCountStatePath: join(dir, "state.json") };
    // The tail window starts in the middle of these calls
    const middle = calls("middle", 40);
    const after = padding(4 * MB - middle.length / 2 - TAIL.length);
    writeFileSync(path, HEAD + filler(1 * MB) + middle + after + TAIL);
    expect(await parseTranscript(path, options)).toMatchObject(counts(49, 3, 2));
    expect(await parseTranscript(path, options)).toMatchObject(counts(49, 3, 2));

    appendFileSync(path, calls("later", 5) + filler(1 * MB));
    expect(await parseTranscript(path, options)).toMatchObject(counts(54, 3, 2));

    // Everything counted so far has now left the tail window
    appendFileSync(path, filler(5 * MB) + call("last", "Task"));
    expect(await parseTranscript(path, options)).toMatchObject(counts(55, 4, 2));
  });

  it("counts a repeated record once, in small and in large transcripts", async () => {
    const dir = tempDir();
    const repeated = call("same_task", "Task") + call("same_skill", "Skill", { skill: "demo" });
    const copy = requestCopy("same_task", "Task");

    const small = join(dir, "small.jsonl");
    writeFileSync(small, repeated + copy + repeated);
    expect(await parseTranscript(small)).toMatchObject(counts(2, 1, 1));

    const large = join(dir, "large.jsonl");
    writeFileSync(large, repeated + filler(5 * MB) + copy + repeated);
    expect(await parseTranscript(large)).toMatchObject(counts(2, 1, 1));
  });

  it("counts a repeat of a call that an earlier render counted only once", async () => {
    const dir = tempDir();
    const path = join(dir, "large.jsonl");
    const options = { callCountStatePath: join(dir, "state.json") };
    writeFileSync(path, HEAD + filler(5 * MB) + TAIL);
    expect(await parseTranscript(path, options)).toMatchObject(counts(9, 3, 2));

    // A call from before the tail window, one from inside it, and a copy
    appendFileSync(
      path,
      call("head_task", "Task") +
        call("tail_agent", "Agent") +
        requestCopy("head_skill", "Skill") +
        call("new"),
    );

    expect(await parseTranscript(path, options)).toMatchObject(counts(10, 3, 2));
  });

  it("applies the same rules to a large transcript as to a small one", async () => {
    const dir = tempDir();
    const odd =
      "not json with \"tool_use\"\n" +
      "null\n" +
      "\n" +
      entry("text that mentions \"tool_use\"") +
      entry([{ type: "tool_use", name: "Read" }]) +
      entry([{ type: "tool_use", id: "no_name" }]) +
      entry([{ type: "server_tool_use", id: "server", name: "web_search" }]) +
      entry([{ type: "tool_result", tool_use_id: "x", content: "\"type\":\"tool_use\"" }]) +
      entry([{ type: "tool_use", id: "before_null", name: "Read" }, null, { type: "tool_use", id: "after_null", name: "Read" }]) +
      entry([{ type: "text", text: "t" }, { type: "tool_use", id: "second_block", name: "Task", input: {} }]) +
      call("crlf").replace("\n", "\r\n");

    const small = join(dir, "small.jsonl");
    writeFileSync(small, odd);
    const large = join(dir, "large.jsonl");
    writeFileSync(large, odd + filler(5 * MB));

    expect(await parseTranscript(small)).toMatchObject(counts(3, 1));
    expect(await parseTranscript(large)).toMatchObject(counts(3, 1));
  });

  it("shows the tail counts until the backlog is read, also for an unchanged file", async () => {
    const dir = tempDir();
    const path = join(dir, "huge.jsonl");
    const options = { callCountStatePath: join(dir, "state.json") };
    // More than one run reads
    writeFileSync(path, HEAD + filler(66 * MB, MB) + TAIL);

    expect(await parseTranscript(path, options)).toMatchObject(counts(3, 1, 1));
    expect(await parseTranscript(path, options)).toMatchObject(counts(9, 3, 2));
  });
});

/**
 * Wait for the other workers, then count with a small budget until the backlog
 * is read, a few times over, all on the same checkpoint.
 */
const WORKER = `
import { existsSync, writeFileSync } from "node:fs";
const [moduleUrl, path, state, budget, dir, id, workers] = process.argv.slice(2);
const { countTranscriptCalls } = await import(moduleUrl);
const pause = () => new Promise((done) => setTimeout(done, 2));
writeFileSync(dir + "/ready-" + id, "");
const deadline = Date.now() + 15000;
for (let other = 0; other < Number(workers); other++) {
  while (!existsSync(dir + "/ready-" + other)) {
    if (Date.now() > deadline) throw new Error("worker " + other + " did not start");
    await pause();
  }
}
const results = [];
for (let run = 0; run < 200 && results.length < 20; run++) {
  const result = countTranscriptCalls(path, state, Number(budget));
  if (result) results.push(result);
  await pause();
}
process.stdout.write(JSON.stringify(results));
`;

function runWorker(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 25_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`worker exited ${code}: ${stderr}`));
    });
  });
}

describe("countTranscriptCalls", () => {
  function setup(content: string) {
    const dir = tempDir();
    const path = join(dir, "t.jsonl");
    const state = join(dir, "state", "counts.json");
    writeFileSync(path, content);
    const checkpoint = () => JSON.parse(readFileSync(state, "utf8"));
    const offset = (): number => checkpoint().offset;
    return { dir, path, state, checkpoint, offset };
  }

  it("reads only what was appended since the saved checkpoint", () => {
    const { path, state, offset } = setup(calls("a", 200));
    expect(countTranscriptCalls(path, state)).toEqual(counts(200));
    expect(offset()).toBe(statSync(path).size);

    // A budget of one line is enough: nothing before the checkpoint is read
    expect(countTranscriptCalls(path, state, 1)).toEqual(counts(200));
    const appended = call("b", "Task");
    appendFileSync(path, appended);
    expect(countTranscriptCalls(path, state, appended.length)).toEqual(counts(201, 1));
    expect(offset()).toBe(statSync(path).size);
  });

  it("spreads a backlog over runs and counts every call once", () => {
    const content = calls("a", 100);
    const { path, state, offset } = setup(content);

    const offsets: number[] = [];
    let result = countTranscriptCalls(path, state, content.length / 4);
    for (let run = 1; result === null && run < 10; run++) {
      offsets.push(offset());
      result = countTranscriptCalls(path, state, content.length / 4);
    }

    expect(result).toEqual(counts(100));
    expect(offsets).toHaveLength(3);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    for (const end of offsets) expect(content[end - 1]).toBe("\n");
  });

  it("never completes a backlog beyond the budget without a state file", () => {
    const content = calls("a", 100);
    const { path } = setup(content);

    expect(countTranscriptCalls(path, undefined, content.length / 4)).toBeNull();
    expect(countTranscriptCalls(path, undefined, content.length / 4)).toBeNull();
    expect(countTranscriptCalls(path, undefined, content.length)).toEqual(counts(100));
  });

  /** Two calls, and one call that takes exactly as many bytes */
  const TWO = call("old_1") + call("old_2");
  const ONE = call("new_1", "Read", {
    pad: "y".repeat(TWO.length - call("new_1", "Read", { pad: "" }).length),
  });
  const SAME = filler(1024, 512);

  it("counts again after the file is cut off", () => {
    const kept = SAME + calls("kept", 4);
    const { path, state } = setup(kept + calls("dropped", 30));
    expect(countTranscriptCalls(path, state)).toEqual(counts(34));

    truncateSync(path, kept.length);

    expect(countTranscriptCalls(path, state)).toEqual(counts(4));
  });

  it("counts again after the file is rewritten in place and grows", () => {
    const { path, state } = setup(calls("old", 3));
    countTranscriptCalls(path, state);
    const inode = statSync(path).ino;

    writeFileSync(path, calls("new", 50, "Skill"));

    expect(statSync(path).ino).toBe(inode);
    expect(countTranscriptCalls(path, state)).toEqual(counts(50, 0, 50));
  });

  it("counts again after another file takes its place", () => {
    const { dir, path, state } = setup(SAME + TWO + SAME);
    expect(countTranscriptCalls(path, state)).toEqual(counts(2));

    // Same size, same first and last bytes
    const other = join(dir, "other.jsonl");
    writeFileSync(other, SAME + ONE + SAME);
    expect(statSync(other).size).toBe(statSync(path).size);
    renameSync(other, path);

    expect(countTranscriptCalls(path, state)).toEqual(counts(1));
  });

  it("counts again after the start of the file is rewritten in place", () => {
    const { path, state } = setup(TWO + SAME);
    expect(countTranscriptCalls(path, state)).toEqual(counts(2));
    const inode = statSync(path).ino;

    // Same size and same last bytes
    writeFileSync(path, ONE + SAME);

    expect(statSync(path).ino).toBe(inode);
    expect(countTranscriptCalls(path, state)).toEqual(counts(1));
  });

  it("counts again after the counted end of the file is rewritten in place", () => {
    const { path, state } = setup(SAME + TWO);
    expect(countTranscriptCalls(path, state)).toEqual(counts(2));
    const inode = statSync(path).ino;

    // Same size and same first bytes
    writeFileSync(path, SAME + ONE);

    expect(statSync(path).ino).toBe(inode);
    expect(countTranscriptCalls(path, state)).toEqual(counts(1));
  });

  it("counts a call that an earlier run counted only once", () => {
    const { path, state } = setup(calls("a", 3, "Task"));
    expect(countTranscriptCalls(path, state)).toEqual(counts(3, 3));

    appendFileSync(path, call("a_0", "Task") + requestCopy("a_1", "Task") + call("b"));
    expect(countTranscriptCalls(path, state)).toEqual(counts(4, 3));

    // The checkpoint that a resumed run saves still knows the earlier calls
    appendFileSync(path, call("a_2", "Task") + call("b"));
    expect(countTranscriptCalls(path, state)).toEqual(counts(4, 3));
  });

  it("counts an unterminated last line now and only once later", () => {
    const { path, state, checkpoint } = setup(call("a") + call("b", "Task").trimEnd());

    expect(countTranscriptCalls(path, state)).toEqual(counts(2, 1));
    expect(countTranscriptCalls(path, state)).toEqual(counts(2, 1));
    expect(checkpoint()).toMatchObject({ ...counts(1), offset: call("a").length });

    appendFileSync(path, "\n" + call("c"));
    expect(countTranscriptCalls(path, state)).toEqual(counts(3, 1));
  });

  it("waits for the rest of a torn last line", () => {
    const line = call("torn", "Skill");
    const { path, state } = setup(call("a") + line.slice(0, 40));
    expect(countTranscriptCalls(path, state)).toEqual(counts(1));

    appendFileSync(path, line.slice(40));

    expect(countTranscriptCalls(path, state)).toEqual(counts(2, 0, 1));
  });

  it("counts a call line that crosses a read boundary", () => {
    // Lines of an odd length put read boundaries inside call lines
    const input = { text: "z".repeat(700 * 1024) };
    const content = call("a", "Read", input) + call("b", "Task", input) + call("c", "Read", input);
    const { path, state } = setup(content);

    expect(countTranscriptCalls(path, state)).toEqual(counts(3, 1));
  });

  it("skips a line over the length limit and keeps counting", () => {
    const long = call("long", "Task", { text: "z".repeat(3 * MB) });
    const { path, state } = setup(call("a") + long + call("b"));

    expect(countTranscriptCalls(path, state, undefined, 2 * MB)).toEqual(counts(2));
    expect(countTranscriptCalls(path, undefined, undefined, 4 * MB)).toEqual(counts(3, 1));
  });

  it("applies the length limit to a line inside one read", () => {
    const { path } = setup(call("long", "Task", { text: "z".repeat(2000) }) + call("b"));

    expect(countTranscriptCalls(path, undefined, undefined, 1000)).toEqual(counts(1));
  });

  it("advances through a line longer than the budget", () => {
    const long = call("long", "Task", { text: "z".repeat(5 * MB) });
    const { path, state } = setup(call("a") + long + call("b"));

    const results: ReturnType<typeof countTranscriptCalls>[] = [];
    for (let run = 0; run < 12 && !results.at(-1); run++) {
      results.push(countTranscriptCalls(path, state, MB, 2 * MB));
    }

    expect(results.length).toBeGreaterThan(2);
    expect(results.at(-1)).toEqual(counts(2));
  });

  it("finishes a line that is longer than the budget but within the limit", () => {
    const long = call("long", "Task", { text: "z".repeat(3 * MB) });
    const { path, state } = setup(long + call("b"));

    expect(countTranscriptCalls(path, state, MB)).toBeNull();
    expect(countTranscriptCalls(path, state, MB)).toEqual(counts(2, 1));
  });

  it("leaves out an unterminated line over the limit, also once it ends", () => {
    const long = call("long", "Task", { text: "z".repeat(3 * MB) }).trimEnd();
    const { path, state, offset } = setup(call("a") + long);
    expect(countTranscriptCalls(path, state, undefined, 2 * MB)).toEqual(counts(1));
    expect(offset()).toBe(statSync(path).size);

    // The rest of the long line reads like a call line of its own
    appendFileSync(path, call("inside_long_line") + call("b"));

    expect(countTranscriptCalls(path, state, undefined, 2 * MB)).toEqual(counts(2));
  });

  it.each([
    ["text that is not JSON", "{\"version\":1,"],
    ["a null", "null"],
    ["another version", { version: 99 }],
    ["a missing count", { toolCallCount: undefined }],
    ["a negative offset", { offset: -1 }],
    ["no list of calls", { seen: 7 }],
  ])("counts from the start when the checkpoint holds %s", (_name, damage) => {
    const { path, state } = setup(calls("a", 5, "Task"));
    countTranscriptCalls(path, state);
    const good = JSON.parse(readFileSync(state, "utf8"));
    // Wrong counts show whether the damaged checkpoint was used
    writeFileSync(
      state,
      typeof damage === "string"
        ? damage
        : JSON.stringify({ ...good, toolCallCount: 1000, ...damage }),
    );

    expect(countTranscriptCalls(path, state)).toEqual(counts(5, 5));
    expect(JSON.parse(readFileSync(state, "utf8"))).toEqual(good);
  });

  it("continues from a checkpoint that an older parallel run saved last", () => {
    const { path, state } = setup(calls("a", 3));
    countTranscriptCalls(path, state);
    const older = readFileSync(state);
    appendFileSync(path, calls("b", 3));
    countTranscriptCalls(path, state);
    writeFileSync(state, older);
    appendFileSync(path, calls("c", 3));

    expect(countTranscriptCalls(path, state)).toEqual(counts(9));
  });

  it("counts when the checkpoint cannot be saved", () => {
    const { path, state } = setup(calls("a", 5));
    mkdirSync(state, { recursive: true });

    expect(countTranscriptCalls(path, state)).toEqual(counts(5));
    expect(countTranscriptCalls(path, state)).toEqual(counts(5));
  });

  it("gives processes that share a checkpoint the same counts", async () => {
    const content = calls("a", 60, "Task");
    const { dir, path, state, offset } = setup(content);
    countTranscriptCalls(path, state);
    // Repeats of counted calls, new calls and their repeats
    appendFileSync(
      path,
      calls("a", 20, "Task") + calls("b", 60) + calls("b", 20) + call("c", "Skill"),
    );
    const worker = join(dir, "worker.mjs");
    writeFileSync(worker, WORKER);
    const moduleUrl = pathToFileURL(join(process.cwd(), "src/hud/call-counter.ts")).href;
    const budget = String(Math.ceil(content.length / 8));
    const workers = 4;

    const results = await Promise.all(
      Array.from({ length: workers }, (_, id) =>
        runWorker([worker, moduleUrl, path, state, budget, dir, String(id), String(workers)]),
      ),
    );

    for (const result of results) {
      expect(result).toEqual(Array.from({ length: 20 }, () => counts(121, 60, 1)));
    }
    expect(offset()).toBe(statSync(path).size);
    expect(readdirSync(join(dir, "state"))).toEqual(["counts.json"]);
  }, 30_000);

  it("returns null for a missing transcript", () => {
    const { dir, state } = setup("");

    expect(countTranscriptCalls(join(dir, "missing.jsonl"), state)).toBeNull();
    expect(existsSync(state)).toBe(false);
  });

  it("keeps counting new calls once the memory of counted ids is full", () => {
    const result = counts(0);
    const seen = new Set<string>();
    for (let i = 0; i < 100_005; i++) countCall(result, seen, `id_${i}`, "Read");
    countCall(result, seen, "id_0", "Read");

    expect(result.toolCallCount).toBe(100_005);
    expect(seen.size).toBe(100_000);
  });
});
