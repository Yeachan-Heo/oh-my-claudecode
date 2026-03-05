import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("../callbacks.js", () => ({
  triggerStopCallbacks: vi.fn(async () => undefined),
}));

vi.mock("../../../notifications/index.js", () => ({
  notify: vi.fn(async () => undefined),
}));

vi.mock("../../../tools/python-repl/bridge-manager.js", () => ({
  cleanupBridgeSessions: vi.fn(async () => ({
    requestedSessions: 0,
    foundSessions: 0,
    terminatedSessions: 0,
    errors: [],
  })),
}));

vi.mock("../../../openclaw/index.js", () => ({
  wakeOpenClaw: vi.fn().mockResolvedValue({ gateway: "test", success: true }),
}));

import { processSessionEnd } from "../index.js";
import { wakeOpenClaw } from "../../../openclaw/index.js";
import { notify } from "../../../notifications/index.js";

describe("session-end OpenClaw behavior (issue #1120)", () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-session-end-claw-"));
    transcriptPath = path.join(tmpDir, "transcript.jsonl");
    // Write a minimal transcript so processSessionEnd doesn't fail
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }] },
      }),
      "utf-8",
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does not call wakeOpenClaw directly during session-end when OMC_OPENCLAW=1", async () => {
    process.env.OMC_OPENCLAW = "1";

    await processSessionEnd({
      session_id: "session-claw-1",
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: "default",
      hook_event_name: "SessionEnd",
      reason: "clear",
    });

    // Session-end dispatches the standard notification and does not directly call OpenClaw.
    expect(wakeOpenClaw).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "session-end",
      expect.objectContaining({
        sessionId: "session-claw-1",
        projectPath: tmpDir,
      }),
    );
  });

  it("does not call wakeOpenClaw when OMC_OPENCLAW is not set", async () => {
    delete process.env.OMC_OPENCLAW;

    await processSessionEnd({
      session_id: "session-claw-2",
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: "default",
      hook_event_name: "SessionEnd",
      reason: "clear",
    });

    expect(wakeOpenClaw).not.toHaveBeenCalled();
  });

  it("does not throw even if wakeOpenClaw mock is configured to reject", async () => {
    process.env.OMC_OPENCLAW = "1";
    vi.mocked(wakeOpenClaw).mockRejectedValueOnce(new Error("gateway down"));

    // Should not throw; wakeOpenClaw is not invoked from processSessionEnd.
    await expect(
      processSessionEnd({
        session_id: "session-claw-3",
        transcript_path: transcriptPath,
        cwd: tmpDir,
        permission_mode: "default",
        hook_event_name: "SessionEnd",
        reason: "clear",
      }),
    ).resolves.toBeDefined();
  });
});
