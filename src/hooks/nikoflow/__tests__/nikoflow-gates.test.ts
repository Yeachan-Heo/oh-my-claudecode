import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectNikoflowGate } from "../gates.js";
import {
  createNikoflowLoopHook,
  readNikoflowState,
  mintGateRequest,
  rotateGateRequest,
  clearGateRequest,
  recordNikoflowUserPrompt,
  userRepliedAfterMint,
} from "../index.js";

describe("nikoflow gate detection (TSK-003)", () => {
  const RID = "11111111-2222-3333-4444-555555555555";

  it("matches a valid correlated tag", () => {
    const t = `blah <nikoflow-gate phase="interview" request-id="${RID}">CONFIRMED</nikoflow-gate> ok`;
    expect(detectNikoflowGate(t, { phase: "interview", requestId: RID })).toMatchObject({ matched: true });
  });

  it("rejects a wrong phase", () => {
    const t = `<nikoflow-gate phase="prd" request-id="${RID}">SEAMS_CONFIRMED</nikoflow-gate>`;
    expect(detectNikoflowGate(t, { phase: "interview", requestId: RID }).matched).toBe(false);
  });

  it("rejects a wrong payload", () => {
    const t = `<nikoflow-gate phase="interview" request-id="${RID}">NOPE</nikoflow-gate>`;
    expect(detectNikoflowGate(t, { phase: "interview", requestId: RID }).matched).toBe(false);
  });

  it("rejects a mismatched request-id (stale tag from a previous gate)", () => {
    const t = `<nikoflow-gate phase="interview" request-id="old-id">CONFIRMED</nikoflow-gate>`;
    expect(detectNikoflowGate(t, { phase: "interview", requestId: RID }).matched).toBe(false);
  });

  it("ignores a code-fenced example tag", () => {
    const t = "Emit \`<nikoflow-gate phase=\"interview\" request-id=\"" + RID + "\">CONFIRMED</nikoflow-gate>\` when done";
    expect(detectNikoflowGate(t, { phase: "interview", requestId: RID }).matched).toBe(false);
  });

  it("ignores a tag sitting inside our own injected continuation block", () => {
    const t =
      `<nikoflow-continuation phase="interview">... emit ` +
      `<nikoflow-gate phase="interview" request-id="${RID}">CONFIRMED</nikoflow-gate> ...` +
      `</nikoflow-continuation>`;
    expect(detectNikoflowGate(t, { phase: "interview", requestId: RID }).matched).toBe(false);
  });

  it("ignores a live-looking tag inside a fenced code block (F6)", () => {
    const t = "```\n<nikoflow-gate phase=\"interview\" request-id=\"" + RID + "\">CONFIRMED</nikoflow-gate>\n```";
    expect(detectNikoflowGate(t, { phase: "interview", requestId: RID }).matched).toBe(false);
  });

  it("rejects a negated payload (NOT_CONFIRMED ≠ CONFIRMED) (F5)", () => {
    const t = `<nikoflow-gate phase="interview" request-id="${RID}">NOT_CONFIRMED</nikoflow-gate>`;
    expect(detectNikoflowGate(t, { phase: "interview", requestId: RID }).matched).toBe(false);
  });

  it("rejects a verbatim depth template copy without a concrete tier (F4)", () => {
    const t = `<nikoflow-gate phase="depth" depth="tactical|standard|deep" request-id="${RID}">CONFIRMED</nikoflow-gate>`;
    expect(detectNikoflowGate(t, { phase: "depth", requestId: RID }).matched).toBe(false);
  });

  it("extracts the confirmed depth for the depth gate", () => {
    const t = `<nikoflow-gate phase="depth" depth="deep" request-id="${RID}">CONFIRMED</nikoflow-gate>`;
    expect(detectNikoflowGate(t, { phase: "depth", requestId: RID })).toMatchObject({ matched: true, depth: "deep" });
  });

  it("a <nikoflow-blocked> sibling does not swallow a following real gate (audit F1)", () => {
    const t =
      `<nikoflow-gate-blocked>oops</nikoflow-gate-blocked>\n` +
      `<nikoflow-gate phase="tickets" request-id="${RID}">APPROVED</nikoflow-gate>`;
    expect(detectNikoflowGate(t, { phase: "tickets", requestId: RID }).matched).toBe(true);
  });

  it("a hyphenated lookalike attribute does not shadow the real request-id (audit F2)", () => {
    const t = `<nikoflow-gate x-request-id="fake" phase="tickets" request-id="${RID}">APPROVED</nikoflow-gate>`;
    expect(detectNikoflowGate(t, { phase: "tickets", requestId: RID }).matched).toBe(true);
  });

  it("a score with trailing junk stays within range or is rejected (audit F6 boundary)", () => {
    // parseFloat("0.5") = 0.5 < 1 → out of scale → no score set → not a pass
    const t = `<nikoflow-gate phase="verify" score="0.5" request-id="${RID}">VERIFIED</nikoflow-gate>`;
    const m = detectNikoflowGate(t, { phase: "verify", requestId: RID });
    expect(m.matched).toBe(true);
    expect(m.score).toBeUndefined(); // 0.5 below the 1–10 scale → ignored
  });

  it("adr gate accepts RECORDED or SKIPPED", () => {
    const rec = `<nikoflow-gate phase="adr" request-id="${RID}">RECORDED</nikoflow-gate>`;
    const skip = `<nikoflow-gate phase="adr" request-id="${RID}">SKIPPED</nikoflow-gate>`;
    expect(detectNikoflowGate(rec, { phase: "adr", requestId: RID }).matched).toBe(true);
    expect(detectNikoflowGate(skip, { phase: "adr", requestId: RID }).matched).toBe(true);
  });
});

describe("nikoflow anti-self-approval (TSK-003)", () => {
  let dir: string;
  const sid = "sess-gate-1";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nikoflow-gate-"));
    createNikoflowLoopHook(dir).startLoop(sid, "do the work");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("mints a stable id per gate and re-mints when the gate changes", () => {
    const a = mintGateRequest(dir, "depth", sid);
    const b = mintGateRequest(dir, "depth", sid);
    expect(a).toBe(b); // stable while the gate is unchanged
    const c = mintGateRequest(dir, "interview", sid);
    expect(c).not.toBe(a); // fresh id when the gate changes
  });

  it("userRepliedAfterMint is false until a user turn arrives after the mint", async () => {
    mintGateRequest(dir, "depth", sid);
    expect(userRepliedAfterMint(readNikoflowState(dir, sid)!, dir, sid)).toBe(false);
    await new Promise((r) => setTimeout(r, 3)); // ensure a strictly-later reply timestamp
    recordNikoflowUserPrompt(dir, sid);
    expect(userRepliedAfterMint(readNikoflowState(dir, sid)!, dir, sid)).toBe(true);
  });

  it("rotateGateRequest invalidates a premature tag's request-id (F1)", () => {
    const original = mintGateRequest(dir, "depth", sid);
    // model emitted a tag carrying `original` before any user turn
    const rotated = rotateGateRequest(dir, "depth", sid);
    expect(rotated).not.toBe(original);
    // the stale tag no longer correlates with the active request-id
    const staleTag = `<nikoflow-gate phase="depth" depth="deep" request-id="${original}">CONFIRMED</nikoflow-gate>`;
    expect(detectNikoflowGate(staleTag, { phase: "depth", requestId: rotated! }).matched).toBe(false);
  });

  it("a user turn BEFORE the mint does not satisfy the check (no self-approval via stale reply)", async () => {
    recordNikoflowUserPrompt(dir, sid); // user talked earlier (sidecar stamp)
    await new Promise((r) => setTimeout(r, 3)); // mint strictly after the earlier turn
    mintGateRequest(dir, "depth", sid);
    const after = readNikoflowState(dir, sid)!;
    expect(userRepliedAfterMint(after, dir, sid)).toBe(false);
  });

  it("clearGateRequest wipes the correlation", () => {
    mintGateRequest(dir, "depth", sid);
    clearGateRequest(dir, sid);
    const s = readNikoflowState(dir, sid)!;
    expect(s.request_id).toBeUndefined();
    expect(s.awaiting_gate).toBeUndefined();
  });
});
