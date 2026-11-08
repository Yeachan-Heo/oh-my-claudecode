import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { render } from "../../hud/render.js";
import { DEFAULT_HUD_CONFIG, } from "../../hud/types.js";
import { PAYLOAD_WARNING_BYTES, createPayloadEstimate, estimatePayloadFromTranscriptPath, } from "../../hud/payload-estimate.js";
const stripAnsi = (value) => value.replace(/\x1b\[[0-9;]*m/g, "");
function baseContext(payloadBytes) {
    return {
        contextPercent: 32,
        modelName: "Claude Opus",
        ralph: null,
        ultrawork: null,
        prd: null,
        autopilot: null,
        activeAgents: [],
        todos: [],
        backgroundTasks: [],
        cwd: "/tmp/project",
        lastSkill: null,
        rateLimitsResult: null,
        customBuckets: null,
        pendingPermission: null,
        thinkingState: null,
        sessionHealth: null,
        omcVersion: "4.14.1",
        updateAvailable: null,
        toolCallCount: 0,
        agentCallCount: 0,
        skillCallCount: 0,
        promptTime: null,
        apiKeySource: null,
        profileName: null,
        sessionSummary: null,
        payloadEstimate: payloadBytes === undefined ? null : createPayloadEstimate(payloadBytes),
    };
}
function config() {
    return {
        ...DEFAULT_HUD_CONFIG,
        elements: {
            ...DEFAULT_HUD_CONFIG.elements,
            model: false,
            omcLabel: false,
            rateLimits: false,
            ralph: false,
            autopilot: false,
            prdStory: false,
            activeSkills: false,
            contextBar: true,
            agents: false,
            backgroundTasks: false,
            todos: false,
            promptTime: false,
            sessionHealth: false,
            showCallCounts: false,
            safeMode: true,
        },
        contextLimitWarning: {
            threshold: 80,
            autoCompact: false,
        },
        layout: {
            line1: [],
            main: ["contextBar"],
            detail: ["contextWarning", "payloadWarning"],
        },
    };
}
describe("HUD payload warning render", () => {
    it("preserves token ctx display while adding warning-only payload signal", async () => {
        const output = stripAnsi(await render(baseContext(22_000_000), config()));
        expect(output).toContain("ctx:32%");
        expect(output).toContain("payload est ~22 MB / 32 MB");
        expect(output).toContain("consider /compact soon");
    });
    it("does not show payload warning below the warning threshold", async () => {
        const output = stripAnsi(await render(baseContext(21_999_999), config()));
        expect(output).toContain("ctx:32%");
        expect(output).not.toContain("payload est");
    });
    it("uses critical copy for red threshold payload pressure", async () => {
        const output = stripAnsi(await render(baseContext(26_000_000), config()));
        expect(output).toContain("payload est ~26 MB / 32 MB");
        expect(output).toContain("compact may fail; consider new session");
    });
    it("does not warn for a large pre-boundary transcript with a small live epoch", async () => {
        const dir = mkdtempSync(join(tmpdir(), "omc-payload-render-"));
        try {
            const transcriptPath = join(dir, "transcript.jsonl");
            writeFileSync(transcriptPath, `${JSON.stringify({ type: "message", content: "x".repeat(100) })}\n`.repeat(260_000));
            writeFileSync(transcriptPath, `${JSON.stringify({ type: "compact_boundary" })}\n${JSON.stringify({ type: "message", content: "small" })}\n`, { flag: "a" });
            const output = stripAnsi(await render({
                ...baseContext(),
                payloadEstimate: estimatePayloadFromTranscriptPath(transcriptPath),
            }, config()));
            expect(output).not.toContain("payload est");
            expect(output).not.toContain("compact may fail");
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("still warns when the post-boundary live epoch is large", async () => {
        const dir = mkdtempSync(join(tmpdir(), "omc-payload-render-"));
        try {
            const transcriptPath = join(dir, "transcript.jsonl");
            writeFileSync(transcriptPath, `${JSON.stringify({ type: "compact_boundary" })}\n`);
            writeFileSync(transcriptPath, "x".repeat(PAYLOAD_WARNING_BYTES), {
                flag: "a",
            });
            const output = stripAnsi(await render({
                ...baseContext(),
                payloadEstimate: estimatePayloadFromTranscriptPath(transcriptPath),
            }, config()));
            expect(output).toContain("payload est ~22 MB / 32 MB");
            expect(output).toContain("consider /compact soon");
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=payload-warning-render.test.js.map