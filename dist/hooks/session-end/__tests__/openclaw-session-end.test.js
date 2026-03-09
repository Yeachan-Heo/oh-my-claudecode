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
vi.mock("../../../features/auto-update.js", () => ({
    getOMCConfig: vi.fn(() => ({})),
}));
vi.mock("../../../notifications/config.js", () => ({
    buildConfigFromEnv: vi.fn(() => null),
    getEnabledPlatforms: vi.fn(() => []),
    getNotificationConfig: vi.fn(() => null),
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
import { _openclaw, processHook } from "../../bridge.js";
import { processSessionEnd } from "../index.js";
import { wakeOpenClaw } from "../../../openclaw/index.js";
describe("session-end OpenClaw behavior (issue #1456)", () => {
    let tmpDir;
    let transcriptPath;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-session-end-claw-"));
        transcriptPath = path.join(tmpDir, "transcript.jsonl");
        // Write a minimal transcript so processSessionEnd doesn't fail
        fs.writeFileSync(transcriptPath, JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "done" }] },
        }), "utf-8");
        vi.clearAllMocks();
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });
    it("wakes OpenClaw from the bridge during session-end when OMC_OPENCLAW=1", async () => {
        process.env.OMC_OPENCLAW = "1";
        const wakeSpy = vi.spyOn(_openclaw, "wake");
        await processHook("session-end", {
            session_id: "session-claw-1",
            transcript_path: transcriptPath,
            cwd: tmpDir,
            permission_mode: "default",
            hook_event_name: "SessionEnd",
            reason: "clear",
        });
        expect(wakeSpy).toHaveBeenCalledWith("session-end", expect.objectContaining({
            sessionId: "session-claw-1",
            projectPath: tmpDir,
            reason: "clear",
        }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(wakeOpenClaw).toHaveBeenCalledWith("session-end", expect.objectContaining({
            sessionId: "session-claw-1",
            projectPath: tmpDir,
            reason: "clear",
        }));
    });
    it("does not call wakeOpenClaw directly when processSessionEnd is invoked without the bridge", async () => {
        process.env.OMC_OPENCLAW = "1";
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
    it("does not call wakeOpenClaw when OMC_OPENCLAW is not set", async () => {
        delete process.env.OMC_OPENCLAW;
        await processHook("session-end", {
            session_id: "session-claw-3",
            transcript_path: transcriptPath,
            cwd: tmpDir,
            permission_mode: "default",
            hook_event_name: "SessionEnd",
            reason: "clear",
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(wakeOpenClaw).not.toHaveBeenCalled();
    });
    it("does not throw even if wakeOpenClaw mock is configured to reject", async () => {
        process.env.OMC_OPENCLAW = "1";
        vi.mocked(wakeOpenClaw).mockRejectedValueOnce(new Error("gateway down"));
        await expect(processHook("session-end", {
            session_id: "session-claw-4",
            transcript_path: transcriptPath,
            cwd: tmpDir,
            permission_mode: "default",
            hook_event_name: "SessionEnd",
            reason: "clear",
        })).resolves.toBeDefined();
    });
});
//# sourceMappingURL=openclaw-session-end.test.js.map