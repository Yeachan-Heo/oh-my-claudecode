/**
 * Tests for Ralphthon PRD Module
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readRalphthonPrd, writeRalphthonPrd, getRalphthonPrdStatus, updateTaskStatus, incrementTaskRetry, updateHardeningTaskStatus, incrementHardeningTaskRetry, addHardeningTasks, createRalphthonPrd, initRalphthonPrd, formatTaskPrompt, formatHardeningTaskPrompt, formatRalphthonStatus, } from "../prd.js";
import { RALPHTHON_DEFAULTS } from "../types.js";
import { DEFAULT_PLANNING_CONTEXT } from "../prd.js";
describe("Ralphthon PRD", () => {
    let testDir;
    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), "ralphthon-prd-test-"));
        // Create .omc directory for PRD storage
        mkdirSync(join(testDir, ".omc"), { recursive: true });
    });
    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });
    // ============================================================================
    // Read/Write Operations
    // ============================================================================
    describe("readRalphthonPrd", () => {
        it("should return null when no PRD exists", () => {
            expect(readRalphthonPrd(testDir)).toBeNull();
        });
        it("should read a valid PRD from .omc directory", () => {
            const prd = createTestPrd();
            writeRalphthonPrd(testDir, prd);
            const result = readRalphthonPrd(testDir);
            expect(result).not.toBeNull();
            expect(result.project).toBe("test-project");
            expect(result.stories).toHaveLength(2);
        });
        it("should return null for invalid JSON", () => {
            const { writeFileSync } = require("fs");
            writeFileSync(join(testDir, ".omc", "ralphthon-prd.json"), "invalid json");
            expect(readRalphthonPrd(testDir)).toBeNull();
        });
        it("should return null for PRD without stories array", () => {
            const { writeFileSync } = require("fs");
            writeFileSync(join(testDir, ".omc", "ralphthon-prd.json"), JSON.stringify({ project: "x", config: {} }));
            expect(readRalphthonPrd(testDir)).toBeNull();
        });
    });
    describe("planningContext normalization", () => {
        it("should normalize missing planning context on read", () => {
            const { writeFileSync } = require("fs");
            const legacy = createTestPrd();
            delete legacy.planningContext;
            writeFileSync(join(testDir, ".omc", "ralphthon-prd.json"), JSON.stringify(legacy));
            const result = readRalphthonPrd(testDir);
            expect(result.planningContext).toEqual(DEFAULT_PLANNING_CONTEXT);
        });
    });
    describe("writeRalphthonPrd", () => {
        it("should write PRD to .omc directory", () => {
            const prd = createTestPrd();
            expect(writeRalphthonPrd(testDir, prd)).toBe(true);
            const result = readRalphthonPrd(testDir);
            expect(result).not.toBeNull();
            expect(result.project).toBe("test-project");
        });
        it("should create .omc directory if missing", () => {
            rmSync(join(testDir, ".omc"), { recursive: true, force: true });
            const prd = createTestPrd();
            expect(writeRalphthonPrd(testDir, prd)).toBe(true);
        });
    });
    // ============================================================================
    // Status Computation
    // ============================================================================
    describe("getRalphthonPrdStatus", () => {
        it("should compute correct status for fresh PRD", () => {
            const prd = createTestPrd();
            const status = getRalphthonPrdStatus(prd);
            expect(status.totalStories).toBe(2);
            expect(status.completedStories).toBe(0);
            expect(status.totalTasks).toBe(3);
            expect(status.completedTasks).toBe(0);
            expect(status.pendingTasks).toBe(3);
            expect(status.allStoriesDone).toBe(false);
            expect(status.nextTask).not.toBeNull();
            expect(status.nextTask.task.id).toBe("T-001");
        });
        it("should detect all stories done", () => {
            const prd = createTestPrd();
            prd.stories[0].tasks[0].status = "done";
            prd.stories[0].tasks[1].status = "done";
            prd.stories[1].tasks[0].status = "done";
            const status = getRalphthonPrdStatus(prd);
            expect(status.allStoriesDone).toBe(true);
            expect(status.completedStories).toBe(2);
            expect(status.nextTask).toBeNull();
        });
        it("should count skipped tasks as story completion", () => {
            const prd = createTestPrd();
            prd.stories[0].tasks[0].status = "done";
            prd.stories[0].tasks[1].status = "skipped";
            const status = getRalphthonPrdStatus(prd);
            expect(status.completedStories).toBe(1); // story 0 complete (done+skipped)
        });
        it("should find next task by story priority", () => {
            const prd = createTestPrd();
            // story[0] has priority 'high', story[1] has 'medium'
            prd.stories[0].tasks[0].status = "done";
            prd.stories[0].tasks[1].status = "done";
            const status = getRalphthonPrdStatus(prd);
            expect(status.nextTask.storyId).toBe("US-002");
        });
        it("should report hardening status", () => {
            const prd = createTestPrd();
            prd.hardening = [
                {
                    id: "H-01-001",
                    title: "Test edge case",
                    description: "test",
                    category: "edge_case",
                    status: "done",
                    wave: 1,
                    retries: 0,
                },
                {
                    id: "H-01-002",
                    title: "Add test",
                    description: "test",
                    category: "test",
                    status: "pending",
                    wave: 1,
                    retries: 0,
                },
            ];
            const status = getRalphthonPrdStatus(prd);
            expect(status.totalHardeningTasks).toBe(2);
            expect(status.completedHardeningTasks).toBe(1);
            expect(status.pendingHardeningTasks).toBe(1);
            expect(status.allHardeningDone).toBe(false);
            expect(status.nextHardeningTask.id).toBe("H-01-002");
        });
    });
    // ============================================================================
    // Task Operations
    // ============================================================================
    describe("updateTaskStatus", () => {
        it("should update a task status", () => {
            const prd = createTestPrd();
            writeRalphthonPrd(testDir, prd);
            expect(updateTaskStatus(testDir, "US-001", "T-001", "done", "Implemented")).toBe(true);
            const updated = readRalphthonPrd(testDir);
            expect(updated.stories[0].tasks[0].status).toBe("done");
            expect(updated.stories[0].tasks[0].notes).toBe("Implemented");
        });
        it("should return false for non-existent story", () => {
            const prd = createTestPrd();
            writeRalphthonPrd(testDir, prd);
            expect(updateTaskStatus(testDir, "US-999", "T-001", "done")).toBe(false);
        });
        it("should return false for non-existent task", () => {
            const prd = createTestPrd();
            writeRalphthonPrd(testDir, prd);
            expect(updateTaskStatus(testDir, "US-001", "T-999", "done")).toBe(false);
        });
    });
    describe("incrementTaskRetry", () => {
        it("should increment retry count", () => {
            const prd = createTestPrd();
            writeRalphthonPrd(testDir, prd);
            const result = incrementTaskRetry(testDir, "US-001", "T-001", 3);
            expect(result.retries).toBe(1);
            expect(result.skipped).toBe(false);
        });
        it("should skip task after max retries", () => {
            const prd = createTestPrd();
            prd.stories[0].tasks[0].retries = 2;
            writeRalphthonPrd(testDir, prd);
            const result = incrementTaskRetry(testDir, "US-001", "T-001", 3);
            expect(result.retries).toBe(3);
            expect(result.skipped).toBe(true);
            const updated = readRalphthonPrd(testDir);
            expect(updated.stories[0].tasks[0].status).toBe("skipped");
        });
    });
    // ============================================================================
    // Hardening Operations
    // ============================================================================
    describe("addHardeningTasks", () => {
        it("should add hardening tasks to PRD", () => {
            const prd = createTestPrd();
            writeRalphthonPrd(testDir, prd);
            const tasks = [
                {
                    id: "H-01-001",
                    title: "Edge case test",
                    description: "Test edge case",
                    category: "edge_case",
                    wave: 1,
                },
                {
                    id: "H-01-002",
                    title: "Add validation",
                    description: "Validate inputs",
                    category: "quality",
                    wave: 1,
                },
            ];
            expect(addHardeningTasks(testDir, tasks)).toBe(true);
            const updated = readRalphthonPrd(testDir);
            expect(updated.hardening).toHaveLength(2);
            expect(updated.hardening[0].status).toBe("pending");
            expect(updated.hardening[0].retries).toBe(0);
        });
        it("should append to existing hardening tasks", () => {
            const prd = createTestPrd();
            prd.hardening = [
                {
                    id: "H-01-001",
                    title: "Existing",
                    description: "existing",
                    category: "test",
                    status: "done",
                    wave: 1,
                    retries: 0,
                },
            ];
            writeRalphthonPrd(testDir, prd);
            addHardeningTasks(testDir, [
                {
                    id: "H-02-001",
                    title: "New",
                    description: "new",
                    category: "quality",
                    wave: 2,
                },
            ]);
            const updated = readRalphthonPrd(testDir);
            expect(updated.hardening).toHaveLength(2);
        });
    });
    describe("updateHardeningTaskStatus", () => {
        it("should update hardening task status", () => {
            const prd = createTestPrd();
            prd.hardening = [
                {
                    id: "H-01-001",
                    title: "Test",
                    description: "test",
                    category: "test",
                    status: "pending",
                    wave: 1,
                    retries: 0,
                },
            ];
            writeRalphthonPrd(testDir, prd);
            expect(updateHardeningTaskStatus(testDir, "H-01-001", "done", "Fixed")).toBe(true);
            const updated = readRalphthonPrd(testDir);
            expect(updated.hardening[0].status).toBe("done");
        });
    });
    describe("incrementHardeningTaskRetry", () => {
        it("should skip hardening task after max retries", () => {
            const prd = createTestPrd();
            prd.hardening = [
                {
                    id: "H-01-001",
                    title: "Test",
                    description: "test",
                    category: "test",
                    status: "pending",
                    wave: 1,
                    retries: 2,
                },
            ];
            writeRalphthonPrd(testDir, prd);
            const result = incrementHardeningTaskRetry(testDir, "H-01-001", 3);
            expect(result.skipped).toBe(true);
        });
    });
    // ============================================================================
    // PRD Creation
    // ============================================================================
    describe("createRalphthonPrd", () => {
        it("should create PRD with default config", () => {
            const stories = [
                {
                    id: "US-001",
                    title: "Test",
                    description: "test",
                    acceptanceCriteria: ["works"],
                    priority: "high",
                    tasks: [
                        {
                            id: "T-001",
                            title: "Do it",
                            description: "do",
                            status: "pending",
                            retries: 0,
                        },
                    ],
                },
            ];
            const prd = createRalphthonPrd("proj", "main", "desc", stories);
            expect(prd.config.maxWaves).toBe(RALPHTHON_DEFAULTS.maxWaves);
            expect(prd.hardening).toEqual([]);
            expect(prd.planningContext).toEqual(DEFAULT_PLANNING_CONTEXT);
        });
        it("should merge custom config", () => {
            const prd = createRalphthonPrd("proj", "main", "desc", [], { maxWaves: 5 }, {
                brownfield: true,
                assumptionsMode: "explicit",
                codebaseMapSummary: "src/",
                knownConstraints: ["legacy"],
            });
            expect(prd.config.maxWaves).toBe(5);
            expect(prd.config.maxRetries).toBe(RALPHTHON_DEFAULTS.maxRetries);
            expect(prd.planningContext).toEqual({
                brownfield: true,
                assumptionsMode: "explicit",
                codebaseMapSummary: "src/",
                knownConstraints: ["legacy"],
            });
        });
    });
    describe("initRalphthonPrd", () => {
        it("should initialize PRD on disk", () => {
            const stories = [
                {
                    id: "US-001",
                    title: "Test",
                    description: "test",
                    acceptanceCriteria: ["works"],
                    priority: "high",
                    tasks: [
                        {
                            id: "T-001",
                            title: "Do it",
                            description: "do",
                            status: "pending",
                            retries: 0,
                        },
                    ],
                },
            ];
            expect(initRalphthonPrd(testDir, "proj", "main", "desc", stories)).toBe(true);
            const prd = readRalphthonPrd(testDir);
            expect(prd).not.toBeNull();
            expect(prd.stories).toHaveLength(1);
            expect(prd.planningContext).toEqual(DEFAULT_PLANNING_CONTEXT);
        });
    });
    // ============================================================================
    // Formatting
    // ============================================================================
    describe("formatTaskPrompt", () => {
        it("should format task prompt for injection", () => {
            const prompt = formatTaskPrompt("US-001", {
                id: "T-001",
                title: "Build API",
                description: "Build REST API endpoints",
                status: "pending",
                retries: 0,
            });
            expect(prompt).toContain("T-001");
            expect(prompt).toContain("US-001");
            expect(prompt).toContain("Build API");
            expect(prompt).toContain("Build REST API endpoints");
        });
    });
    describe("formatHardeningTaskPrompt", () => {
        it("should format hardening task prompt", () => {
            const prompt = formatHardeningTaskPrompt({
                id: "H-01-001",
                title: "Test null case",
                description: "Test what happens with null input",
                category: "edge_case",
                status: "pending",
                wave: 1,
                retries: 0,
            });
            expect(prompt).toContain("HARDENING");
            expect(prompt).toContain("EDGE_CASE");
            expect(prompt).toContain("H-01-001");
        });
    });
    describe("formatRalphthonStatus", () => {
        it("should format status summary", () => {
            const prd = createTestPrd();
            const status = formatRalphthonStatus(prd);
            expect(status).toContain("test-project");
            expect(status).toContain("0/2 complete");
            expect(status).toContain("0/3 done");
        });
    });
});
// ============================================================================
// Test Helpers
// ============================================================================
function createTestPrd() {
    return {
        project: "test-project",
        branchName: "feat/test",
        description: "Test project",
        stories: [
            {
                id: "US-001",
                title: "First story",
                description: "Implement feature A",
                acceptanceCriteria: ["It works", "Tests pass"],
                priority: "high",
                tasks: [
                    {
                        id: "T-001",
                        title: "Build A",
                        description: "Build feature A",
                        status: "pending",
                        retries: 0,
                    },
                    {
                        id: "T-002",
                        title: "Test A",
                        description: "Test feature A",
                        status: "pending",
                        retries: 0,
                    },
                ],
            },
            {
                id: "US-002",
                title: "Second story",
                description: "Implement feature B",
                acceptanceCriteria: ["It works"],
                priority: "medium",
                tasks: [
                    {
                        id: "T-003",
                        title: "Build B",
                        description: "Build feature B",
                        status: "pending",
                        retries: 0,
                    },
                ],
            },
        ],
        hardening: [],
        config: { ...RALPHTHON_DEFAULTS },
        planningContext: {
            brownfield: true,
            assumptionsMode: "explicit",
            codebaseMapSummary: "src/ and planning paths",
            knownConstraints: ["keep diffs small"],
        },
    };
}
//# sourceMappingURL=prd.test.js.map