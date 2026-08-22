import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { recordToolUsage, getAgentDashboard, getStaleAgents, getTrackingStats, processSubagentStart, processSubagentStop, readTrackingState, readDiskState, writeTrackingState, getStateFilePath, recordToolUsageWithTiming, getAgentPerformance, updateTokenUsage, recordFileOwnership, detectFileConflicts, suggestInterventions, calculateParallelEfficiency, getAgentObservatory, flushPendingWrites, } from "../index.js";
import { collectWorktreeDirtyEvidence } from "../worktree-evidence.js";
import { acquireFileLockSync, releaseFileLockSync, lockPathFor, } from "../../../lib/file-lock.js";
import { readMissionBoardState } from "../../../hud/mission-board.js";
import { readReplayEvents, getReplaySummary } from "../session-replay.js";
describe("subagent-tracker", () => {
    let testDir;
    beforeEach(() => {
        testDir = join(tmpdir(), `subagent-test-${Date.now()}`);
        mkdirSync(join(testDir, ".omc", "state"), { recursive: true });
    });
    afterEach(() => {
        flushPendingWrites();
        rmSync(testDir, { recursive: true, force: true });
    });
    describe("recordToolUsage", () => {
        it("should record tool usage for a running agent", () => {
            // Setup: create a running agent
            const state = {
                agents: [
                    {
                        agent_id: "test-agent-123",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                ],
                total_spawned: 1,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            recordToolUsage(testDir, "test-agent-123", "proxy_Read", true);
            flushPendingWrites();
            // Verify
            const updatedState = readTrackingState(testDir);
            const agent = updatedState.agents.find((a) => a.agent_id === "test-agent-123");
            expect(agent).toBeDefined();
            expect(agent?.tool_usage).toHaveLength(1);
            expect(agent?.tool_usage?.[0].tool_name).toBe("proxy_Read");
            expect(agent?.tool_usage?.[0].success).toBe(true);
            expect(agent?.tool_usage?.[0].timestamp).toBeDefined();
        });
        it("should not record for non-existent agent", () => {
            // Setup: empty state
            const state = {
                agents: [],
                total_spawned: 0,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            recordToolUsage(testDir, "non-existent", "proxy_Read", true);
            flushPendingWrites();
            // Verify state unchanged
            const updatedState = readTrackingState(testDir);
            expect(updatedState.agents).toHaveLength(0);
        });
        it("should cap tool usage at 50 entries", () => {
            // Setup: create agent with 50 tool usages
            const toolUsage = Array.from({ length: 50 }, (_, i) => ({
                tool_name: `tool-${i}`,
                timestamp: new Date().toISOString(),
                success: true,
            }));
            const state = {
                agents: [
                    {
                        agent_id: "test-agent-123",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                        tool_usage: toolUsage,
                    },
                ],
                total_spawned: 1,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            recordToolUsage(testDir, "test-agent-123", "new-tool", true);
            flushPendingWrites();
            // Verify capped at 50
            const updatedState = readTrackingState(testDir);
            const agent = updatedState.agents.find((a) => a.agent_id === "test-agent-123");
            expect(agent?.tool_usage).toHaveLength(50);
            expect(agent?.tool_usage?.[0].tool_name).toBe("tool-1"); // First one removed
            expect(agent?.tool_usage?.[49].tool_name).toBe("new-tool"); // New one added
        });
        it("should include timestamp and success flag", () => {
            // Setup: create a running agent
            const state = {
                agents: [
                    {
                        agent_id: "test-agent-123",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                ],
                total_spawned: 1,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const beforeTime = Date.now();
            recordToolUsage(testDir, "test-agent-123", "proxy_Bash", false);
            flushPendingWrites();
            const afterTime = Date.now();
            // Verify timestamp and success
            const updatedState = readTrackingState(testDir);
            const agent = updatedState.agents.find((a) => a.agent_id === "test-agent-123");
            expect(agent?.tool_usage).toHaveLength(1);
            const toolEntry = agent?.tool_usage?.[0];
            expect(toolEntry?.tool_name).toBe("proxy_Bash");
            expect(toolEntry?.success).toBe(false);
            const timestamp = new Date(toolEntry?.timestamp || "").getTime();
            expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
            expect(timestamp).toBeLessThanOrEqual(afterTime);
        });
    });
    describe("getAgentDashboard", () => {
        it("should return empty string when no running agents", () => {
            const state = {
                agents: [],
                total_spawned: 0,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const dashboard = getAgentDashboard(testDir);
            expect(dashboard).toBe("");
        });
        it("should format single running agent correctly", () => {
            const state = {
                agents: [
                    {
                        agent_id: "abcd1234567890",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date(Date.now() - 5000).toISOString(), // 5 seconds ago
                        parent_mode: "ultrawork",
                        status: "running",
                        task_description: "Fix the auth bug",
                        tool_usage: [
                            {
                                tool_name: "proxy_Read",
                                timestamp: new Date().toISOString(),
                                success: true,
                            },
                            {
                                tool_name: "proxy_Edit",
                                timestamp: new Date().toISOString(),
                                success: true,
                            },
                        ],
                    },
                ],
                total_spawned: 1,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const dashboard = getAgentDashboard(testDir);
            expect(dashboard).toContain("Agent Dashboard (1 active)");
            expect(dashboard).toContain("abcd123"); // Truncated agent_id
            expect(dashboard).toContain("executor"); // Stripped prefix
            expect(dashboard).toContain("tools:2");
            expect(dashboard).toContain("last:proxy_Edit");
            expect(dashboard).toContain("Fix the auth bug");
        });
        it("should format multiple (5) parallel agents", () => {
            const agents = Array.from({ length: 5 }, (_, i) => ({
                agent_id: `agent-${i}-123456`,
                agent_type: "oh-my-claudecode:executor",
                started_at: new Date(Date.now() - i * 1000).toISOString(),
                parent_mode: "ultrawork",
                status: "running",
                task_description: `Task ${i}`,
                tool_usage: [
                    {
                        tool_name: `tool-${i}`,
                        timestamp: new Date().toISOString(),
                        success: true,
                    },
                ],
            }));
            const state = {
                agents,
                total_spawned: 5,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const dashboard = getAgentDashboard(testDir);
            expect(dashboard).toContain("Agent Dashboard (5 active)");
            expect(dashboard).toContain("agent-0");
            expect(dashboard).toContain("agent-4");
            expect(dashboard).toContain("Task 0");
            expect(dashboard).toContain("Task 4");
        });
        it("should show tool count and last tool", () => {
            const state = {
                agents: [
                    {
                        agent_id: "test-123",
                        agent_type: "oh-my-claudecode:architect",
                        started_at: new Date().toISOString(),
                        parent_mode: "none",
                        status: "running",
                        tool_usage: [
                            {
                                tool_name: "proxy_Read",
                                timestamp: new Date().toISOString(),
                                success: true,
                            },
                            {
                                tool_name: "proxy_Grep",
                                timestamp: new Date().toISOString(),
                                success: true,
                            },
                            {
                                tool_name: "proxy_Bash",
                                timestamp: new Date().toISOString(),
                                success: false,
                            },
                        ],
                    },
                ],
                total_spawned: 1,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const dashboard = getAgentDashboard(testDir);
            expect(dashboard).toContain("tools:3");
            expect(dashboard).toContain("last:proxy_Bash");
        });
        it("should detect and show stale agents warning", () => {
            const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
            const state = {
                agents: [
                    {
                        agent_id: "stale-agent",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: sixMinutesAgo,
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                    {
                        agent_id: "fresh-agent",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                ],
                total_spawned: 2,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const dashboard = getAgentDashboard(testDir);
            expect(dashboard).toContain("⚠ 1 stale agent(s) detected");
        });
        it("should truncate agent_id to 7 chars", () => {
            const state = {
                agents: [
                    {
                        agent_id: "very-long-agent-id-1234567890",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                ],
                total_spawned: 1,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const dashboard = getAgentDashboard(testDir);
            expect(dashboard).toContain("[very-lo]"); // First 7 chars
            expect(dashboard).not.toContain("very-long-agent-id");
        });
        it("should strip oh-my-claudecode: prefix from agent type", () => {
            const state = {
                agents: [
                    {
                        agent_id: "test-123",
                        agent_type: "oh-my-claudecode:architect-high",
                        started_at: new Date().toISOString(),
                        parent_mode: "none",
                        status: "running",
                    },
                ],
                total_spawned: 1,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const dashboard = getAgentDashboard(testDir);
            expect(dashboard).toContain("architect-high");
            expect(dashboard).not.toContain("oh-my-claudecode:architect-high");
        });
    });
    describe("getStaleAgents", () => {
        it("should return empty array for fresh agents", () => {
            const state = {
                agents: [
                    {
                        agent_id: "fresh-1",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date(Date.now() - 1000).toISOString(), // 1 second ago
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                    {
                        agent_id: "fresh-2",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                ],
                total_spawned: 2,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            const stale = getStaleAgents(state);
            expect(stale).toHaveLength(0);
        });
        it("should detect agents older than 5 minutes", () => {
            const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
            const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
            const state = {
                agents: [
                    {
                        agent_id: "stale-1",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: sixMinutesAgo,
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                    {
                        agent_id: "stale-2",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: tenMinutesAgo,
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                    {
                        agent_id: "fresh",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: twoMinutesAgo,
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                ],
                total_spawned: 3,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            const stale = getStaleAgents(state);
            expect(stale).toHaveLength(2);
            expect(stale.map((a) => a.agent_id)).toContain("stale-1");
            expect(stale.map((a) => a.agent_id)).toContain("stale-2");
            expect(stale.map((a) => a.agent_id)).not.toContain("fresh");
        });
        it("should not flag completed agents as stale", () => {
            const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            const state = {
                agents: [
                    {
                        agent_id: "completed",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: tenMinutesAgo,
                        parent_mode: "ultrawork",
                        status: "completed",
                        completed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
                    },
                    {
                        agent_id: "failed",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: tenMinutesAgo,
                        parent_mode: "ultrawork",
                        status: "failed",
                        completed_at: new Date().toISOString(),
                    },
                    {
                        agent_id: "stale-running",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: tenMinutesAgo,
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                ],
                total_spawned: 3,
                total_completed: 1,
                total_failed: 1,
                last_updated: new Date().toISOString(),
            };
            const stale = getStaleAgents(state);
            expect(stale).toHaveLength(1);
            expect(stale[0].agent_id).toBe("stale-running");
        });
    });
    describe("getTrackingStats", () => {
        it("should return correct counts for mixed agent states", () => {
            const state = {
                agents: [
                    {
                        agent_id: "running-1",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                    {
                        agent_id: "running-2",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                    {
                        agent_id: "completed-1",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "completed",
                        completed_at: new Date().toISOString(),
                    },
                    {
                        agent_id: "failed-1",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "failed",
                        completed_at: new Date().toISOString(),
                    },
                ],
                total_spawned: 4,
                total_completed: 1,
                total_failed: 1,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const stats = getTrackingStats(testDir);
            expect(stats.running).toBe(2);
            expect(stats.completed).toBe(1);
            expect(stats.failed).toBe(1);
            expect(stats.total).toBe(4);
        });
        it("should handle empty state", () => {
            const state = {
                agents: [],
                total_spawned: 0,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const stats = getTrackingStats(testDir);
            expect(stats.running).toBe(0);
            expect(stats.completed).toBe(0);
            expect(stats.failed).toBe(0);
            expect(stats.total).toBe(0);
        });
    });
    describe("processSubagentStart", () => {
        it("dedupes repeated start events for the same running agent", () => {
            const startInput = {
                session_id: "session-123",
                transcript_path: join(testDir, "transcript.jsonl"),
                cwd: testDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "worker-3",
                agent_type: "oh-my-claudecode:executor",
                prompt: "Implement the dispatch changes",
                model: "gpt-5.4-mini",
            };
            const first = processSubagentStart(startInput);
            const second = processSubagentStart(startInput);
            expect(first.hookSpecificOutput?.hookEventName).toBe("SubagentStart");
            expect(first.hookSpecificOutput?.agent_count).toBe(1);
            expect(second.hookSpecificOutput?.hookEventName).toBe("SubagentStart");
            expect(second.hookSpecificOutput?.agent_count).toBe(1);
            const pendingState = readTrackingState(testDir);
            expect(pendingState.total_spawned).toBe(1);
            expect(pendingState.agents.filter((agent) => agent.agent_id === "worker-3")).toHaveLength(1);
            expect(pendingState.agents.filter((agent) => agent.status === "running")).toHaveLength(1);
            const dashboard = getAgentDashboard(testDir);
            expect(dashboard).toContain("Agent Dashboard (1 active)");
            expect(dashboard.match(/\[worker-/g) ?? []).toHaveLength(1);
            expect(dashboard).toContain("executor");
            expect(dashboard).toContain("Implement the dispatch changes");
            const missionBoard = readMissionBoardState(testDir, "session-123");
            const sessionMission = missionBoard?.missions.find((mission) => mission.id.startsWith("session:session-123:"));
            expect(sessionMission?.agents).toHaveLength(1);
            expect(sessionMission?.timeline).toHaveLength(1);
            expect(sessionMission?.agents[0]?.ownership).toBe("worker-3");
            flushPendingWrites();
            const persistedState = readTrackingState(testDir);
            expect(persistedState.total_spawned).toBe(1);
            expect(persistedState.agents.filter((agent) => agent.agent_id === "worker-3")).toHaveLength(1);
            expect(persistedState.agents.filter((agent) => agent.status === "running")).toHaveLength(1);
        });
        it("persists Agent-tool name/description for unnamed-agent addressability (#3665)", () => {
            const startInput = {
                session_id: "session-3665",
                transcript_path: join(testDir, "transcript.jsonl"),
                cwd: testDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "ae1e2be26cb41fc74",
                agent_type: "general-purpose",
                prompt: "Coordinate the S2 nspin4 A/B vehicle analysis",
                name: "",
                description: "S2 nspin4 A/B vehicle",
            };
            processSubagentStart(startInput);
            flushPendingWrites();
            const state = readTrackingState(testDir);
            const tracked = state.agents.find((a) => a.agent_id === "ae1e2be26cb41fc74");
            expect(tracked).toBeDefined();
            // Empty-string name is treated as absent (legacy/partial payloads).
            expect(tracked?.name).toBeUndefined();
            expect(tracked?.description).toBe("S2 nspin4 A/B vehicle");
            // Dashboard shows the description with the short id for disambiguation.
            const dashboard = getAgentDashboard(testDir);
            expect(dashboard).toContain("S2 nspin4 A/B vehicle (ae1e2be)");
        });
        it("records the Agent-tool description in the session replay stream (#3665)", () => {
            const startInput = {
                session_id: "session-3665-replay",
                transcript_path: join(testDir, "transcript.jsonl"),
                cwd: testDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "a31df4cfac7e5ba7f",
                agent_type: "general-purpose",
                prompt: "Ship logistics payload",
                name: undefined,
                description: "S3 logistics payload",
            };
            processSubagentStart(startInput);
            flushPendingWrites();
            const events = readReplayEvents(testDir, "session-3665-replay");
            const start = events.find((e) => e.event === "agent_start");
            expect(start).toBeDefined();
            expect(start?.agent).toBe("a31df4c");
            expect(start?.description).toBe("S3 logistics payload");
        });
        it("routes mission-state writes to the hook session id (not getProcessSessionId/PID fallback)", () => {
            // Regression: subagent-tracker previously omitted the sessionId arg when
            // calling recordMissionAgentStart/Stop, so the writer fell back to
            // getProcessSessionId() (pid-{PID}-{ts}). With /team spawning N subagent
            // processes, the team's missions ended up scattered across N pid-* dirs
            // instead of consolidated under the parent session UUID.
            const startInput = {
                session_id: "parent-uuid-xyz",
                transcript_path: join(testDir, "transcript.jsonl"),
                cwd: testDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "worker-mission-routing",
                agent_type: "oh-my-claudecode:executor",
                prompt: "regression check",
                model: "claude-sonnet-4-6",
            };
            processSubagentStart(startInput);
            flushPendingWrites();
            // Mission must live under the hook's session id, not under any pid-* fallback.
            const fromParent = readMissionBoardState(testDir, "parent-uuid-xyz");
            expect(fromParent?.missions.some((mission) => mission.id.startsWith("session:parent-uuid-xyz:"))).toBe(true);
            // Sanity: explicitly assert no pid-* session dir got created for this run.
            const sessionsDir = join(testDir, ".omc", "state", "sessions");
            const entries = require("fs").readdirSync(sessionsDir);
            expect(entries.filter((name) => name.startsWith("pid-"))).toHaveLength(0);
            expect(entries).toContain("parent-uuid-xyz");
        });
    });
    describe("processSubagentStop", () => {
        it("updates tracking state without injecting additional context into the stopping subagent", () => {
            const startInput = {
                session_id: "session-stop-output",
                transcript_path: join(testDir, "transcript.jsonl"),
                cwd: testDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "worker-stop-output",
                agent_type: "oh-my-claudecode:executor",
                prompt: "Return a detailed final report",
                model: "claude-sonnet-4-6",
            };
            processSubagentStart(startInput);
            flushPendingWrites();
            const output = processSubagentStop({
                session_id: "session-stop-output",
                transcript_path: join(testDir, "transcript.jsonl"),
                cwd: testDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "worker-stop-output",
                agent_type: "oh-my-claudecode:executor",
                output: "Detailed final report with implementation evidence.",
            });
            flushPendingWrites();
            expect(output.continue).toBe(true);
            expect(output.suppressOutput).toBe(true);
            expect(output.hookSpecificOutput).toBeUndefined();
            const state = readTrackingState(testDir, "session-stop-output");
            const agent = state.agents.find((item) => item.agent_id === "worker-stop-output");
            expect(agent?.status).toBe("completed");
            expect(agent?.output_summary).toBe("Detailed final report with implementation evidence.");
            expect(state.total_completed).toBe(1);
        });
        it("suppresses output without undefined context when stop payload lacks agent fields", () => {
            const output = processSubagentStop({
                session_id: "session-stop-missing-fields",
                transcript_path: join(testDir, "transcript.jsonl"),
                cwd: testDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                output: "Final report should remain the terminal subagent message.",
            });
            flushPendingWrites();
            expect(output).toEqual({ continue: true, suppressOutput: true });
            expect(JSON.stringify(output)).not.toContain("undefined");
            const state = readTrackingState(testDir, "session-stop-missing-fields");
            expect(state.agents).toHaveLength(0);
            expect(state.total_completed).toBe(0);
            expect(state.total_failed).toBe(0);
        });
        it("closes the sole running agent when a fork stop arrives with an unmatched agent_id", () => {
            // #3252: native fork stop events can carry an agent_id never registered
            // by SubagentStart. With exactly one running agent, reconcile it instead
            // of leaving it "running" forever.
            processSubagentStart({
                session_id: "session-unmatched-single",
                transcript_path: join(testDir, "transcript.jsonl"),
                cwd: testDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "registered-agent",
                agent_type: "oh-my-claudecode:executor",
                prompt: "do work",
            });
            flushPendingWrites();
            processSubagentStop({
                session_id: "session-unmatched-single",
                transcript_path: join(testDir, "transcript.jsonl"),
                cwd: testDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "native-fork-agent-id",
                output: "fork done",
            });
            flushPendingWrites();
            const state = readTrackingState(testDir, "session-unmatched-single");
            expect(getStaleAgents(state)).toHaveLength(0);
            expect(state.agents.filter((a) => a.status === "running")).toHaveLength(0);
            const reconciled = state.agents.find((a) => a.agent_id === "registered-agent");
            expect(reconciled?.status).toBe("completed");
            expect(reconciled?.output_summary).toBe("fork done");
            // No synthetic entry created for the unknown id when a fallback match exists.
            expect(state.agents.some((a) => a.agent_id === "native-fork-agent-id")).toBe(false);
            expect(state.total_completed).toBe(1);
        });
        it("reconciles an unmatched fork stop by agent_type when one type matches", () => {
            for (const [id, type] of [
                ["exec-1", "oh-my-claudecode:executor"],
                ["explore-1", "oh-my-claudecode:explorer"],
            ]) {
                processSubagentStart({
                    session_id: "session-unmatched-bytype",
                    transcript_path: join(testDir, "transcript.jsonl"),
                    cwd: testDir,
                    permission_mode: "default",
                    hook_event_name: "SubagentStart",
                    agent_id: id,
                    agent_type: type,
                    prompt: "do work",
                });
            }
            flushPendingWrites();
            processSubagentStop({
                session_id: "session-unmatched-bytype",
                transcript_path: join(testDir, "transcript.jsonl"),
                cwd: testDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "native-fork-id",
                agent_type: "oh-my-claudecode:explorer",
                output: "explorer done",
            });
            flushPendingWrites();
            const state = readTrackingState(testDir, "session-unmatched-bytype");
            const explorer = state.agents.find((a) => a.agent_id === "explore-1");
            const executor = state.agents.find((a) => a.agent_id === "exec-1");
            expect(explorer?.status).toBe("completed");
            expect(executor?.status).toBe("running");
            expect(state.agents.some((a) => a.agent_id === "native-fork-id")).toBe(false);
            expect(state.total_completed).toBe(1);
        });
        it("reaps stale running agents and records a synthetic stop when reconciliation is ambiguous", () => {
            // Two stale running agents of the same type make fallback ambiguous; the
            // unmatched stop must reap the stale entries (so they cannot leak forever)
            // and record the stop as a synthetic closed entry.
            const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            const seedState = {
                agents: [
                    {
                        agent_id: "stale-1",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: tenMinutesAgo,
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                    {
                        agent_id: "stale-2",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: tenMinutesAgo,
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                ],
                total_spawned: 2,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, seedState, "session-unmatched-ambiguous");
            flushPendingWrites();
            processSubagentStop({
                session_id: "session-unmatched-ambiguous",
                transcript_path: join(testDir, "transcript.jsonl"),
                cwd: testDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "native-fork-id",
                output: "fork done",
            });
            flushPendingWrites();
            const state = readTrackingState(testDir, "session-unmatched-ambiguous");
            // No running entries linger forever.
            expect(getStaleAgents(state)).toHaveLength(0);
            expect(state.agents.filter((a) => a.status === "running")).toHaveLength(0);
            expect(state.agents.find((a) => a.agent_id === "stale-1")?.status).toBe("failed");
            expect(state.agents.find((a) => a.agent_id === "stale-2")?.status).toBe("failed");
            const synthetic = state.agents.find((a) => a.agent_id === "native-fork-id");
            expect(synthetic?.status).toBe("completed");
            expect(synthetic?.agent_type).toBe("untracked-native-fork");
            expect(synthetic?.duration_ms).toBeUndefined();
            expect(synthetic?.synthetic).toBe(true);
            expect(synthetic?.telemetry_status).toBe("unmatched_stop");
            expect(synthetic?.telemetry_note).toContain("without a matching SubagentStart");
            const replayStop = readReplayEvents(testDir, "session-unmatched-ambiguous").find((event) => event.event === "agent_stop" && event.agent === "native-");
            expect(replayStop?.agent_type).toBe("untracked-native-fork");
            expect(replayStop?.duration_ms).toBeUndefined();
            expect(replayStop?.synthetic).toBe(true);
            expect(replayStop?.telemetry_status).toBe("unmatched_stop");
            expect(state.total_failed).toBe(2);
            expect(state.total_completed).toBe(1);
        });
        it("does not corrupt fresh running agents from a different concurrent stop", () => {
            // Fresh (non-stale) running peers are ambiguous targets, so an unmatched
            // stop must not close them; it only records a synthetic stop.
            for (const id of ["fresh-1", "fresh-2"]) {
                processSubagentStart({
                    session_id: "session-unmatched-fresh",
                    transcript_path: join(testDir, "transcript.jsonl"),
                    cwd: testDir,
                    permission_mode: "default",
                    hook_event_name: "SubagentStart",
                    agent_id: id,
                    agent_type: "oh-my-claudecode:executor",
                    prompt: "do work",
                });
            }
            flushPendingWrites();
            processSubagentStop({
                session_id: "session-unmatched-fresh",
                transcript_path: join(testDir, "transcript.jsonl"),
                cwd: testDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "native-fork-id",
                output: "fork done",
            });
            flushPendingWrites();
            const state = readTrackingState(testDir, "session-unmatched-fresh");
            expect(state.agents.find((a) => a.agent_id === "fresh-1")?.status).toBe("running");
            expect(state.agents.find((a) => a.agent_id === "fresh-2")?.status).toBe("running");
            expect(state.agents.find((a) => a.agent_id === "native-fork-id")?.status).toBe("completed");
            const synthetic = state.agents.find((a) => a.agent_id === "native-fork-id");
            expect(synthetic?.agent_type).toBe("untracked-native-fork");
            expect(synthetic?.duration_ms).toBeUndefined();
            expect(synthetic?.synthetic).toBe(true);
            expect(synthetic?.telemetry_status).toBe("unmatched_stop");
            expect(state.total_completed).toBe(1);
            expect(state.total_failed).toBe(0);
        });
    });
    describe("Tool Timing (Phase 1.1)", () => {
        it("should record tool usage with timing data", () => {
            // Setup: create a running agent
            const state = {
                agents: [
                    {
                        agent_id: "timing-test",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                        tool_usage: [],
                    },
                ],
                total_spawned: 1,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            recordToolUsageWithTiming(testDir, "timing-test", "Read", 150, true);
            recordToolUsageWithTiming(testDir, "timing-test", "Edit", 500, true);
            recordToolUsageWithTiming(testDir, "timing-test", "Read", 200, true);
            flushPendingWrites();
            const updated = readTrackingState(testDir);
            const agent = updated.agents[0];
            expect(agent.tool_usage).toHaveLength(3);
            expect(agent.tool_usage[0].duration_ms).toBe(150);
            expect(agent.tool_usage[1].duration_ms).toBe(500);
        });
        it("should calculate agent performance with bottleneck detection", () => {
            const state = {
                agents: [
                    {
                        agent_id: "perf-test",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                        tool_usage: [
                            {
                                tool_name: "Read",
                                timestamp: new Date().toISOString(),
                                duration_ms: 100,
                                success: true,
                            },
                            {
                                tool_name: "Read",
                                timestamp: new Date().toISOString(),
                                duration_ms: 200,
                                success: true,
                            },
                            {
                                tool_name: "Bash",
                                timestamp: new Date().toISOString(),
                                duration_ms: 5000,
                                success: true,
                            },
                            {
                                tool_name: "Bash",
                                timestamp: new Date().toISOString(),
                                duration_ms: 6000,
                                success: true,
                            },
                        ],
                    },
                ],
                total_spawned: 1,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const perf = getAgentPerformance(testDir, "perf-test");
            expect(perf).not.toBeNull();
            expect(perf.tool_timings["Read"].count).toBe(2);
            expect(perf.tool_timings["Read"].avg_ms).toBe(150);
            expect(perf.tool_timings["Bash"].avg_ms).toBe(5500);
            expect(perf.bottleneck).toContain("Bash");
        });
    });
    describe("Token Usage (Phase 1.2)", () => {
        it("should update token usage for an agent", () => {
            const state = {
                agents: [
                    {
                        agent_id: "token-test",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                ],
                total_spawned: 1,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            updateTokenUsage(testDir, "token-test", {
                input_tokens: 1000,
                output_tokens: 500,
                cost_usd: 0.05,
            });
            updateTokenUsage(testDir, "token-test", {
                input_tokens: 2000,
                output_tokens: 1000,
                cost_usd: 0.1,
            });
            flushPendingWrites();
            const updated = readTrackingState(testDir);
            const agent = updated.agents[0];
            expect(agent.token_usage).toBeDefined();
            expect(agent.token_usage.input_tokens).toBe(3000);
            expect(agent.token_usage.output_tokens).toBe(1500);
            expect(agent.token_usage.cost_usd).toBeCloseTo(0.15);
        });
    });
    describe("File Ownership (Phase 1.3)", () => {
        it("should record file ownership for an agent", () => {
            const state = {
                agents: [
                    {
                        agent_id: "file-test",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                ],
                total_spawned: 1,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            recordFileOwnership(testDir, "file-test", join(testDir, "src/hooks/bridge.ts"));
            recordFileOwnership(testDir, "file-test", join(testDir, "src/hooks/index.ts"));
            flushPendingWrites();
            const updated = readTrackingState(testDir);
            const agent = updated.agents[0];
            expect(agent.file_ownership).toHaveLength(2);
            const normalized = (agent.file_ownership ?? []).map((p) => String(p).replace(/\\/g, "/").replace(/^\/+/, ""));
            expect(normalized).toContain("src/hooks/bridge.ts");
        });
        it("should detect file conflicts between agents", () => {
            const state = {
                agents: [
                    {
                        agent_id: "agent-1",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                        file_ownership: ["src/hooks/bridge.ts"],
                    },
                    {
                        agent_id: "agent-2",
                        agent_type: "oh-my-claudecode:designer",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                        file_ownership: ["src/hooks/bridge.ts", "src/ui/index.ts"],
                    },
                ],
                total_spawned: 2,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const conflicts = detectFileConflicts(testDir);
            expect(conflicts).toHaveLength(1);
            expect(conflicts[0].file).toBe("src/hooks/bridge.ts");
            expect(conflicts[0].agents).toContain("executor");
            expect(conflicts[0].agents).toContain("designer");
        });
    });
    describe("Intervention (Phase 2)", () => {
        it("should suggest interventions for stale agents", () => {
            const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
            const state = {
                agents: [
                    {
                        agent_id: "stale-agent",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: sixMinutesAgo,
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                ],
                total_spawned: 1,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const interventions = suggestInterventions(testDir);
            expect(interventions).toHaveLength(1);
            expect(interventions[0].type).toBe("timeout");
            expect(interventions[0].suggested_action).toBe("kill");
        });
        it("should suggest intervention for excessive cost", () => {
            const state = {
                agents: [
                    {
                        agent_id: "costly-agent",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                        token_usage: {
                            input_tokens: 100000,
                            output_tokens: 50000,
                            cache_read_tokens: 0,
                            cost_usd: 1.5,
                        },
                    },
                ],
                total_spawned: 1,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const interventions = suggestInterventions(testDir);
            expect(interventions.some((i) => i.type === "excessive_cost")).toBe(true);
        });
        it("should calculate parallel efficiency correctly", () => {
            const state = {
                agents: [
                    {
                        agent_id: "1",
                        agent_type: "executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                    {
                        agent_id: "2",
                        agent_type: "designer",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                    },
                    {
                        agent_id: "3",
                        agent_type: "architect",
                        started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                    }, // stale
                ],
                total_spawned: 3,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const efficiency = calculateParallelEfficiency(testDir);
            expect(efficiency.total).toBe(3);
            expect(efficiency.stale).toBe(1);
            expect(efficiency.active).toBe(2);
            expect(efficiency.score).toBe(67); // 2/3 = 66.67% rounded
        });
    });
    describe("Agent Observatory", () => {
        it("should generate observatory view with all metrics", () => {
            const state = {
                agents: [
                    {
                        agent_id: "obs-agent",
                        agent_type: "oh-my-claudecode:executor",
                        started_at: new Date().toISOString(),
                        parent_mode: "ultrawork",
                        status: "running",
                        tool_usage: [
                            {
                                tool_name: "Read",
                                timestamp: new Date().toISOString(),
                                duration_ms: 100,
                                success: true,
                            },
                        ],
                        token_usage: {
                            input_tokens: 5000,
                            output_tokens: 2000,
                            cache_read_tokens: 0,
                            cost_usd: 0.05,
                        },
                        file_ownership: ["src/test.ts"],
                    },
                ],
                total_spawned: 1,
                total_completed: 0,
                total_failed: 0,
                last_updated: new Date().toISOString(),
            };
            writeTrackingState(testDir, state);
            flushPendingWrites();
            const observatory = getAgentObservatory(testDir);
            expect(observatory.header).toContain("1 active");
            expect(observatory.summary.total_agents).toBe(1);
            expect(observatory.summary.total_cost_usd).toBeCloseTo(0.05);
            expect(observatory.lines.length).toBeGreaterThan(0);
            expect(observatory.lines[0]).toContain("executor");
            expect(observatory.lines[0]).toContain("$0.05");
        });
    });
    describe("processSubagentStop — worktree dirty evidence (#3663)", () => {
        function git(cwd, args) {
            return execFileSync("git", args, {
                cwd,
                encoding: "utf-8",
                stdio: "pipe",
                env: {
                    ...process.env,
                    GIT_AUTHOR_NAME: "Test",
                    GIT_AUTHOR_EMAIL: "test@test.com",
                    GIT_COMMITTER_NAME: "Test",
                    GIT_COMMITTER_EMAIL: "test@test.com",
                    GIT_CONFIG_GLOBAL: "/dev/null",
                    GIT_CONFIG_SYSTEM: "/dev/null",
                },
            }).trim();
        }
        function makeGitRepo() {
            const repoDir = join(testDir, `repo-${Math.random().toString(36).slice(2)}`);
            mkdirSync(join(repoDir, ".omc", "state"), { recursive: true });
            git(repoDir, ["init"]);
            git(repoDir, ["config", "user.email", "test@test.com"]);
            git(repoDir, ["config", "user.name", "Test"]);
            git(repoDir, ["config", "commit.gpgsign", "false"]);
            writeFileSync(join(repoDir, ".gitignore"), ".omc/\n");
            writeFileSync(join(repoDir, "tracked.txt"), "seed\n");
            git(repoDir, ["add", ".gitignore", "tracked.txt"]);
            git(repoDir, ["commit", "-m", "seed"]);
            return repoDir;
        }
        it("records bounded dirty-worktree evidence on abnormal stop", () => {
            const repoDir = makeGitRepo();
            writeFileSync(join(repoDir, "tracked.txt"), "modified\n");
            writeFileSync(join(repoDir, "new.txt"), "untracked work\n");
            processSubagentStart({
                session_id: "sess-dirty-1",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "ag-dirty-1",
                agent_type: "oh-my-claudecode:executor",
                prompt: "build a harness",
            });
            flushPendingWrites();
            const output = processSubagentStop({
                session_id: "sess-dirty-1",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "ag-dirty-1",
                output: "Agent terminated early due to an API error",
                success: false,
            });
            flushPendingWrites();
            // The hook never blocks and never injects context into the dying agent.
            expect(output).toEqual({ continue: true, suppressOutput: true });
            const state = readTrackingState(repoDir, "sess-dirty-1");
            const agent = state.agents.find((a) => a.agent_id === "ag-dirty-1");
            expect(agent?.status).toBe("failed");
            expect(agent?.worktree_evidence?.kind).toBe("dirty");
            expect(agent?.worktree_evidence?.trackedCount).toBe(1);
            expect(agent?.worktree_evidence?.untrackedCount).toBe(1);
            expect(agent?.worktree_evidence?.worktreeRoot).toBe(repoDir);
            // Replay JSONL carries the bounded record for /trace.
            const events = readReplayEvents(repoDir, "sess-dirty-1");
            const stop = events.find((e) => e.event === "agent_stop" && e.agent === "ag-dirty-1".substring(0, 7));
            expect(stop?.dirty_worktree).toMatchObject({
                tracked: 1,
                untracked: 1,
                worktree_root: repoDir,
            });
            // The trace summary surfaces the count.
            expect(getReplaySummary(repoDir, "sess-dirty-1").dirty_worktrees).toBe(1);
            // The worktree is untouched: no commit, no stash, same status.
            expect(git(repoDir, ["status", "--porcelain"])).toContain("tracked.txt");
            expect(git(repoDir, ["rev-list", "--count", "HEAD"])).toBe("1");
            expect(git(repoDir, ["stash", "list"])).toBe("");
        });
        it("detects abnormal termination from the API-error output marker even without success flag", () => {
            const repoDir = makeGitRepo();
            writeFileSync(join(repoDir, "tracked.txt"), "modified\n");
            processSubagentStart({
                session_id: "sess-dirty-2",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "ag-dirty-2",
                agent_type: "oh-my-claudecode:executor",
                prompt: "stall mid-stream",
            });
            flushPendingWrites();
            // SDK omits `success` for API-error terminations (Bug #1 default would
            // mark it completed) — the output marker is what makes it abnormal.
            processSubagentStop({
                session_id: "sess-dirty-2",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "ag-dirty-2",
                output: "API Error: Response stalled mid-stream",
            });
            flushPendingWrites();
            const state = readTrackingState(repoDir, "sess-dirty-2");
            const agent = state.agents.find((a) => a.agent_id === "ag-dirty-2");
            expect(agent?.worktree_evidence?.kind).toBe("dirty");
            expect(agent?.worktree_evidence?.trackedCount).toBe(1);
        });
        it("does not record evidence on normal completion or cancel-like stops", () => {
            const repoDir = makeGitRepo();
            writeFileSync(join(repoDir, "tracked.txt"), "modified\n");
            processSubagentStart({
                session_id: "sess-clean-3",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "ag-clean-3",
                agent_type: "oh-my-claudecode:executor",
                prompt: "normal task",
            });
            flushPendingWrites();
            processSubagentStop({
                session_id: "sess-clean-3",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "ag-clean-3",
                output: "completed normally",
            });
            flushPendingWrites();
            const state = readTrackingState(repoDir, "sess-clean-3");
            const agent = state.agents.find((a) => a.agent_id === "ag-clean-3");
            expect(agent?.status).toBe("completed");
            expect(agent?.worktree_evidence).toBeUndefined();
            // Cancel-like stop (no failure markers) also records nothing.
            processSubagentStart({
                session_id: "sess-cancel-3",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "ag-cancel-3",
                agent_type: "oh-my-claudecode:executor",
                prompt: "cancel me",
            });
            flushPendingWrites();
            processSubagentStop({
                session_id: "sess-cancel-3",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "ag-cancel-3",
                output: "Interrupted by user — cancelling task",
            });
            flushPendingWrites();
            const state2 = readTrackingState(repoDir, "sess-cancel-3");
            const agent2 = state2.agents.find((a) => a.agent_id === "ag-cancel-3");
            expect(agent2?.worktree_evidence).toBeUndefined();
            expect(agent2?.status).toBe("completed");
        });
        it("records non-dirty evidence kinds without failing on non-git stops", () => {
            // Non-git directory: abnormal stop must not break and must not mark dirty.
            processSubagentStart({
                session_id: "sess-ng-4",
                transcript_path: join(testDir, "transcript.jsonl"),
                cwd: testDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "ag-ng-4",
                agent_type: "oh-my-claudecode:executor",
                prompt: "non-git task",
            });
            flushPendingWrites();
            const output = processSubagentStop({
                session_id: "sess-ng-4",
                transcript_path: join(testDir, "transcript.jsonl"),
                cwd: testDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "ag-ng-4",
                output: "Agent terminated early due to an API error",
                success: false,
            });
            flushPendingWrites();
            expect(output).toEqual({ continue: true, suppressOutput: true });
            const state = readTrackingState(testDir, "sess-ng-4");
            const agent = state.agents.find((a) => a.agent_id === "ag-ng-4");
            expect(agent?.status).toBe("failed");
            expect(agent?.worktree_evidence?.kind).toBe("not_git");
        });
        it("derives lifecycle success from abnormal classification across all surfaces (issue #3663 B2)", () => {
            // B2: output-marker-inferred abnormal termination (SDK omits `success`)
            // must mark failed EVERYWHERE: tracking status + counters, replay
            // agent_stop success, and mission board — not just record evidence.
            const repoDir = makeGitRepo();
            writeFileSync(join(repoDir, "tracked.txt"), "modified\n");
            processSubagentStart({
                session_id: "sess-b2-marker",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "ag-b2-marker",
                agent_type: "oh-my-claudecode:executor",
                prompt: "stall mid-stream",
            });
            flushPendingWrites();
            processSubagentStop({
                session_id: "sess-b2-marker",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "ag-b2-marker",
                // No `success` field: the SDK omits it on API-error terminations.
                output: "API Error: Response stalled mid-stream",
            });
            flushPendingWrites();
            const state = readTrackingState(repoDir, "sess-b2-marker");
            const agent = state.agents.find((a) => a.agent_id === "ag-b2-marker");
            // Tracking status + counters derive from the same classification.
            expect(agent?.status).toBe("failed");
            expect(state.total_failed).toBe(1);
            expect(state.total_completed).toBe(0);
            // Replay surface carries the same failure.
            const replayStop = readReplayEvents(repoDir, "sess-b2-marker").find((e) => e.event === "agent_stop" && e.agent === "ag-b2-marker".substring(0, 7));
            expect(replayStop?.success).toBe(false);
            expect(getReplaySummary(repoDir, "sess-b2-marker").agents_failed).toBe(1);
            expect(getReplaySummary(repoDir, "sess-b2-marker").dirty_worktrees).toBe(1);
            // Mission board reflects the failure too.
            const mission = readMissionBoardState(repoDir, "sess-b2-marker")?.missions.find((m) => m.id.startsWith("session:sess-b2-marker:"));
            const missionAgent = mission?.agents.find((a) => a.ownership === "ag-b2-marker");
            expect(missionAgent?.status).toBe("blocked");
            expect(mission?.taskCounts.failed).toBe(0); // mission failed is derived from blocked status
        });
        it("treats a successful final report that mentions API-error phrases as completed (issue #3663 B6)", () => {
            // B6: an explicit/omitted-success stop whose final report merely QUOTES
            // an API-error phrase must be completed — never classified abnormal.
            const repoDir = makeGitRepo();
            processSubagentStart({
                session_id: "sess-b6-quote",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "ag-b6-quote",
                agent_type: "oh-my-claudecode:executor",
                prompt: "investigate API error phrasing",
            });
            flushPendingWrites();
            processSubagentStop({
                session_id: "sess-b6-quote",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "ag-b6-quote",
                output: "Final report: the parser now quotes \"Agent terminated early due to an API error\" and <status>failed</status> as text.",
            });
            flushPendingWrites();
            const state = readTrackingState(repoDir, "sess-b6-quote");
            const agent = state.agents.find((a) => a.agent_id === "ag-b6-quote");
            expect(agent?.status).toBe("completed");
            expect(state.total_completed).toBe(1);
            expect(state.total_failed).toBe(0);
            expect(agent?.worktree_evidence).toBeUndefined();
            const replayStop = readReplayEvents(repoDir, "sess-b6-quote").find((e) => e.event === "agent_stop" && e.agent === "ag-b6-quote".substring(0, 7));
            expect(replayStop?.success).toBe(true);
        });
        it("clears stale dirty-worktree evidence on agent-id reuse to running (issue #3663 B4)", () => {
            // B4: a reused agent ID must not retain dirty evidence from a previous
            // abnormal termination. After restart, a NORMAL stop must not surface
            // stale dirty state/counts.
            const repoDir = makeGitRepo();
            writeFileSync(join(repoDir, "tracked.txt"), "modified\n");
            processSubagentStart({
                session_id: "sess-b4-reuse",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "ag-reused-1",
                agent_type: "oh-my-claudecode:executor",
                prompt: "first run",
            });
            flushPendingWrites();
            // Abnormal termination leaves dirty evidence on the closed entry.
            processSubagentStop({
                session_id: "sess-b4-reuse",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "ag-reused-1",
                output: "Agent terminated early due to an API error",
                success: false,
            });
            flushPendingWrites();
            expect(readTrackingState(repoDir, "sess-b4-reuse").agents.find((a) => a.agent_id === "ag-reused-1")
                ?.worktree_evidence?.kind).toBe("dirty");
            // Clean the worktree, then restart the SAME agent id.
            writeFileSync(join(repoDir, "tracked.txt"), "seed\n");
            git(repoDir, ["checkout", "--", "tracked.txt"]);
            processSubagentStart({
                session_id: "sess-b4-reuse",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "ag-reused-1",
                agent_type: "oh-my-claudecode:executor",
                prompt: "second run",
            });
            flushPendingWrites();
            expect(readTrackingState(repoDir, "sess-b4-reuse").agents.find((a) => a.agent_id === "ag-reused-1")
                ?.worktree_evidence).toBeUndefined();
            // Normal stop after restart: no stale evidence, no dirty count.
            processSubagentStop({
                session_id: "sess-b4-reuse",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "ag-reused-1",
                output: "completed normally",
            });
            flushPendingWrites();
            const state = readTrackingState(repoDir, "sess-b4-reuse");
            const agent = state.agents.find((a) => a.agent_id === "ag-reused-1");
            expect(agent?.status).toBe("completed");
            expect(agent?.worktree_evidence).toBeUndefined();
            expect(state.total_failed).toBe(1); // from the first abnormal lifecycle
            expect(state.total_completed).toBe(1); // from the second normal lifecycle
            expect(getReplaySummary(repoDir, "sess-b4-reuse").dirty_worktrees).toBe(1);
            const replayStops = readReplayEvents(repoDir, "sess-b4-reuse").filter((e) => e.event === "agent_stop" && e.agent === "ag-reused-1".substring(0, 7));
            expect(replayStops).toHaveLength(2);
            // The normal stop carries NO dirty evidence.
            expect(replayStops[1].dirty_worktree).toBeUndefined();
        });
        it("flushes the durable tracking state before the hook returns under lock contention (issue #3663 B8)", () => {
            // B8: the stop hook must write the tracking state DURABLY before
            // returning. writeTrackingState is debounced, so the stop path performs an
            // in-lock durable merge+write (writeTrackingStateLocked) instead, which
            // guarantees the state file carries the closed agent + evidence even when
            // the caller never flushes. See the R1 case below for the lock-scope and
            // bounded-latency contract of that write.
            const repoDir = makeGitRepo();
            writeFileSync(join(repoDir, "tracked.txt"), "modified\n");
            processSubagentStart({
                session_id: "sess-b8-flush",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "ag-b8-flush",
                agent_type: "oh-my-claudecode:executor",
                prompt: "run with flush",
            });
            flushPendingWrites();
            const output = processSubagentStop({
                session_id: "sess-b8-flush",
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "ag-b8-flush",
                output: "Agent terminated early due to an API error",
                success: false,
            });
            // NO caller flush: the hook itself must have flushed durably.
            expect(output).toEqual({ continue: true, suppressOutput: true });
            const state = readTrackingState(repoDir, "sess-b8-flush");
            const agent = state.agents.find((a) => a.agent_id === "ag-b8-flush");
            expect(agent?.status).toBe("failed");
            expect(agent?.worktree_evidence?.kind).toBe("dirty");
            expect(state.total_failed).toBe(1);
        });
        it("persists durably under the already-held lock instead of re-entering it (issue #3663 R1)", () => {
            // R1: processSubagentStop runs its whole body inside withFileLockSync on
            // the session state lock. The lock (src/lib/file-lock.ts) is a
            // non-reentrant O_CREAT|O_EXCL advisory lock and isLockStale() sees the
            // CURRENT process as alive, so a nested acquisition can never succeed: it
            // busy-spins for the full LOCK_OPTS.timeoutMs (500ms) and then degrades to
            // an UNLOCKED, UNMERGED writeTrackingStateImmediate fallback that clobbers
            // whatever a concurrent writer already landed on disk.
            //
            // This test calls the hook with NO external flush and pins all five
            // properties: disk durability, bounded latency, merge-preserving lock
            // scope, no residual debounce entry, and a released lock.
            const repoDir = makeGitRepo();
            writeFileSync(join(repoDir, "tracked.txt"), "modified\n");
            const sessionId = "sess-r1-lock";
            processSubagentStart({
                session_id: sessionId,
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStart",
                agent_id: "ag-r1-stop",
                agent_type: "oh-my-claudecode:executor",
                prompt: "hold the lock exactly once",
            });
            flushPendingWrites();
            // Self-calibrating latency baseline: the hook's only unavoidable cost is
            // the bounded evidence collector, so the nested-lock spin (500ms) is
            // detectable without a machine-speed-dependent absolute threshold.
            const evidenceStartedAt = Date.now();
            collectWorktreeDirtyEvidence(repoDir);
            const evidenceMs = Date.now() - evidenceStartedAt;
            // Make the hook's in-memory snapshot genuinely stale, deterministically.
            // processSubagentStop is fully synchronous (execFileSync + sync fs), and so
            // is everything below, so the 100ms debounce timer seeded here can never
            // fire before the hook returns — no event-loop turn happens in between.
            //
            // 1. Seed the debounce slot with a snapshot that does NOT know about the
            //    peer agent. readTrackingState() serves this pending snapshot to the
            //    hook instead of reading disk.
            // 2. Land a concurrent writer's agent on DISK only.
            //
            // A merge-aware write under the held lock (readDiskState + merge) keeps the
            // peer. The unlocked fallback writes the stale snapshot verbatim and
            // clobbers it.
            const statePath = getStateFilePath(repoDir, sessionId);
            const staleSnapshot = JSON.parse(readFileSync(statePath, "utf-8"));
            writeTrackingState(repoDir, staleSnapshot, sessionId);
            const diskWithPeer = JSON.parse(readFileSync(statePath, "utf-8"));
            diskWithPeer.agents.push({
                agent_id: "ag-concurrent-peer",
                agent_type: "oh-my-claudecode:planner",
                started_at: new Date().toISOString(),
                parent_mode: "team",
                status: "running",
            });
            diskWithPeer.total_spawned += 1;
            writeFileSync(statePath, JSON.stringify(diskWithPeer, null, 2), "utf-8");
            const startedAt = Date.now();
            const output = processSubagentStop({
                session_id: sessionId,
                transcript_path: join(repoDir, "transcript.jsonl"),
                cwd: repoDir,
                permission_mode: "default",
                hook_event_name: "SubagentStop",
                agent_id: "ag-r1-stop",
                output: "Agent terminated early due to an API error",
                success: false,
            });
            const elapsedMs = Date.now() - startedAt;
            expect(output).toEqual({ continue: true, suppressOutput: true });
            // (b) Bounded latency: no nested-lock acquisition spin. The 500ms spin
            // cannot hide inside a 300ms allowance over the collector cost.
            expect(elapsedMs).toBeLessThan(evidenceMs + 300);
            // (a) Durable on DISK with no caller flush — read the file, not the
            // in-memory pending cache that readTrackingState would serve.
            const disk = JSON.parse(readFileSync(statePath, "utf-8"));
            const stopped = disk.agents.find((a) => a.agent_id === "ag-r1-stop");
            expect(stopped?.status).toBe("failed");
            expect(stopped?.worktree_evidence?.kind).toBe("dirty");
            expect(stopped?.worktree_evidence?.trackedCount).toBe(1);
            // (c) Lock scope: the concurrent writer's disk-only agent survived, so the
            // write merged with disk under the lock and never fell back to an
            // unlocked overwrite.
            expect(disk.agents.map((a) => a.agent_id)).toContain("ag-concurrent-peer");
            // Counter merge is preserved too (max of disk and in-memory).
            expect(disk.total_spawned).toBe(2);
            // (e) The lock is released: a zero-timeout acquisition succeeds.
            const handle = acquireFileLockSync(lockPathFor(statePath), {
                timeoutMs: 0,
            });
            expect(handle).not.toBeNull();
            releaseFileLockSync(handle);
            // (d) No residual debounced pending write can resurrect pre-stop state.
            flushPendingWrites();
            const afterFlush = readDiskState(repoDir, sessionId);
            expect(afterFlush.agents.find((a) => a.agent_id === "ag-r1-stop")?.status).toBe("failed");
            expect(afterFlush.agents.map((a) => a.agent_id)).toContain("ag-concurrent-peer");
        });
    });
});
//# sourceMappingURL=index.test.js.map