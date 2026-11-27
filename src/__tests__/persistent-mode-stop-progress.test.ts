import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
// @ts-expect-error the hook helper module has no type declarations
import { resolveOmcStateRoot } from "../../scripts/lib/state-root.mjs";

const WORKTREE = process.cwd();

let TMP = "";
let HOME_DIR = "";
let PROJECT = "";
let STATE_DIR = "";
let TRANSCRIPTS = "";

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "omc-stop-progress-"));
  HOME_DIR = path.join(TMP, "home");
  PROJECT = path.join(TMP, "project");
  STATE_DIR = path.join(TMP, "state");
  TRANSCRIPTS = path.join(TMP, "transcripts");
  for (const dir of [HOME_DIR, path.join(HOME_DIR, ".claude"), PROJECT, STATE_DIR, TRANSCRIPTS]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(HOME_DIR, ".claude", ".claude.json"), JSON.stringify({ projects: {} }));
});

afterAll(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
});

function hookEnv(scenario: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: HOME_DIR,
    USERPROFILE: HOME_DIR,
    CLAUDE_CONFIG_DIR: path.join(HOME_DIR, ".claude"),
    TMPDIR: TMP,
    TEMP: TMP,
    TMP: TMP,
    OMC_STATE_DIR: STATE_DIR,
    OMC_JEV_LOG_DIR: path.join(TMP, "logs"),
    OMC_JEV_QUIET: "1",
    ...scenario,
  };
}

function runHook(scenario: Record<string, string>, sessionId: string, extraInput: Record<string, unknown> = {}) {
  return spawnSync(process.execPath, [path.join(WORKTREE, "scripts", "persistent-mode.mjs")], {
    input: JSON.stringify({ hook_event_name: "Stop", cwd: PROJECT, session_id: sessionId, stop_hook_active: false, last_assistant_message: "", ...extraInput }),
    env: hookEnv(scenario),
    encoding: "utf8",
    timeout: 120000,
  });
}

async function stateRoot(): Promise<string> {
  process.env.OMC_STATE_DIR = STATE_DIR;
  try { return await resolveOmcStateRoot(PROJECT); } finally { delete process.env.OMC_STATE_DIR; }
}

async function writeState(sid: string, extra: Record<string, unknown> = {}): Promise<string> {
  const root = await stateRoot();
  const dir = path.join(root, "state", "sessions", sid);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const state: Record<string, unknown> = { active: true, session_id: sid, project_path: PROJECT, claude_goal_objective: "test objective for the stop progress release", started_at: now, updated_at: now, current_phase: "executing", ...extra };
  fs.writeFileSync(path.join(dir, "ultragoal-state.json"), JSON.stringify(state));
  return root;
}

function readState(root: string, sid: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "state", "sessions", sid, "ultragoal-state.json"), "utf8"));
}

function writeTranscript(sid: string): string {
  const file = path.join(TRANSCRIPTS, sid + ".jsonl");
  const row = JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: "End of turn without tool calls." }] } });
  fs.writeFileSync(file, row + "\n");
  return file;
}

const json = (r: ReturnType<typeof runHook>): Record<string, unknown> => JSON.parse(r.stdout ?? "{}");

describe("persistent-mode Stop progress release", () => {
  it("passes through in silence without an active mode even with the switch on", () => {
    const r = runHook({ OMC_JEV_STOP_PROGRESS: "1" }, "silence", { transcript_path: writeTranscript("silence") });
    expect(r.status).toBe(0);
    const o = json(r);
    expect(o.continue).toBe(true);
    expect(String(o.systemMessage ?? "")).not.toContain("ULTRAGOAL");
  });

  it("announces the re-entrant release at stop_hook_active with the switch on", () => {
    const r = runHook({ OMC_JEV_STOP_PROGRESS: "1" }, "sha-on", { stop_hook_active: true });
    expect(r.status).toBe(0);
    const o = json(r);
    expect(o.continue).toBe(true);
    expect(String(o.systemMessage ?? "")).toMatch(/stop_hook_active/);
  });

  it("keeps the silent stop_hook_active pass byte-identical without the switch", () => {
    for (const scenario of [{}, { OMC_JEV_STOP_PROGRESS: "0" }] as Record<string, string>[]) {
      const r = runHook(scenario, "sha-off-" + (scenario.OMC_JEV_STOP_PROGRESS ?? "missing"), { stop_hook_active: true });
      expect(r.status).toBe(0);
      expect(r.stdout?.trim()).toBe(JSON.stringify({ continue: true, suppressOutput: true }));
    }
  });

  it("blocks six times, releases at the seventh block and keeps the series past the threshold", async () => {
    const sid = "series";
    const root = await writeState(sid);
    const scenario = { OMC_JEV_STOP_PROGRESS: "1" };
    for (let i = 1; i <= 6; i++) {
      const r = runHook(scenario, sid, { transcript_path: writeTranscript(sid) });
      expect(r.status).toBe(0);
      const o = json(r);
      expect(o.decision).toBe("block");
      expect(String(o.reason ?? "")).toMatch(/\[ULTRAGOAL #\d+\/50\]/);
      expect(String(o.reason ?? "")).toContain("BLOCKED: <reason, at least 20 characters>");
    }
    const after6 = readState(root, sid);
    expect(after6.reinforcement_count).toBe(6);
    const progress6 = after6.stopProgress as Record<string, unknown>;
    expect(progress6.blocks).toBe(6);
    expect(progress6.totalBlocks).toBe(6);
    const r7 = runHook(scenario, sid, { transcript_path: writeTranscript(sid) });
    expect(r7.status).toBe(0);
    const o7 = json(r7);
    expect(o7.decision).toBeUndefined();
    expect(o7.continue).toBe(true);
    expect(String(o7.systemMessage ?? "")).toMatch(/after 7 Stop blocks without progress/);
    expect(String(o7.systemMessage ?? "")).toMatch(/threshold 7/);
    const after7 = readState(root, sid);
    expect(after7.reinforcement_count).toBe(6);
    expect((after7.stopProgress as Record<string, unknown>).blocks).toBe(7);
    const r8 = runHook(scenario, sid, { transcript_path: writeTranscript(sid) });
    expect(r8.status).toBe(0);
    const o8 = json(r8);
    expect(o8.decision).toBeUndefined();
    expect(String(o8.systemMessage ?? "")).toMatch(/after 8 Stop blocks without progress/);
    const after8 = readState(root, sid);
    expect(after8.reinforcement_count).toBe(6);
    expect((after8.stopProgress as Record<string, unknown>).blocks).toBe(8);
  });

  it("a broken progress state and a missing transcript do not trap the session", async () => {
    const sid = "broken-state";
    const root = await writeState(sid, { stopProgress: "corrupted-not-an-object" });
    const r = runHook({ OMC_JEV_STOP_PROGRESS: "1" }, sid, { transcript_path: path.join(TRANSCRIPTS, "no-such-file.jsonl") });
    expect(r.status).toBe(0);
    const o = json(r);
    expect(o.decision).toBe("block");
    expect(String(o.reason ?? "")).toMatch(/\[ULTRAGOAL #1\/50\]/);
    expect((readState(root, sid).stopProgress as Record<string, unknown>).blocks).toBe(1);
  });

  it("an acknowledged blocked exit releases Stop and keeps the counter unspent", async () => {
    const sid = "ack-on";
    await writeState(sid);
    const r = runHook({ OMC_JEV_STOP_PROGRESS: "1" }, sid, { transcript_path: writeTranscript(sid), last_assistant_message: "BLOCKED: no access to the production server and its API key" });
    expect(r.status).toBe(0);
    const o = json(r);
    expect(o.continue).toBe(true);
    expect(String(o.systemMessage ?? "")).toMatch(/acknowledged blocked exit/);
    const state = readState(await stateRoot(), sid);
    expect(state.reinforcement_count).toBeUndefined();
    expect(state.stopProgress).toBeUndefined();
  });

  it("ignores the acknowledged exit without the switch and blocks as before", async () => {
    const sid = "ack-off";
    await writeState(sid);
    const r = runHook({}, sid, { transcript_path: writeTranscript(sid), last_assistant_message: "BLOCKED: no access to the production server and its API key" });
    expect(r.status).toBe(0);
    const o = json(r);
    expect(o.decision).toBe("block");
    expect(String(o.reason ?? "")).toMatch(/\[ULTRAGOAL #1\/50\]/);
  });

  it("without the switch the loop blocks eight times with no persisted progress state", async () => {
    for (const scenario of [{}, { OMC_JEV_STOP_PROGRESS: "0" }] as Record<string, string>[]) {
      const sid = "off-series-" + (scenario.OMC_JEV_STOP_PROGRESS ?? "missing");
      await writeState(sid);
      const reason = "BLOCKED: no access to the private package registry of the company";
      const r = runHook(scenario, sid, { transcript_path: writeTranscript(sid), last_assistant_message: reason });
      expect(r.status).toBe(0);
      const o = json(r);
      expect(o.decision).toBe("block");
      expect(String(o.reason ?? "")).toMatch(/\[ULTRAGOAL #1\/50\]/);
      expect(String(o.reason ?? "")).not.toContain("BLOCKED");
      let last: Record<string, unknown> = {};
      for (let i = 2; i <= 8; i++) {
        const ri = runHook(scenario, sid, { transcript_path: writeTranscript(sid) });
        expect(ri.status).toBe(0);
        last = json(ri);
        expect(last.decision).toBe("block");
        expect(String(last.reason ?? "")).toMatch(new RegExp("\\[ULTRAGOAL #" + i + "\\/50\\]"));
      }
      const stateAfter = readState(await stateRoot(), sid);
      expect(stateAfter.reinforcement_count).toBe(8);
      expect("stopProgress" in stateAfter).toBe(false);
    }
  });

  it("hashes the work state over the session paths only and a session-path change resets the series", async () => {
    const sid = "git-hash";
    spawnSync("git", ["init", "-q", PROJECT]);
    const root = await writeState(sid);
    fs.writeFileSync(path.join(PROJECT, "session-file.md"), "x\n");
    const tr = path.join(TRANSCRIPTS, "git.jsonl");
    const useRow = JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", id: "tu-git", name: "Write", input: { file_path: path.join(PROJECT, "session-file.md"), content: "x" } }] } });
    const resultRow = JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { content: [{ type: "tool_result", tool_use_id: "tu-git", content: "File created successfully" }] } });
    fs.writeFileSync(tr, useRow + "\n" + resultRow + "\n"); // a save counts once its result is in the transcript
    const scenario = { OMC_JEV_STOP_PROGRESS: "1" };
    const r1 = runHook(scenario, sid, { transcript_path: tr });
    expect(r1.status).toBe(0);
    const o1 = json(r1);
    expect(o1.decision).toBe("block");
    const parts1 = (readState(root, sid).stopProgress as Record<string, unknown>).parts as Record<string, unknown>;
    expect(String(parts1.git)).toContain("session-file.md");
    fs.writeFileSync(path.join(PROJECT, "other.md"), "z\n");
    for (let i = 2; i <= 7; i++) {
      const ri = (i === 4 || i === 5)
        ? runHook({ ...scenario, PATH: "/no-such-directory" }, sid, { transcript_path: writeTranscript(sid) })
        : runHook(scenario, sid, { transcript_path: writeTranscript(sid) });
      expect(ri.status).toBe(0);
      expect(json(ri).decision).toBe("block");
    }
    const r8 = runHook(scenario, sid, { transcript_path: writeTranscript(sid) });
    expect(r8.status).toBe(0);
    const o8 = json(r8);
    expect(o8.continue).toBe(true);
    expect(String(o8.systemMessage ?? "")).toMatch(/after 7 Stop blocks without progress/);
    spawnSync("git", ["add", "session-file.md"], { cwd: PROJECT });
    const r9 = runHook(scenario, sid, { transcript_path: writeTranscript(sid) });
    expect(r9.status).toBe(0);
    expect(json(r9).decision).toBe("block");
    expect((readState(await stateRoot(), sid).stopProgress as Record<string, unknown>).blocks).toBe(0);
  });

  it("re-entry with the switch on keeps the dev block when the named workflow advances and releases with the message otherwise", async () => {
    const sid = "reentry-workflow";
    spawnSync("git", ["init", "-q", PROJECT]);
    const root = await stateRoot();
    const transcript = path.join(HOME_DIR, ".claude", "projects", sid + ".jsonl");
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, "");
    const st = fs.lstatSync(transcript, { bigint: true });
    const descriptor = { descriptorVersion: 1, profileVersion: 1, stages: ["ralplan", "execution"], workflowName: "release-flow" };
    const now = new Date().toISOString();
    const stages = descriptor.stages.map((id, i) => ({ id, status: i === 0 ? "active" : "pending", iterations: 0, ...(i === 0 ? { startedAt: now } : {}) }));
    const boundary = { transcriptPath: transcript, transcriptRoot: path.dirname(transcript), transcriptBasename: sid + ".jsonl", sessionId: sid, byteOffset: 0, fileIdentity: { device: Number(st.dev), inode: Number(st.ino), size: 0, mtimeNs: st.mtimeNs.toString(), ctimeNs: st.ctimeNs.toString(), contentSha256: createHash("sha256").update("").digest("hex") } };
    const state = { active: true, mode: "autopilot", prompt: "ship the release", phase: "ralplan", directory: PROJECT, project_path: PROJECT, session_id: sid, workflowRunId: "11111111-1111-4111-8111-111111111111", started_at: now, updated_at: now, last_checked_at: now, workflow: { ...descriptor, profileHash: createHash("sha256").update(JSON.stringify(descriptor)).digest("hex") }, pipelineTracking: { stages, currentStageIndex: 0, trackingRevision: 0, activationBoundary: boundary, completionObservations: [] } };
    const dir = path.join(root, "state", "sessions", sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "autopilot-state.json"), JSON.stringify(state));
    const scenario = { OMC_JEV_STOP_PROGRESS: "1" };
    const released = json(runHook(scenario, sid, { transcript_path: transcript, stop_hook_active: true }));
    expect(released.continue).toBe(true);
    expect(String(released.systemMessage ?? "")).toMatch(/stop_hook_active/);
    fs.appendFileSync(transcript, JSON.stringify({ sessionId: sid, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Signal: PIPELINE_RALPLAN_COMPLETE" }] } }) + "\n");
    const advanced = json(runHook(scenario, sid, { transcript_path: transcript, stop_hook_active: true }));
    expect(advanced.decision).toBe("block");
    expect(advanced.continue).toBeUndefined();
    expect(advanced.systemMessage).toBeUndefined();
  });
});

describe("persistent-mode Stop rows and the provider process", () => {
  const journalRows = (sid: string): Record<string, unknown>[] => {
    const file = path.join(TMP, "logs", "denials.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.session_id === sid);
  };
  // The schema validator of the journal reader tool: the rows the hook writes have to pass it.
  const validateRow = async (): Promise<(row: Record<string, unknown>) => { ok: boolean; errors: string[] }> =>
    (await import(pathToFileURL(path.join(WORKTREE, "tools", "diagnostics", "denial_log_summary.mjs")).href)).validateRow;
  const SWITCH: Record<string, string> = { OMC_JEV_STOP_PROGRESS: "1" };
  const PROVIDER: Record<string, string> = { OMC_JEV_STOP_PROGRESS: "1", OMC_PROVIDER: "acme" };
  const pastThreshold = { stopProgress: { hash: "", blocks: 6, ts: 0, progress: {}, totalBlocks: 6, parts: { git: "", ledger: "" } } };

  it("writes a release row and an end row when the seventh block without progress releases the Stop", async () => {
    const sid = "rows-release";
    const root = await writeState(sid);
    let last: Record<string, unknown> = {};
    for (let i = 1; i <= 7; i++) last = json(runHook(SWITCH, sid, { transcript_path: writeTranscript(sid) }));
    expect(last.continue).toBe(true);
    expect(String(last.systemMessage ?? "")).toMatch(/Stop released after 7 Stop blocks without progress/);
    const rows = journalRows(sid);
    const release = rows.find((row) => row.kind === "release" && row.action === "stop-progress-release");
    const end = rows.find((row) => row.kind === "end" && row.action === "step-budget");
    expect(release).toMatchObject({ guard: "ultragoal-stop", reason_code: "timeout", n: 7, k: 7, maxSession: 50, result: "passed", agent_id: null });
    expect(end).toMatchObject({ guard: "ultragoal-stop", reason_code: "stop_release", sessionCount: 7, result: "passed" });
    expect(rows).toHaveLength(2);
    expect((readState(root, sid).stopProgress as Record<string, unknown>).blocks).toBe(7);
    for (const row of rows) expect((await validateRow())(row), JSON.stringify(row)).toEqual({ ok: true, errors: [] });
  });

  it("writes the release and end rows for an acknowledged blocked exit, for an ordinary and a provider process", async () => {
    for (const scenario of [SWITCH, PROVIDER]) {
      const sid = "rows-ack-" + (scenario.OMC_PROVIDER ?? "plain");
      await writeState(sid);
      const o = json(runHook(scenario, sid, { transcript_path: writeTranscript(sid), last_assistant_message: "BLOCKED: no access to the production server and its API key" }));
      expect(o.continue).toBe(true);
      expect(String(o.systemMessage ?? "")).toMatch(/acknowledged blocked exit/);
      const rows = journalRows(sid);
      expect(rows.find((row) => row.kind === "release")).toMatchObject({ action: "stop-acknowledged-exit", guard: "ultragoal-stop", reason_code: "stop_release" });
      expect(rows.find((row) => row.kind === "end")).toMatchObject({ action: "blocked-with-reason", guard: "ultragoal-stop" });
      expect(rows).toHaveLength(2);
      for (const row of rows) expect((await validateRow())(row), JSON.stringify(row)).toEqual({ ok: true, errors: [] });
    }
  });

  it("writes the step-limit rows when an ordinary block reaches the reinforcement ceiling", async () => {
    const sid = "rows-ceiling";
    await writeState(sid, { reinforcement_count: 50 });
    const o = json(runHook(SWITCH, sid, { transcript_path: writeTranscript(sid) }));
    expect(o.continue).toBe(true);
    expect(String(o.systemMessage ?? "")).toMatch(/limit of 50 ultragoal reinforcements is exhausted \(block 51\)/);
    const rows = journalRows(sid);
    expect(rows.find((row) => row.kind === "release")).toMatchObject({ action: "stop-step-limit", reason_code: "timeout", maxSession: 50 });
    expect(rows.find((row) => row.kind === "end")).toMatchObject({ action: "step-budget" });
    for (const row of rows) expect((await validateRow())(row), JSON.stringify(row)).toEqual({ ok: true, errors: [] });
  });

  it("a provider process gets the blocked text at the seventh block instead of a release, and the series is saved past the threshold", async () => {
    const sid = "provider-series";
    const root = await writeState(sid);
    let last: Record<string, unknown> = {};
    for (let i = 1; i <= 7; i++) last = json(runHook(PROVIDER, sid, { transcript_path: writeTranscript(sid) }));
    expect(last.decision).toBe("block");
    expect(last.continue).toBeUndefined();
    expect(String(last.reason ?? "")).toMatch(/^\[ULTRAGOAL: BLOCKED\] 7 Stop blocks without progress/);
    expect(String(last.reason ?? "")).toContain("BLOCKED: <reason, at least 20 characters>");
    const state = readState(root, sid);
    expect((state.stopProgress as Record<string, unknown>).blocks).toBe(7);
    expect(state.reinforcement_count).toBe(7);
    expect(journalRows(sid).some((row) => row.action === "stop-progress-release")).toBe(false);
  });

  it("the series of a provider process ends at the reinforcement ceiling: the last block counts, the next one releases with the step-limit rows", async () => {
    const sid = "provider-ceiling";
    const root = await writeState(sid, { reinforcement_count: 49, ...pastThreshold });
    const blocked = json(runHook(PROVIDER, sid, { transcript_path: writeTranscript(sid) }));
    expect(blocked.decision).toBe("block");
    expect(String(blocked.reason ?? "")).toMatch(/^\[ULTRAGOAL: BLOCKED\] 7 Stop blocks without progress/);
    expect(readState(root, sid).reinforcement_count).toBe(50);
    const released = json(runHook(PROVIDER, sid, { transcript_path: writeTranscript(sid) }));
    expect(released.continue).toBe(true);
    expect(released.decision).toBeUndefined();
    expect(String(released.systemMessage ?? "")).toMatch(/limit of 50 ultragoal reinforcements is exhausted \(block 51\)/);
    const rows = journalRows(sid);
    expect(rows.find((row) => row.kind === "release")).toMatchObject({ action: "stop-step-limit", reason_code: "timeout", sessionCount: 8 });
    expect(rows.find((row) => row.kind === "end")).toMatchObject({ action: "step-budget" });
    expect(readState(root, sid).reinforcement_count).toBe(50);
  });

  it("the same past-threshold state releases an ordinary process with the progress release rows (the marker is the only difference)", async () => {
    const sid = "plain-past-threshold";
    await writeState(sid, { reinforcement_count: 49, ...pastThreshold });
    const o = json(runHook(SWITCH, sid, { transcript_path: writeTranscript(sid) }));
    expect(o.continue).toBe(true);
    expect(String(o.systemMessage ?? "")).toMatch(/Stop released after 7 Stop blocks without progress/);
    expect(journalRows(sid).find((row) => row.kind === "release")).toMatchObject({ action: "stop-progress-release", n: 7 });
  });

  it("without OMC_JEV_STOP_PROGRESS the provider marker changes nothing: the plain upstream block, no progress state, no rows", async () => {
    const sid = "rows-off";
    const root = await writeState(sid);
    for (let i = 1; i <= 8; i++) {
      const o = json(runHook({ OMC_PROVIDER: "acme" }, sid, { transcript_path: writeTranscript(sid), last_assistant_message: "BLOCKED: no access to the production server and its API key" }));
      expect(o.decision).toBe("block");
      expect(String(o.reason ?? "")).toMatch(new RegExp("^\\[ULTRAGOAL #" + i + "\\/50\\]"));
    }
    const state = readState(root, sid);
    expect(state.reinforcement_count).toBe(8);
    expect("stopProgress" in state).toBe(false);
    expect(journalRows(sid)).toEqual([]);
  });
});
