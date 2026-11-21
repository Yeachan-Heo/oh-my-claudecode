import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
});
