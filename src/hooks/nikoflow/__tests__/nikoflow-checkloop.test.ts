import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import {
  createNikoflowLoopHook,
  readNikoflowState,
  recordNikoflowUserPrompt,
} from "../index.js";
import { checkNikoflowLoop } from "../../persistent-mode/index.js";

// Orchestration-level tests for checkNikoflowLoop — the function that carries the
// human-gate anti-self-approval enforcement. Guards against the mutation Fable
// flagged: dropping the `humanOk` check would let a model self-confirm a human
// gate with zero user turn, and NOTHING below this file exercised that path.

function writeTranscript(path: string, text: string): void {
  writeFileSync(
    path,
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n",
  );
}
const gate = (rid: string, depth = "standard") =>
  `<nikoflow-gate phase="depth" depth="${depth}" request-id="${rid}">CONFIRMED</nikoflow-gate>`;

describe("checkNikoflowLoop human-gate enforcement (anti-self-approval)", () => {
  let dir: string;
  const sid = "sess-checkloop";
  let transcript: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nikoflow-cl-"));
    // git-init so resolveToWorktreeRoot (inside checkNikoflowLoop) and mode-state-io
    // both resolve to the same root — matching how the hook runs in a real repo.
    execSync("git init -q", { cwd: dir });
    transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, "");
    createNikoflowLoopHook(dir).startLoop(sid, "build a feature");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = () => checkNikoflowLoop(sid, dir, false, transcript);

  it("blocks at depth-selection on first Stop and mints a request-id", async () => {
    const r = await run();
    expect(r?.mode).toBe("nikoflow");
    expect(r?.message).toContain("depth not yet chosen");
    expect(readNikoflowState(dir, sid)!.request_id).toBeTruthy();
    expect(readNikoflowState(dir, sid)!.depth).toBeNull();
  });

  it("does NOT advance a human gate when the tag has NO user turn after the mint", async () => {
    await run(); // mint depth rid
    const rid = readNikoflowState(dir, sid)!.request_id!;
    // model self-emits the confirmation with NO recordNikoflowUserPrompt
    writeTranscript(transcript, gate(rid));
    await run();
    // depth stays null → gate did not pass (this is the mutation-1 guard)
    expect(readNikoflowState(dir, sid)!.depth).toBeNull();
    // and the premature tag's request-id was rotated
    expect(readNikoflowState(dir, sid)!.request_id).not.toBe(rid);
  });

  it("advances the human gate ONLY after a real user turn + correlated tag", async () => {
    await run(); // mint
    // premature self-emit → rotation (no user turn)
    writeTranscript(transcript, gate(readNikoflowState(dir, sid)!.request_id!));
    await run();
    // now a genuine user turn (sidecar), then the model re-emits with the fresh rid
    await new Promise((r) => setTimeout(r, 3));
    recordNikoflowUserPrompt(dir, sid);
    const freshRid = readNikoflowState(dir, sid)!.request_id!;
    writeTranscript(transcript, gate(freshRid));
    await run();
    const s = readNikoflowState(dir, sid)!;
    expect(s.depth).toBe("standard");
    expect(s.phases).toContain("interview");
  });

  it("stays inactive-safe: no state → returns null (does not block)", async () => {
    const r = await checkNikoflowLoop("other-session", dir, false, transcript);
    expect(r).toBeNull();
  });
});
