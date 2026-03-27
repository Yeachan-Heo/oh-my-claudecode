import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTranscript } from "../../hud/transcript.js";
import { renderTokenUsage } from "../../hud/elements/token-usage.js";
const tempDirs = [];
function createTempTranscript(lines) {
    const dir = mkdtempSync(join(tmpdir(), "omc-hud-token-usage-"));
    tempDirs.push(dir);
    const transcriptPath = join(dir, "transcript.jsonl");
    writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
    return transcriptPath;
}
afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir)
            rmSync(dir, { recursive: true, force: true });
    }
});
describe("HUD transcript token usage plumbing", () => {
    it("captures the latest transcript message usage as last-request input/output tokens", async () => {
        const transcriptPath = createTempTranscript([
            {
                timestamp: "2026-03-12T00:00:00.000Z",
                message: {
                    usage: { input_tokens: 120, output_tokens: 45 },
                    content: [],
                },
            },
            {
                timestamp: "2026-03-12T00:01:00.000Z",
                message: {
                    usage: { input_tokens: 1530, output_tokens: 987 },
                    content: [],
                },
            },
        ]);
        const result = await parseTranscript(transcriptPath);
        expect(result.lastRequestTokenUsage).toEqual({
            inputTokens: 1530,
            outputTokens: 987,
        });
        expect(result.sessionTotalTokens).toBe(2682);
    });
    it("treats missing token fields as zero when transcript usage only exposes one side", async () => {
        const transcriptPath = createTempTranscript([
            {
                timestamp: "2026-03-12T00:00:00.000Z",
                message: {
                    usage: { output_tokens: 64 },
                    content: [],
                },
            },
        ]);
        const result = await parseTranscript(transcriptPath);
        expect(result.lastRequestTokenUsage).toEqual({
            inputTokens: 0,
            outputTokens: 64,
        });
        expect(result.sessionTotalTokens).toBe(64);
    });
    it("captures reasoning tokens when transcript usage exposes them", async () => {
        const transcriptPath = createTempTranscript([
            {
                timestamp: "2026-03-12T00:00:00.000Z",
                message: {
                    usage: {
                        input_tokens: 1200,
                        output_tokens: 450,
                        output_tokens_details: { reasoning_tokens: 321 },
                    },
                    content: [],
                },
            },
        ]);
        const result = await parseTranscript(transcriptPath);
        expect(result.lastRequestTokenUsage).toEqual({
            inputTokens: 1200,
            outputTokens: 450,
            reasoningTokens: 321,
        });
        expect(result.sessionTotalTokens).toBe(1650);
    });
    it("returns stable transcript results across repeated parses of an unchanged file", async () => {
        const transcriptPath = createTempTranscript([
            {
                timestamp: "2026-03-12T00:00:00.000Z",
                message: {
                    usage: { input_tokens: 120, output_tokens: 45 },
                    content: [],
                },
            },
        ]);
        const first = await parseTranscript(transcriptPath);
        first.todos.push({ content: "mutated", status: "pending" });
        const second = await parseTranscript(transcriptPath);
        expect(second.lastRequestTokenUsage).toEqual({
            inputTokens: 120,
            outputTokens: 45,
        });
        expect(second.todos).toEqual([]);
    });
    it("omits session totals when the transcript contains multiple session IDs", async () => {
        const transcriptPath = createTempTranscript([
            {
                sessionId: "session-a",
                timestamp: "2026-03-12T00:00:00.000Z",
                message: {
                    usage: { input_tokens: 100, output_tokens: 50 },
                    content: [],
                },
            },
            {
                sessionId: "session-b",
                timestamp: "2026-03-12T00:01:00.000Z",
                message: {
                    usage: { input_tokens: 200, output_tokens: 75 },
                    content: [],
                },
            },
        ]);
        const result = await parseTranscript(transcriptPath);
        expect(result.lastRequestTokenUsage).toEqual({
            inputTokens: 200,
            outputTokens: 75,
        });
        expect(result.sessionTotalTokens).toBeUndefined();
    });
});
describe("HUD token usage rendering", () => {
    it("formats last-request token usage as plain ASCII input/output counts", () => {
        expect(renderTokenUsage({ inputTokens: 1530, outputTokens: 987 })).toBe("tok:i1.5k/o987");
    });
    it("includes reasoning and reliable session totals when available", () => {
        expect(renderTokenUsage({ inputTokens: 1530, outputTokens: 987, reasoningTokens: 321 }, 8765)).toBe("tok:i1.5k/o987 r321 s8.8k");
    });
    it("returns null when no last-request token usage is available", () => {
        expect(renderTokenUsage(null)).toBeNull();
    });
});
//# sourceMappingURL=token-usage.test.js.map