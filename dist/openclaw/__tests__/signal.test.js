import { describe, expect, it } from "vitest";
import { buildOpenClawSignal } from "../signal.js";
describe("buildOpenClawSignal", () => {
    it("classifies session-start as a high-priority started session signal", () => {
        const signal = buildOpenClawSignal("session-start", {
            sessionId: "sess-1",
        });
        expect(signal).toMatchObject({
            kind: "session",
            phase: "started",
            routeKey: "session.started",
            priority: "high",
        });
    });
    it("classifies bash test commands as high-priority test signals", () => {
        const signal = buildOpenClawSignal("pre-tool-use", {
            toolName: "Bash",
            toolInput: { command: "npm test -- --runInBand" },
        });
        expect(signal).toMatchObject({
            kind: "test",
            name: "test-run",
            phase: "started",
            routeKey: "test.started",
            testRunner: "package-test",
            priority: "high",
        });
    });
    it("classifies failed bash test output as a failed test signal", () => {
        const signal = buildOpenClawSignal("post-tool-use", {
            toolName: "Bash",
            toolInput: { command: "pnpm test" },
            toolOutput: "FAIL src/openclaw/signal.test.ts\nTest failed: expected 1 to be 2",
        });
        expect(signal).toMatchObject({
            kind: "test",
            phase: "failed",
            routeKey: "test.failed",
            priority: "high",
        });
    });
    it("extracts pull request URLs from gh pr create output", () => {
        const signal = buildOpenClawSignal("post-tool-use", {
            toolName: "Bash",
            toolInput: { command: "gh pr create --base dev --fill" },
            toolOutput: "https://github.com/example/oh-my-claudecode/pull/1501",
        });
        expect(signal).toMatchObject({
            kind: "pull-request",
            phase: "finished",
            routeKey: "pull-request.created",
            priority: "high",
            prUrl: "https://github.com/example/oh-my-claudecode/pull/1501",
        });
    });
    it("keeps generic tool completion low priority when no higher-level signal exists", () => {
        const signal = buildOpenClawSignal("post-tool-use", {
            toolName: "Read",
            toolOutput: "file contents",
        });
        expect(signal).toMatchObject({
            kind: "tool",
            phase: "finished",
            routeKey: "tool.finished",
            priority: "low",
        });
    });
});
//# sourceMappingURL=signal.test.js.map