import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// Mock persistent-mode so we can control shouldSendIdleNotification
vi.mock("../persistent-mode/index.js", () => ({
    checkPersistentModes: vi.fn().mockResolvedValue({ mode: "none", message: "" }),
    createHookOutput: vi.fn().mockReturnValue({ continue: true }),
    shouldWakeOpenClawOnStop: vi.fn().mockReturnValue(true),
    shouldSendIdleNotification: vi.fn().mockReturnValue(false), // cooldown ACTIVE — gate closed
    recordIdleNotificationSent: vi.fn(),
    getIdleNotificationCooldownSeconds: vi.fn().mockReturnValue(60),
}));
vi.mock("../todo-continuation/index.js", () => ({
    isExplicitCancelCommand: vi.fn().mockReturnValue(false),
    isAuthenticationError: vi.fn().mockReturnValue(false),
}));
import { _openclaw, processHook, resetSkipHooksCache } from "../bridge.js";
import * as persistentMode from "../persistent-mode/index.js";
describe("stop hook OpenClaw cooldown bypass (issue #1120)", () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-stop-claw-"));
        // git init so resolveToWorktreeRoot returns this directory
        execSync("git init", { cwd: tmpDir, stdio: "ignore" });
        resetSkipHooksCache();
        vi.mocked(persistentMode.shouldWakeOpenClawOnStop).mockReturnValue(true);
        delete process.env.DISABLE_OMC;
        delete process.env.OMC_SKIP_HOOKS;
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        resetSkipHooksCache();
    });
    it("calls _openclaw.wake('stop') even when shouldSendIdleNotification returns false", async () => {
        process.env.OMC_OPENCLAW = "1";
        const wakeSpy = vi.spyOn(_openclaw, "wake");
        const input = {
            sessionId: "test-session-123",
            directory: tmpDir,
        };
        await processHook("persistent-mode", input);
        // OpenClaw stop should fire regardless of notification cooldown
        expect(wakeSpy).toHaveBeenCalledWith("stop", expect.objectContaining({
            sessionId: "test-session-123",
        }));
        wakeSpy.mockRestore();
    });
    it("does NOT call _openclaw.wake('stop') when user_requested abort", async () => {
        process.env.OMC_OPENCLAW = "1";
        const wakeSpy = vi.spyOn(_openclaw, "wake");
        const input = {
            sessionId: "test-session-456",
            directory: tmpDir,
            // Simulate user-requested abort
        };
        input.user_requested = true;
        await processHook("persistent-mode", input);
        // OpenClaw stop should NOT fire for user aborts
        const stopCall = wakeSpy.mock.calls.find((call) => call[0] === "stop");
        expect(stopCall).toBeUndefined();
        wakeSpy.mockRestore();
    });
    it("suppresses _openclaw.wake('stop') for unchanged zero-backlog repo state even when idle notification cooldown is bypassed", async () => {
        process.env.OMC_OPENCLAW = "1";
        vi.mocked(persistentMode.shouldWakeOpenClawOnStop).mockReturnValue(false);
        const wakeSpy = vi.spyOn(_openclaw, "wake");
        const input = {
            sessionId: "test-session-789",
            directory: tmpDir,
        };
        await processHook("persistent-mode", input);
        const stopCall = wakeSpy.mock.calls.find((call) => call[0] === "stop");
        expect(stopCall).toBeUndefined();
        wakeSpy.mockRestore();
    });
});
//# sourceMappingURL=stop-hook-openclaw-cooldown.test.js.map