/**
 * Session isolation tests for subagent-tracker.
 *
 * Verifies that writes with sessionId='X' and sessionId='Y' are stored
 * independently and can be read back in isolation without cross-contamination.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeTrackingState, readTrackingState, flushPendingWrites, } from "../index.js";
describe("session isolation", () => {
    let testDir;
    beforeEach(() => {
        testDir = join(tmpdir(), `subagent-isolation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(join(testDir, ".omc", "state"), { recursive: true });
    });
    afterEach(() => {
        flushPendingWrites();
        rmSync(testDir, { recursive: true, force: true });
    });
    function makeState(agentId, spawned) {
        return {
            agents: [
                {
                    agent_id: agentId,
                    agent_type: "oh-my-claudecode:executor",
                    started_at: new Date().toISOString(),
                    parent_mode: "ultrawork",
                    status: "running",
                    task_description: `task for ${agentId}`,
                },
            ],
            total_spawned: spawned,
            total_completed: 0,
            total_failed: 0,
            last_updated: new Date().toISOString(),
        };
    }
    it("interleaved writes with sessionId X and Y are isolated on read-back", () => {
        const stateX1 = makeState("agent-x-1", 1);
        const stateY1 = makeState("agent-y-1", 1);
        const stateX2 = makeState("agent-x-2", 2);
        const stateY2 = makeState("agent-y-2", 2);
        // Interleave writes for sessions X and Y
        writeTrackingState(testDir, stateX1, "session-X");
        writeTrackingState(testDir, stateY1, "session-Y");
        writeTrackingState(testDir, stateX2, "session-X");
        writeTrackingState(testDir, stateY2, "session-Y");
        // Flush ensures data hits disk before we read
        flushPendingWrites();
        // Read back session X — must only see X agents
        const readX = readTrackingState(testDir, "session-X");
        const xAgentIds = readX.agents.map((a) => a.agent_id);
        expect(xAgentIds).toContain("agent-x-2");
        expect(xAgentIds).not.toContain("agent-y-1");
        expect(xAgentIds).not.toContain("agent-y-2");
        // Read back session Y — must only see Y agents
        const readY = readTrackingState(testDir, "session-Y");
        const yAgentIds = readY.agents.map((a) => a.agent_id);
        expect(yAgentIds).toContain("agent-y-2");
        expect(yAgentIds).not.toContain("agent-x-1");
        expect(yAgentIds).not.toContain("agent-x-2");
    });
    it("session X total_spawned does not bleed into session Y", () => {
        const stateX = {
            agents: [],
            total_spawned: 42,
            total_completed: 10,
            total_failed: 2,
            last_updated: new Date().toISOString(),
        };
        const stateY = {
            agents: [],
            total_spawned: 7,
            total_completed: 3,
            total_failed: 0,
            last_updated: new Date().toISOString(),
        };
        writeTrackingState(testDir, stateX, "session-X");
        writeTrackingState(testDir, stateY, "session-Y");
        flushPendingWrites();
        const readX = readTrackingState(testDir, "session-X");
        const readY = readTrackingState(testDir, "session-Y");
        expect(readX.total_spawned).toBe(42);
        expect(readX.total_completed).toBe(10);
        expect(readY.total_spawned).toBe(7);
        expect(readY.total_completed).toBe(3);
        // Cross-check: X values did not bleed into Y
        expect(readY.total_spawned).not.toBe(42);
    });
    it("session-scoped files do not interfere with legacy (no-session) path", () => {
        const stateLegacy = makeState("agent-legacy", 5);
        const stateSession = makeState("agent-session", 99);
        // Write legacy (no sessionId) and session-scoped
        writeTrackingState(testDir, stateLegacy);
        writeTrackingState(testDir, stateSession, "session-Z");
        flushPendingWrites();
        const readLegacy = readTrackingState(testDir);
        const readSession = readTrackingState(testDir, "session-Z");
        expect(readLegacy.agents.map((a) => a.agent_id)).toContain("agent-legacy");
        expect(readLegacy.agents.map((a) => a.agent_id)).not.toContain("agent-session");
        expect(readSession.agents.map((a) => a.agent_id)).toContain("agent-session");
        expect(readSession.agents.map((a) => a.agent_id)).not.toContain("agent-legacy");
    });
});
//# sourceMappingURL=session-isolation.test.js.map