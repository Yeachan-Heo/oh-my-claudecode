import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { createHookOutput, checkPersistentModes, } from "./index.js";
import { activateUltrawork, deactivateUltrawork } from "../ultrawork/index.js";
describe("Stop Hook Blocking Contract", () => {
    describe("createHookOutput", () => {
        it("returns continue: false when shouldBlock is true", () => {
            const result = {
                shouldBlock: true,
                message: "Continue working",
                mode: "ralph",
            };
            const output = createHookOutput(result);
            expect(output.continue).toBe(false);
            expect(output.message).toBe("Continue working");
        });
        it("returns continue: true when shouldBlock is false", () => {
            const result = {
                shouldBlock: false,
                message: "",
                mode: "none",
            };
            const output = createHookOutput(result);
            expect(output.continue).toBe(true);
        });
        it("returns continue: true when shouldBlock is false with message", () => {
            const result = {
                shouldBlock: false,
                message: "[RALPH LOOP COMPLETE] Done!",
                mode: "none",
            };
            const output = createHookOutput(result);
            expect(output.continue).toBe(true);
            expect(output.message).toBe("[RALPH LOOP COMPLETE] Done!");
        });
        it("returns continue: false for ultrawork mode blocking", () => {
            const result = {
                shouldBlock: true,
                message: "[ULTRAWORK] Mode active.",
                mode: "ultrawork",
                metadata: { reinforcementCount: 3 },
            };
            const output = createHookOutput(result);
            expect(output.continue).toBe(false);
            expect(output.message).toContain("ULTRAWORK");
        });
        it("returns continue: false for autopilot mode blocking", () => {
            const result = {
                shouldBlock: true,
                message: "[AUTOPILOT] Continue working",
                mode: "autopilot",
                metadata: { phase: "execution" },
            };
            const output = createHookOutput(result);
            expect(output.continue).toBe(false);
        });
        it("returns undefined message when result message is empty", () => {
            const result = {
                shouldBlock: false,
                message: "",
                mode: "none",
            };
            const output = createHookOutput(result);
            expect(output.message).toBeUndefined();
        });
    });
    describe("checkPersistentModes -> createHookOutput integration", () => {
        let tempDir;
        beforeEach(() => {
            tempDir = mkdtempSync(join(tmpdir(), "stop-hook-blocking-test-"));
            execSync("git init", { cwd: tempDir });
        });
        afterEach(() => {
            rmSync(tempDir, { recursive: true, force: true });
        });
        it("blocks stop for active ultrawork (shouldBlock: true -> continue: false)", async () => {
            const sessionId = "test-session-block";
            activateUltrawork("Fix the bug", sessionId, tempDir);
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            const output = createHookOutput(result);
            expect(output.continue).toBe(false);
            expect(output.message).toBeDefined();
        });
        it("allows stop for deactivated ultrawork (shouldBlock: false -> continue: true)", async () => {
            const sessionId = "test-session-allow";
            activateUltrawork("Task complete", sessionId, tempDir);
            deactivateUltrawork(tempDir, sessionId);
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            const output = createHookOutput(result);
            expect(output.continue).toBe(true);
        });
        it("allows stop when no active modes (shouldBlock: false -> continue: true)", async () => {
            const result = await checkPersistentModes("any-session", tempDir);
            expect(result.shouldBlock).toBe(false);
            const output = createHookOutput(result);
            expect(output.continue).toBe(true);
        });
        it("allows stop for context limit even with active mode", async () => {
            const sessionId = "test-context-limit";
            activateUltrawork("Important task", sessionId, tempDir);
            const stopContext = {
                stop_reason: "context_limit",
            };
            const result = await checkPersistentModes(sessionId, tempDir, stopContext);
            expect(result.shouldBlock).toBe(false);
            const output = createHookOutput(result);
            expect(output.continue).toBe(true);
        });
        it("allows stop for user abort even with active mode", async () => {
            const sessionId = "test-user-abort";
            activateUltrawork("Important task", sessionId, tempDir);
            const stopContext = {
                user_requested: true,
            };
            const result = await checkPersistentModes(sessionId, tempDir, stopContext);
            expect(result.shouldBlock).toBe(false);
            const output = createHookOutput(result);
            expect(output.continue).toBe(true);
        });
        it("allows stop for rate limit even with active mode", async () => {
            const sessionId = "test-rate-limit";
            activateUltrawork("Important task", sessionId, tempDir);
            const stopContext = {
                stop_reason: "rate_limit",
            };
            const result = await checkPersistentModes(sessionId, tempDir, stopContext);
            expect(result.shouldBlock).toBe(false);
            const output = createHookOutput(result);
            expect(output.continue).toBe(true);
        });
        it("blocks stop for active ralph loop", async () => {
            const sessionId = "test-ralph-block";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ralph-state.json"), JSON.stringify({
                active: true,
                iteration: 1,
                max_iterations: 50,
                session_id: sessionId,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
                prompt: "Test ralph task",
            }));
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe("ralph");
            const output = createHookOutput(result);
            expect(output.continue).toBe(false);
            expect(output.message).toContain("RALPH");
        });
        it("blocks stop for active skill state", async () => {
            const sessionId = "test-skill-block";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "skill-active-state.json"), JSON.stringify({
                active: true,
                skill_name: "ralplan",
                session_id: sessionId,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
                reinforcement_count: 0,
                max_reinforcements: 5,
                stale_ttl_ms: 15 * 60 * 1000,
            }));
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            const output = createHookOutput(result);
            expect(output.continue).toBe(false);
            expect(output.message).toContain("ralplan");
        });
    });
    describe("persistent-mode.mjs script blocking contract", () => {
        let tempDir;
        const scriptPath = join(process.cwd(), "scripts", "persistent-mode.mjs");
        function runScript(input) {
            try {
                const result = execSync(`node "${scriptPath}"`, {
                    encoding: "utf-8",
                    timeout: 5000,
                    input: JSON.stringify(input),
                    env: { ...process.env, NODE_ENV: "test" },
                });
                const lines = result.trim().split("\n");
                return JSON.parse(lines[lines.length - 1]);
            }
            catch (error) {
                const execError = error;
                if (execError.stdout) {
                    const lines = execError.stdout.trim().split("\n");
                    return JSON.parse(lines[lines.length - 1]);
                }
                throw error;
            }
        }
        beforeEach(() => {
            tempDir = mkdtempSync(join(tmpdir(), "stop-hook-mjs-test-"));
            execSync("git init", { cwd: tempDir });
        });
        afterEach(() => {
            rmSync(tempDir, { recursive: true, force: true });
        });
        it("returns continue: false when ralph is active", () => {
            const sessionId = "ralph-mjs-test";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ralph-state.json"), JSON.stringify({
                active: true,
                iteration: 1,
                max_iterations: 50,
                session_id: sessionId,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
                prompt: "Test task",
            }));
            const output = runScript({ directory: tempDir, sessionId });
            expect(output.continue).toBe(false);
            expect(output.decision).toBe("block");
        });
        it("returns continue: false when ultrawork is active", () => {
            const sessionId = "ultrawork-mjs-test";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ultrawork-state.json"), JSON.stringify({
                active: true,
                started_at: new Date().toISOString(),
                original_prompt: "Test task",
                session_id: sessionId,
                reinforcement_count: 0,
                last_checked_at: new Date().toISOString(),
            }));
            const output = runScript({ directory: tempDir, sessionId });
            expect(output.continue).toBe(false);
            expect(output.decision).toBe("block");
        });
        it("returns continue: true for context limit stop", () => {
            const sessionId = "ctx-limit-mjs";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ralph-state.json"), JSON.stringify({
                active: true,
                iteration: 1,
                max_iterations: 50,
                session_id: sessionId,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
            }));
            const output = runScript({
                directory: tempDir,
                sessionId,
                stop_reason: "context_limit",
            });
            expect(output.continue).toBe(true);
        });
        it("returns continue: true for user abort", () => {
            const sessionId = "abort-mjs";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ralph-state.json"), JSON.stringify({
                active: true,
                iteration: 1,
                max_iterations: 50,
                session_id: sessionId,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
            }));
            const output = runScript({
                directory: tempDir,
                sessionId,
                user_requested: true,
            });
            expect(output.continue).toBe(true);
        });
        it("returns continue: true when no modes are active", () => {
            const output = runScript({ directory: tempDir, sessionId: "no-modes" });
            expect(output.continue).toBe(true);
        });
        it("returns continue: true for terminal autopilot state", () => {
            const sessionId = "autopilot-complete";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "autopilot-state.json"), JSON.stringify({
                active: true,
                phase: "complete",
                session_id: sessionId,
                reinforcement_count: 0,
                last_checked_at: new Date().toISOString(),
            }));
            const output = runScript({ directory: tempDir, sessionId });
            expect(output.continue).toBe(true);
        });
    });
});
//# sourceMappingURL=stop-hook-blocking.test.js.map