import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { createHookOutput, checkPersistentModes, } from "./index.js";
import { activateUltrawork, deactivateUltrawork } from "../ultrawork/index.js";
import { getOmcRoot } from "../../lib/worktree-paths.js";
function writeTranscriptWithContext(filePath, contextWindow, inputTokens) {
    writeFileSync(filePath, `${JSON.stringify({
        usage: { context_window: contextWindow, input_tokens: inputTokens },
        context_window: contextWindow,
        input_tokens: inputTokens,
    })}\n`);
}
function writeSubagentTrackingState(tempDir, agents) {
    const stateDir = join(tempDir, ".omc", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "subagent-tracking.json"), JSON.stringify({
        agents,
        total_spawned: agents.length,
        total_completed: agents.filter((agent) => agent.status === "completed").length,
        total_failed: agents.filter((agent) => agent.status === "failed").length,
        last_updated: new Date().toISOString(),
    }, null, 2));
}
function writePendingTodo(tempDir, content) {
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
    writeFileSync(join(tempDir, ".claude", "todos.json"), JSON.stringify({
        todos: [
            {
                content,
                status: "pending",
                priority: "high",
            },
        ],
    }));
}
function writeLegacyModeState(tempDir, fileName, state) {
    const stateDir = join(tempDir, ".omc", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, fileName), JSON.stringify(state, null, 2));
}
function writeWorkflowTombstone(tempDir, sessionId, mode) {
    const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "skill-active-state.json"), JSON.stringify({
        version: 2,
        active_skills: {
            [mode]: {
                skill_name: mode,
                started_at: new Date(Date.now() - 60_000).toISOString(),
                completed_at: new Date().toISOString(),
                session_id: sessionId,
                mode_state_path: `${mode}-state.json`,
                initialized_mode: mode,
                initialized_state_path: join(tempDir, ".omc", "state", `${mode}-state.json`),
                initialized_session_state_path: join(sessionDir, `${mode}-state.json`),
            },
        },
    }, null, 2));
}
function resolveCentralizedStateDir(directory, customStateDir) {
    const previous = process.env.OMC_STATE_DIR;
    process.env.OMC_STATE_DIR = customStateDir;
    try {
        return join(getOmcRoot(directory), "state");
    }
    finally {
        if (previous === undefined) {
            delete process.env.OMC_STATE_DIR;
        }
        else {
            process.env.OMC_STATE_DIR = previous;
        }
    }
}
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
        it("returns continue: false for autoresearch mode blocking", () => {
            const result = {
                shouldBlock: true,
                message: "[AUTORESEARCH] Continue iterating",
                mode: "autoresearch",
                metadata: { phase: "running" },
            };
            const output = createHookOutput(result);
            expect(output.continue).toBe(false);
            expect(output.message).toContain("AUTORESEARCH");
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
        it("ignores ultrawork states that are still awaiting skill confirmation", async () => {
            const sessionId = "ultrawork-awaiting-confirmation";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ultrawork-state.json"), JSON.stringify({
                active: true,
                awaiting_confirmation: true,
                started_at: new Date().toISOString(),
                original_prompt: "Test task",
                session_id: sessionId,
                reinforcement_count: 0,
                last_checked_at: new Date().toISOString(),
            }));
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe("none");
        });
        it("blocks stop while autoresearch max-runtime remains", async () => {
            const sessionId = "autoresearch-active";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "autoresearch-state.json"), JSON.stringify({
                active: true,
                session_id: sessionId,
                mission_slug: "demo",
                current_phase: "running",
                started_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                deadline_at: new Date(Date.now() + 60_000).toISOString(),
                iteration: 2,
            }));
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe("autoresearch");
            expect(result.message).toContain("AUTORESEARCH - STATEFUL MISSION ACTIVE");
            expect(result.message).toContain("demo");
        });
        it("releases autoresearch when max-runtime ceiling is reached", async () => {
            const sessionId = "autoresearch-expired";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            const statePath = join(sessionDir, "autoresearch-state.json");
            writeFileSync(statePath, JSON.stringify({
                active: true,
                session_id: sessionId,
                mission_slug: "demo",
                current_phase: "running",
                started_at: new Date(Date.now() - 120_000).toISOString(),
                updated_at: new Date().toISOString(),
                deadline_at: new Date(Date.now() - 1_000).toISOString(),
                iteration: 3,
            }));
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe("autoresearch");
            expect(result.message).toContain("Max-runtime ceiling reached");
            const updated = JSON.parse(readFileSync(statePath, 'utf-8'));
            expect(updated.active).toBe(false);
            expect(updated.current_phase).toBe('stopped');
            expect(updated.stop_reason).toBe('max-runtime ceiling reached');
        });
        it("blocks stop when autoresearch only exists on the legacy shared path", async () => {
            const sessionId = "autoresearch-legacy-active";
            writeLegacyModeState(tempDir, "autoresearch-state.json", {
                active: true,
                mission_slug: "legacy-demo",
                current_phase: "running",
                started_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                deadline_at: new Date(Date.now() + 60_000).toISOString(),
                iteration: 4,
            });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe("autoresearch");
            expect(result.message).toContain("AUTORESEARCH - STATEFUL MISSION ACTIVE");
            expect(result.message).toContain("legacy-demo");
        });
        it("does not leak foreign-session legacy autoresearch state", async () => {
            const sessionId = "autoresearch-session-a";
            writeLegacyModeState(tempDir, "autoresearch-state.json", {
                active: true,
                session_id: "autoresearch-session-b",
                mission_slug: "foreign-demo",
                current_phase: "running",
                started_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                deadline_at: new Date(Date.now() + 60_000).toISOString(),
                iteration: 1,
            });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe("none");
        });
        it("releases expired autoresearch discovered through the legacy shared bridge", async () => {
            const sessionId = "autoresearch-legacy-expired";
            const statePath = join(tempDir, ".omc", "state", "autoresearch-state.json");
            writeLegacyModeState(tempDir, "autoresearch-state.json", {
                active: true,
                mission_slug: "legacy-expired",
                current_phase: "running",
                started_at: new Date(Date.now() - 120_000).toISOString(),
                updated_at: new Date().toISOString(),
                deadline_at: new Date(Date.now() - 1_000).toISOString(),
                iteration: 5,
            });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe("autoresearch");
            expect(result.message).toContain("Max-runtime ceiling reached");
            const updated = JSON.parse(readFileSync(statePath, 'utf-8'));
            expect(updated.active).toBe(false);
            expect(updated.current_phase).toBe('stopped');
            expect(updated.stop_reason).toBe('max-runtime ceiling reached');
        });
        it("stale awaiting_confirmation does not suppress ultrawork enforcement", async () => {
            const sessionId = "ultrawork-stale-awaiting-confirmation";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            mkdirSync(join(tempDir, '.claude'), { recursive: true });
            writeFileSync(join(tempDir, '.claude', 'todos.json'), JSON.stringify({
                todos: [
                    {
                        content: 'resume the queued task',
                        status: 'pending',
                        priority: 'high'
                    }
                ]
            }));
            writeFileSync(join(sessionDir, "ultrawork-state.json"), JSON.stringify({
                active: true,
                awaiting_confirmation: true,
                awaiting_confirmation_set_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
                started_at: new Date().toISOString(),
                original_prompt: "Test task",
                session_id: sessionId,
                reinforcement_count: 0,
                last_checked_at: new Date().toISOString(),
            }));
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe("ultrawork");
        });
        it("does not use fresh last_checked_at as fallback for stale awaiting_confirmation", async () => {
            const sessionId = "ultrawork-fresh-last-checked-still-stale-confirmation";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            mkdirSync(join(tempDir, '.claude'), { recursive: true });
            writeFileSync(join(tempDir, '.claude', 'todos.json'), JSON.stringify({
                todos: [
                    {
                        content: 'resume the queued task',
                        status: 'pending',
                        priority: 'high'
                    }
                ]
            }));
            writeFileSync(join(sessionDir, "ultrawork-state.json"), JSON.stringify({
                active: true,
                awaiting_confirmation: true,
                started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
                original_prompt: "Test task",
                session_id: sessionId,
                reinforcement_count: 0,
                last_checked_at: new Date().toISOString(),
            }));
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe("ultrawork");
        });
        it("blocks stop for active ultrawork while incomplete work remains (shouldBlock: true -> continue: false)", async () => {
            const sessionId = "test-session-block";
            activateUltrawork("Fix the bug", sessionId, tempDir);
            mkdirSync(join(tempDir, '.claude'), { recursive: true });
            writeFileSync(join(tempDir, '.claude', 'todos.json'), JSON.stringify({
                todos: [
                    {
                        content: 'finish the bug fix',
                        status: 'pending',
                        priority: 'high'
                    }
                ]
            }));
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            const output = createHookOutput(result);
            expect(output.continue).toBe(false);
            expect(output.message).toBeDefined();
        });
        it("auto-deactivates ultrawork and allows stop when all tracked work is complete", async () => {
            const sessionId = "test-session-complete";
            activateUltrawork("Task complete", sessionId, tempDir);
            const statePath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json');
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('none');
            expect(result.message).toContain('ULTRAWORK COMPLETE');
            const output = createHookOutput(result);
            expect(output.continue).toBe(true);
            expect(output.message).toContain('ULTRAWORK COMPLETE');
            expect(() => readFileSync(statePath, 'utf-8')).toThrow();
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
        it("does not fire ralph stop reinforcement when authoritative registry is empty after cancel tombstone", async () => {
            const sessionId = "ralph-stale-restored-after-cancel";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ralph-state.json"), JSON.stringify({
                active: true,
                iteration: 7,
                max_iterations: 100,
                session_id: sessionId,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
                prompt: "stale restored task",
            }, null, 2));
            writeWorkflowTombstone(tempDir, sessionId, "ralph");
            const { getActiveModes } = await import("../mode-registry/index.js");
            expect(getActiveModes(tempDir, sessionId)).not.toContain("ralph");
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe("none");
            expect(result.message).not.toContain("[RALPH LOOP");
        });
        it("does not fire ultrawork stop reinforcement when authoritative registry is empty after cancel tombstone", async () => {
            const sessionId = "ultrawork-stale-restored-after-cancel";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writePendingTodo(tempDir, "pending work should not revive stale ultrawork");
            writeFileSync(join(sessionDir, "ultrawork-state.json"), JSON.stringify({
                active: true,
                started_at: new Date().toISOString(),
                original_prompt: "stale restored ultrawork",
                session_id: sessionId,
                reinforcement_count: 3,
                last_checked_at: new Date().toISOString(),
            }, null, 2));
            writeWorkflowTombstone(tempDir, sessionId, "ultrawork");
            const { getActiveModes } = await import("../mode-registry/index.js");
            expect(getActiveModes(tempDir, sessionId)).not.toContain("ultrawork");
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.mode).not.toBe("ultrawork");
            expect(result.message).not.toContain("[ULTRAWORK");
        });
        it("still fires ralph stop reinforcement when authoritative registry reports active ralph", async () => {
            const sessionId = "ralph-active-registry";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ralph-state.json"), JSON.stringify({
                active: true,
                iteration: 1,
                max_iterations: 100,
                session_id: sessionId,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
                prompt: "active task",
            }, null, 2));
            const { getActiveModes } = await import("../mode-registry/index.js");
            expect(getActiveModes(tempDir, sessionId)).toContain("ralph");
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe("ralph");
            expect(result.message).toContain("[RALPH - ITERATION");
        });
        it("allows stop after broad clear removes leftover session-scoped state", async () => {
            const sessionA = "test-broad-clear-a";
            const sessionB = "test-broad-clear-b";
            const stateDir = join(tempDir, '.omc', 'state');
            const sessionADir = join(stateDir, 'sessions', sessionA);
            const sessionBDir = join(stateDir, 'sessions', sessionB);
            mkdirSync(sessionADir, { recursive: true });
            mkdirSync(sessionBDir, { recursive: true });
            writeFileSync(join(sessionADir, 'ralph-state.json'), JSON.stringify({
                active: true,
                iteration: 1,
                max_iterations: 10,
                session_id: sessionA,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
            }));
            writeFileSync(join(sessionBDir, 'ralph-state.json'), JSON.stringify({
                active: true,
                iteration: 1,
                max_iterations: 10,
                session_id: sessionB,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
            }));
            const { clearModeStateFile } = await import('../../lib/mode-state-io.js');
            expect(clearModeStateFile('ralph', tempDir)).toBe(true);
            const resultA = await checkPersistentModes(sessionA, tempDir);
            const outputA = createHookOutput(resultA);
            expect(outputA.continue).toBe(true);
            expect(resultA.shouldBlock).toBe(false);
            const resultB = await checkPersistentModes(sessionB, tempDir);
            const outputB = createHookOutput(resultB);
            expect(outputB.continue).toBe(true);
            expect(resultB.shouldBlock).toBe(false);
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
        it("allows stop for critical transcript context even with active autopilot", async () => {
            const sessionId = "test-autopilot-critical-context";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            const transcriptPath = join(tempDir, "transcript.jsonl");
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "autopilot-state.json"), JSON.stringify({
                active: true,
                phase: "execution",
                session_id: sessionId,
                iteration: 2,
                max_iterations: 20,
                reinforcement_count: 0,
                last_checked_at: new Date().toISOString(),
                started_at: new Date().toISOString(),
            }));
            writeTranscriptWithContext(transcriptPath, 1000, 960);
            const result = await checkPersistentModes(sessionId, tempDir, {
                transcript_path: transcriptPath,
                stop_reason: "end_turn",
            });
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe("none");
            const output = createHookOutput(result);
            expect(output.continue).toBe(true);
            expect(output.message).toBeUndefined();
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
        it("keeps blocking active ralph loop when stop reason is interrupt", async () => {
            const sessionId = "test-ralph-interrupt";
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
            const result = await checkPersistentModes(sessionId, tempDir, {
                stop_reason: "interrupt",
            });
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe("ralph");
            const output = createHookOutput(result);
            expect(output.continue).toBe(false);
            expect(output.message).toContain("RALPH");
        });
        it("ignores stale legacy ralph state when no session is provided", async () => {
            const staleAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
            writeLegacyModeState(tempDir, "ralph-state.json", {
                active: true,
                iteration: 1,
                max_iterations: 50,
                started_at: staleAt,
                last_checked_at: staleAt,
                prompt: "Stale legacy ralph task",
            });
            const result = await checkPersistentModes(undefined, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe("none");
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
        it("returns continue: true when ralph is awaiting confirmation", () => {
            const sessionId = "ralph-awaiting-confirmation-mjs";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ralph-state.json"), JSON.stringify({
                active: true,
                awaiting_confirmation: true,
                iteration: 1,
                max_iterations: 50,
                session_id: sessionId,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
                prompt: "Test task",
            }));
            const output = runScript({ directory: tempDir, sessionId });
            expect(output.continue).toBe(true);
            expect(output.decision).toBeUndefined();
        });
        it("returns decision: block when ralph is active", () => {
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
            expect(output.decision).toBe("block");
        });
        it("returns continue: true for tombstoned stale ralph state", () => {
            const sessionId = "ralph-mjs-tombstoned";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ralph-state.json"), JSON.stringify({
                active: true,
                iteration: 9,
                max_iterations: 100,
                session_id: sessionId,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
                prompt: "stale restored ralph",
            }));
            writeWorkflowTombstone(tempDir, sessionId, "ralph");
            const output = runScript({ directory: tempDir, sessionId });
            expect(output.continue).toBe(true);
            expect(output.decision).toBeUndefined();
            expect(String(output.reason || "")).not.toContain("[RALPH LOOP");
        });
        it("returns decision: block when ultrawork is active", () => {
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
            expect(output.decision).toBe("block");
        });
        it("returns continue: true for tombstoned stale ultrawork state", () => {
            const sessionId = "ultrawork-mjs-tombstoned";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ultrawork-state.json"), JSON.stringify({
                active: true,
                started_at: new Date().toISOString(),
                original_prompt: "stale restored ultrawork",
                session_id: sessionId,
                reinforcement_count: 0,
                last_checked_at: new Date().toISOString(),
            }));
            writeWorkflowTombstone(tempDir, sessionId, "ultrawork");
            const output = runScript({ directory: tempDir, sessionId });
            expect(output.continue).toBe(true);
            expect(output.decision).toBeUndefined();
            expect(String(output.reason || "")).not.toContain("[ULTRAWORK");
        });
        it("returns continue: true for stale legacy ultrawork state without a session", () => {
            const staleAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
            writeLegacyModeState(tempDir, "ultrawork-state.json", {
                active: true,
                started_at: staleAt,
                original_prompt: "Stale legacy ultrawork task",
                reinforcement_count: 0,
                last_checked_at: staleAt,
            });
            const output = runScript({ directory: tempDir });
            expect(output.continue).toBe(true);
            expect(output.decision).toBeUndefined();
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
        it("returns continue: true for critical transcript context when autopilot is active", () => {
            const sessionId = "autopilot-critical-context-mjs";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            const transcriptPath = join(tempDir, "transcript.jsonl");
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "autopilot-state.json"), JSON.stringify({
                active: true,
                phase: "execution",
                session_id: sessionId,
                reinforcement_count: 0,
                last_checked_at: new Date().toISOString(),
                started_at: new Date().toISOString(),
            }));
            writeTranscriptWithContext(transcriptPath, 1000, 960);
            const output = runScript({
                directory: tempDir,
                sessionId,
                transcript_path: transcriptPath,
                stop_reason: "end_turn",
            });
            expect(output.continue).toBe(true);
            expect(output.decision).toBeUndefined();
        });
        it("returns decision: block when autopilot awaiting_confirmation is stale", () => {
            const sessionId = "autopilot-stale-awaiting-confirmation-mjs";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "autopilot-state.json"), JSON.stringify({
                active: true,
                phase: "execution",
                iteration: 1,
                max_iterations: 10,
                awaiting_confirmation: true,
                awaiting_confirmation_set_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
                originalIdea: "test",
                expansion: { analyst_complete: false, architect_complete: false, spec_path: null, requirements_summary: "", tech_stack: [] },
                planning: { plan_path: null, architect_iterations: 0, approved: false },
                execution: { ralph_iterations: 0, ultrawork_active: false, tasks_completed: 0, tasks_total: 0, files_created: [], files_modified: [] },
                qa: { ultraqa_cycles: 0, build_status: "pending", lint_status: "pending", test_status: "pending" },
                validation: { architects_spawned: 0, verdicts: [], all_approved: false, validation_rounds: 0 },
                started_at: new Date().toISOString(),
                completed_at: null,
                phase_durations: {},
                total_agents_spawned: 0,
                wisdom_entries: 0,
                session_id: sessionId,
                project_path: tempDir,
            }));
            const output = runScript({ directory: tempDir, sessionId });
            expect(output.decision).toBe("block");
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
        it("does not block explicit /ralplan startup while awaiting confirmation", () => {
            const sessionId = "ralplan-explicit-slash-startup";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ralplan-state.json"), JSON.stringify({
                active: true,
                session_id: sessionId,
                current_phase: "ralplan",
                original_prompt: "/oh-my-claudecode:ralplan issue #2622",
                awaiting_confirmation: true,
                awaiting_confirmation_set_at: new Date().toISOString(),
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
            }));
            const output = runScript({ directory: tempDir, sessionId });
            expect(output.continue).toBe(true);
            expect(output.decision).toBeUndefined();
        });
        it("returns continue: true when ultrawork is awaiting confirmation in cjs script", () => {
            const sessionId = "ultrawork-awaiting-confirmation-cjs";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ultrawork-state.json"), JSON.stringify({
                active: true,
                awaiting_confirmation: true,
                started_at: new Date().toISOString(),
                original_prompt: "Test task",
                session_id: sessionId,
                reinforcement_count: 0,
                last_checked_at: new Date().toISOString(),
                project_path: tempDir,
            }));
            const output = runScript({ directory: tempDir, sessionId });
            expect(output.continue).toBe(true);
            expect(output.decision).toBeUndefined();
        });
        it("returns decision: block when autopilot awaiting_confirmation is stale in cjs script", () => {
            const sessionId = "autopilot-stale-awaiting-confirmation-cjs";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "autopilot-state.json"), JSON.stringify({
                active: true,
                phase: "execution",
                iteration: 1,
                max_iterations: 10,
                awaiting_confirmation: true,
                awaiting_confirmation_set_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
                originalIdea: "test",
                expansion: { analyst_complete: false, architect_complete: false, spec_path: null, requirements_summary: "", tech_stack: [] },
                planning: { plan_path: null, architect_iterations: 0, approved: false },
                execution: { ralph_iterations: 0, ultrawork_active: false, tasks_completed: 0, tasks_total: 0, files_created: [], files_modified: [] },
                qa: { ultraqa_cycles: 0, build_status: "pending", lint_status: "pending", test_status: "pending" },
                validation: { architects_spawned: 0, verdicts: [], all_approved: false, validation_rounds: 0 },
                started_at: new Date().toISOString(),
                completed_at: null,
                phase_durations: {},
                total_agents_spawned: 0,
                wisdom_entries: 0,
                session_id: sessionId,
                project_path: tempDir,
            }));
            const output = runScript({ directory: tempDir, sessionId });
            expect(output.decision).toBe("block");
        });
        it("returns continue: true for authentication error stop", () => {
            const sessionId = "auth-error-mjs";
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
                stop_reason: "oauth_expired",
            });
            expect(output.continue).toBe(true);
        });
        it("returns continue: true for ScheduleWakeup-triggered stop", () => {
            const sessionId = "scheduled-wakeup-mjs";
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
                stop_reason: "ScheduleWakeup",
            });
            expect(output.continue).toBe(true);
        });
        it("returns continue: true when no modes are active", () => {
            const output = runScript({ directory: tempDir, sessionId: "no-modes" });
            expect(output.continue).toBe(true);
        });
        it("fails open for missing/unknown Team phase in script", () => {
            const sessionId = "team-phase-mjs";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "team-state.json"), JSON.stringify({
                active: true,
                session_id: sessionId,
                last_checked_at: new Date().toISOString(),
                started_at: new Date().toISOString(),
            }));
            const missingPhaseOutput = runScript({ directory: tempDir, sessionId });
            expect(missingPhaseOutput.continue).toBe(true);
            writeFileSync(join(sessionDir, "team-state.json"), JSON.stringify({
                active: true,
                session_id: sessionId,
                current_phase: "phase-does-not-exist",
                last_checked_at: new Date().toISOString(),
                started_at: new Date().toISOString(),
            }));
            const unknownPhaseOutput = runScript({ directory: tempDir, sessionId });
            expect(unknownPhaseOutput.continue).toBe(true);
        });
        it("applies Team circuit breaker after max reinforcements in script", () => {
            const sessionId = "team-breaker-mjs";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "team-state.json"), JSON.stringify({
                active: true,
                session_id: sessionId,
                current_phase: "team-exec",
                reinforcement_count: 20,
                last_checked_at: new Date().toISOString(),
                started_at: new Date().toISOString(),
            }));
            const output = runScript({ directory: tempDir, sessionId });
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
    describe("persistent-mode.cjs script blocking contract", () => {
        let tempDir;
        const scriptPath = join(process.cwd(), "scripts", "persistent-mode.cjs");
        function runScript(input, envOverrides = {}) {
            try {
                const result = execSync(`node "${scriptPath}"`, {
                    encoding: "utf-8",
                    timeout: 5000,
                    input: JSON.stringify(input),
                    env: { ...process.env, NODE_ENV: "test", ...envOverrides },
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
            tempDir = mkdtempSync(join(tmpdir(), "stop-hook-cjs-test-"));
            execSync("git init", { cwd: tempDir });
            delete process.env.OMC_STATE_DIR;
        });
        afterEach(() => {
            delete process.env.OMC_STATE_DIR;
            rmSync(tempDir, { recursive: true, force: true });
        });
        it("reads centralized session state when OMC_STATE_DIR is set", () => {
            const sessionId = "centralized-state-cjs";
            const customStateDir = join(tempDir, "centralized-state");
            const centralizedStateDir = resolveCentralizedStateDir(tempDir, customStateDir);
            const sessionDir = join(centralizedStateDir, "sessions", sessionId);
            writePendingTodo(tempDir, "Finish centralized task");
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ultrawork-state.json"), JSON.stringify({
                active: true,
                original_prompt: "Centralized task",
                session_id: sessionId,
                reinforcement_count: 0,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
            }));
            const output = runScript({ directory: tempDir, sessionId }, { OMC_STATE_DIR: customStateDir });
            expect(output.decision).toBe("block");
            expect(output.reason).toContain("ULTRAWORK");
        });
        it("ignores legacy local state when OMC_STATE_DIR is set", () => {
            const sessionId = "legacy-local-cjs";
            const localSessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            writePendingTodo(tempDir, "Finish centralized-only task");
            mkdirSync(localSessionDir, { recursive: true });
            writeFileSync(join(localSessionDir, "ultrawork-state.json"), JSON.stringify({
                active: true,
                original_prompt: "Stale local task",
                session_id: sessionId,
                reinforcement_count: 0,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
            }));
            const output = runScript({ directory: tempDir, sessionId }, { OMC_STATE_DIR: join(tempDir, "centralized-state") });
            expect(output.continue).toBe(true);
            expect(output.decision).toBeUndefined();
        });
        it("returns continue: true for authentication error stop", () => {
            const sessionId = "auth-error-cjs";
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
                stop_reason: "oauth_expired",
            });
            expect(output.continue).toBe(true);
        });
        it("returns continue: true for ScheduleWakeup-triggered stop", () => {
            const sessionId = "scheduled-wakeup-cjs";
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
                stop_reason: "ScheduleWakeup",
            });
            expect(output.continue).toBe(true);
        });
        it("returns continue: true when skill state is active but delegated subagents are still running", () => {
            const sessionId = "skill-active-subagents-cjs";
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
            writeSubagentTrackingState(tempDir, [
                {
                    agent_id: "agent-cjs-1",
                    agent_type: "explore",
                    started_at: new Date().toISOString(),
                    parent_mode: "none",
                    status: "running",
                },
            ]);
            const output = runScript({ directory: tempDir, sessionId });
            expect(output.continue).toBe(true);
            expect(output.decision).toBeUndefined();
            const persisted = JSON.parse(readFileSync(join(sessionDir, "skill-active-state.json"), "utf-8"));
            expect(persisted.reinforcement_count).toBe(0);
        });
        it("returns continue: true for critical transcript context when autopilot is active", () => {
            const sessionId = "autopilot-critical-context-cjs";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            const transcriptPath = join(tempDir, "transcript.jsonl");
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "autopilot-state.json"), JSON.stringify({
                active: true,
                phase: "execution",
                session_id: sessionId,
                reinforcement_count: 0,
                last_checked_at: new Date().toISOString(),
                started_at: new Date().toISOString(),
            }));
            writeTranscriptWithContext(transcriptPath, 1000, 960);
            const output = runScript({
                directory: tempDir,
                sessionId,
                transcript_path: transcriptPath,
                stop_reason: "end_turn",
            });
            expect(output.continue).toBe(true);
            expect(output.decision).toBeUndefined();
        });
        it("omits cancel guidance for legacy autopilot state without a session id in cjs script", () => {
            const stateDir = join(tempDir, ".omc", "state");
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(join(stateDir, "autopilot-state.json"), JSON.stringify({
                active: true,
                phase: "execution",
                reinforcement_count: 0,
                last_checked_at: new Date().toISOString(),
                started_at: new Date().toISOString(),
            }));
            const output = runScript({
                directory: tempDir,
            });
            expect(output.decision).toBe("block");
            expect(output.reason).toContain("AUTOPILOT");
            expect(output.reason).not.toContain('/oh-my-claudecode:cancel');
        });
        it("auto-deactivates ultrawork state when no incomplete work remains in cjs script", () => {
            const sessionId = "ulw-complete-cjs";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            const statePath = join(sessionDir, "ultrawork-state.json");
            writeFileSync(statePath, JSON.stringify({
                active: true,
                session_id: sessionId,
                reinforcement_count: 2,
                max_reinforcements: 50,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
                project_path: tempDir,
            }));
            const output = runScript({
                directory: tempDir,
                sessionId,
            });
            expect(output.continue).toBe(true);
            const updatedState = JSON.parse(readFileSync(statePath, "utf-8"));
            expect(updatedState.active).toBe(false);
            expect(updatedState.deactivated_reason).toBe("task_completion");
        });
        it("fails open for unknown Team phase in cjs script", () => {
            const sessionId = "team-phase-cjs";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "team-state.json"), JSON.stringify({
                active: true,
                session_id: sessionId,
                current_phase: "totally-unknown",
                last_checked_at: new Date().toISOString(),
                started_at: new Date().toISOString(),
            }));
            const output = runScript({
                directory: tempDir,
                sessionId,
            });
            expect(output.continue).toBe(true);
        });
        it.each([
            [{ current_phase: "aborted" }, "ralplan-aborted-cjs"],
            [{ phase: "terminated" }, "ralplan-terminated-phase-cjs"],
            [{ status: "handoff:ralph" }, "ralplan-handoff-status-cjs"],
        ])("allows stop for terminal ralplan state in cjs script: %s", (overrides, sessionId) => {
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "ralplan-state.json"), JSON.stringify({
                active: true,
                session_id: sessionId,
                started_at: new Date().toISOString(),
                ...overrides,
            }));
            const output = runScript({
                directory: tempDir,
                sessionId,
            });
            expect(output.continue).toBe(true);
        });
        it("deactivates ultrawork state when max reinforcements reached", () => {
            const sessionId = "ulw-max-reinforce-cjs";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            const statePath = join(sessionDir, "ultrawork-state.json");
            writeFileSync(statePath, JSON.stringify({
                active: true,
                session_id: sessionId,
                reinforcement_count: 51,
                max_reinforcements: 50,
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
                project_path: tempDir,
            }));
            mkdirSync(join(tempDir, '.claude'), { recursive: true });
            writeFileSync(join(tempDir, '.claude', 'todos.json'), JSON.stringify({
                todos: [
                    {
                        content: 'keep working',
                        status: 'pending',
                        priority: 'high'
                    }
                ]
            }));
            const output = runScript({
                directory: tempDir,
                sessionId,
            });
            // Should allow stop
            expect(output.continue).toBe(true);
            // State should be deactivated
            const updatedState = JSON.parse(readFileSync(statePath, "utf-8"));
            expect(updatedState.active).toBe(false);
            expect(updatedState.deactivated_reason).toBe("max_reinforcements_reached");
        });
        it("applies Team circuit breaker in cjs script", () => {
            const sessionId = "team-breaker-cjs";
            const sessionDir = join(tempDir, ".omc", "state", "sessions", sessionId);
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "team-state.json"), JSON.stringify({
                active: true,
                session_id: sessionId,
                current_phase: "team-exec",
                reinforcement_count: 20,
                last_checked_at: new Date().toISOString(),
                started_at: new Date().toISOString(),
            }));
            // Priority 2.5 uses a separate stop-breaker file for circuit breaking
            writeFileSync(join(sessionDir, "team-pipeline-stop-breaker.json"), JSON.stringify({
                count: 21, // exceeds TEAM_PIPELINE_STOP_BLOCKER_MAX (20)
                updated_at: new Date().toISOString(),
            }));
            const output = runScript({
                directory: tempDir,
                sessionId,
            });
            expect(output.continue).toBe(true);
        });
    });
});
//# sourceMappingURL=stop-hook-blocking.test.js.map