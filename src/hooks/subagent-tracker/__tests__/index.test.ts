import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  recordToolUsage,
  getAgentDashboard,
  getStaleAgents,
  getTrackingStats,
  readTrackingState,
  writeTrackingState,
  clearTrackingState,
  recordToolUsageWithTiming,
  getAgentPerformance,
  updateTokenUsage,
  recordFileOwnership,
  detectFileConflicts,
  suggestInterventions,
  calculateParallelEfficiency,
  getAgentObservatory,
  flushPendingWrites,
  type SubagentInfo,
  type SubagentTrackingState,
  type ToolUsageEntry,
  type TokenUsage,
} from "../index.js";

describe("subagent-tracker", () => {
  let testDir: string;

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
      const state: SubagentTrackingState = {
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
      const agent = updatedState.agents.find(
        (a) => a.agent_id === "test-agent-123",
      );
      expect(agent).toBeDefined();
      expect(agent?.tool_usage).toHaveLength(1);
      expect(agent?.tool_usage?.[0].tool_name).toBe("proxy_Read");
      expect(agent?.tool_usage?.[0].success).toBe(true);
      expect(agent?.tool_usage?.[0].timestamp).toBeDefined();
    });

    it("should not record for non-existent agent", () => {
      // Setup: empty state
      const state: SubagentTrackingState = {
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
      const toolUsage: ToolUsageEntry[] = Array.from(
        { length: 50 },
        (_, i) => ({
          tool_name: `tool-${i}`,
          timestamp: new Date().toISOString(),
          success: true,
        }),
      );

      const state: SubagentTrackingState = {
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
      const agent = updatedState.agents.find(
        (a) => a.agent_id === "test-agent-123",
      );
      expect(agent?.tool_usage).toHaveLength(50);
      expect(agent?.tool_usage?.[0].tool_name).toBe("tool-1"); // First one removed
      expect(agent?.tool_usage?.[49].tool_name).toBe("new-tool"); // New one added
    });

    it("should include timestamp and success flag", () => {
      // Setup: create a running agent
      const state: SubagentTrackingState = {
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
      const agent = updatedState.agents.find(
        (a) => a.agent_id === "test-agent-123",
      );
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
      const state: SubagentTrackingState = {
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
      const state: SubagentTrackingState = {
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
      const agents: SubagentInfo[] = Array.from({ length: 5 }, (_, i) => ({
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

      const state: SubagentTrackingState = {
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
      const state: SubagentTrackingState = {
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
      const state: SubagentTrackingState = {
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
      const state: SubagentTrackingState = {
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
      const state: SubagentTrackingState = {
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
      const state: SubagentTrackingState = {
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

      const state: SubagentTrackingState = {
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

      const state: SubagentTrackingState = {
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
      const state: SubagentTrackingState = {
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
      const state: SubagentTrackingState = {
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

  describe("Tool Timing (Phase 1.1)", () => {
    it("should record tool usage with timing data", () => {
      // Setup: create a running agent
      const state: SubagentTrackingState = {
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
      expect(agent.tool_usage![0].duration_ms).toBe(150);
      expect(agent.tool_usage![1].duration_ms).toBe(500);
    });

    it("should calculate agent performance with bottleneck detection", () => {
      const state: SubagentTrackingState = {
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
      expect(perf!.tool_timings["Read"].count).toBe(2);
      expect(perf!.tool_timings["Read"].avg_ms).toBe(150);
      expect(perf!.tool_timings["Bash"].avg_ms).toBe(5500);
      expect(perf!.bottleneck).toContain("Bash");
    });
  });

  describe("Token Usage (Phase 1.2)", () => {
    it("should update token usage for an agent", () => {
      const state: SubagentTrackingState = {
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
      expect(agent.token_usage!.input_tokens).toBe(3000);
      expect(agent.token_usage!.output_tokens).toBe(1500);
      expect(agent.token_usage!.cost_usd).toBeCloseTo(0.15);
    });
  });

  describe("File Ownership (Phase 1.3)", () => {
    it("should record file ownership for an agent", () => {
      const state: SubagentTrackingState = {
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

      recordFileOwnership(
        testDir,
        "file-test",
        join(testDir, "src/hooks/bridge.ts"),
      );
      recordFileOwnership(
        testDir,
        "file-test",
        join(testDir, "src/hooks/index.ts"),
      );
      flushPendingWrites();

      const updated = readTrackingState(testDir);
      const agent = updated.agents[0];
      expect(agent.file_ownership).toHaveLength(2);
      const normalized = (agent.file_ownership ?? []).map((p) =>
        String(p).replace(/\\/g, "/").replace(/^\/+/, ""),
      );
      expect(normalized).toContain("src/hooks/bridge.ts");
    });

    it("should detect file conflicts between agents", () => {
      const state: SubagentTrackingState = {
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
      const state: SubagentTrackingState = {
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
      const state: SubagentTrackingState = {
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
      const state: SubagentTrackingState = {
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
      const state: SubagentTrackingState = {
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
});
