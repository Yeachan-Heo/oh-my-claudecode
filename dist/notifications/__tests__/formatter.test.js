import { describe, it, expect } from "vitest";
import { formatSessionIdle, formatNotification, } from "../formatter.js";
describe("formatSessionIdle", () => {
    const basePayload = {
        event: "session-idle",
        sessionId: "test-session-123",
        message: "",
        timestamp: new Date("2025-01-15T12:00:00Z").toISOString(),
        projectPath: "/home/user/my-project",
        projectName: "my-project",
    };
    it("should include idle header and waiting message", () => {
        const result = formatSessionIdle(basePayload);
        expect(result).toContain("# Session Idle");
        expect(result).toContain("Claude has finished and is waiting for input.");
    });
    it("should include project info in footer", () => {
        const result = formatSessionIdle(basePayload);
        expect(result).toContain("`my-project`");
    });
    it("should include reason when provided", () => {
        const result = formatSessionIdle({
            ...basePayload,
            reason: "task_complete",
        });
        expect(result).toContain("**Reason:** task_complete");
    });
    it("should include modes when provided", () => {
        const result = formatSessionIdle({
            ...basePayload,
            modesUsed: ["ultrawork", "ralph"],
        });
        expect(result).toContain("**Modes:** ultrawork, ralph");
    });
    it("should include contextSummary when provided", () => {
        const result = formatSessionIdle({
            ...basePayload,
            contextSummary: "Refactored auth module and added tests",
        });
        expect(result).toContain("**Summary:** Refactored auth module and added tests");
    });
    it("should not include summary section when contextSummary is absent", () => {
        const result = formatSessionIdle(basePayload);
        expect(result).not.toContain("**Summary:**");
    });
    it("should include tmux session in footer when available", () => {
        const result = formatSessionIdle({
            ...basePayload,
            tmuxSession: "dev-session",
        });
        expect(result).toContain("`dev-session`");
    });
});
describe("formatNotification routing", () => {
    const basePayload = {
        event: "session-idle",
        sessionId: "test-session",
        message: "",
        timestamp: new Date().toISOString(),
        projectPath: "/tmp/test",
    };
    it("should route session-idle to formatSessionIdle", () => {
        const result = formatNotification(basePayload);
        expect(result).toContain("# Session Idle");
    });
    it("should route session-start correctly", () => {
        const result = formatNotification({ ...basePayload, event: "session-start" });
        expect(result).toContain("# Session Started");
    });
    it("should route session-end correctly", () => {
        const result = formatNotification({ ...basePayload, event: "session-end" });
        expect(result).toContain("# Session Ended");
    });
    it("should route session-stop correctly", () => {
        const result = formatNotification({ ...basePayload, event: "session-stop" });
        expect(result).toContain("# Session Continuing");
    });
    it("should route ask-user-question correctly", () => {
        const result = formatNotification({ ...basePayload, event: "ask-user-question" });
        expect(result).toContain("# Input Needed");
    });
});
//# sourceMappingURL=formatter.test.js.map