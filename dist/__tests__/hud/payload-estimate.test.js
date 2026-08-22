import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, truncateSync, } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PAYLOAD_CRITICAL_BYTES, PAYLOAD_WARNING_BYTES, createPayloadEstimate, estimatePayloadFromTranscriptPath, formatPayloadEstimateLabel, } from "../../hud/payload-estimate.js";
function writeJsonl(path, lines) {
    writeFileSync(path, `${lines.join("\n")}\n`);
}
describe("HUD payload estimate", () => {
    it("formats approximate MB labels without claiming exact bytes", () => {
        expect(formatPayloadEstimateLabel(22_400_000)).toBe("payload est ~22 MB / 32 MB");
        expect(formatPayloadEstimateLabel(1_500_000)).toBe("payload est ~1.5 MB / 32 MB");
    });
    it("classifies warning and critical thresholds at 22MB and 26MB", () => {
        expect(createPayloadEstimate(PAYLOAD_WARNING_BYTES - 1)?.pressure).toBe("normal");
        expect(createPayloadEstimate(PAYLOAD_WARNING_BYTES)?.pressure).toBe("warning");
        expect(createPayloadEstimate(PAYLOAD_CRITICAL_BYTES)?.pressure).toBe("critical");
    });
    it("estimates from available transcript file size and ignores missing files", () => {
        const dir = mkdtempSync(join(tmpdir(), "omc-payload-est-"));
        try {
            const transcriptPath = join(dir, "transcript.jsonl");
            writeFileSync(transcriptPath, "");
            truncateSync(transcriptPath, PAYLOAD_WARNING_BYTES);
            expect(estimatePayloadFromTranscriptPath(transcriptPath)).toMatchObject({
                estimatedBytes: PAYLOAD_WARNING_BYTES,
                pressure: "warning",
            });
            expect(estimatePayloadFromTranscriptPath(join(dir, "missing.jsonl"))).toBeNull();
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("uses whole transcript size when no compact boundary exists", () => {
        const dir = mkdtempSync(join(tmpdir(), "omc-payload-est-"));
        try {
            const transcriptPath = join(dir, "transcript.jsonl");
            writeJsonl(transcriptPath, [
                JSON.stringify({ type: "message", content: "before" }),
                JSON.stringify({ type: "message", content: "after" }),
            ]);
            expect(estimatePayloadFromTranscriptPath(transcriptPath)?.estimatedBytes).toBe(readFileSync(transcriptPath).length);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("does not treat message content mentioning compact_boundary as a boundary", () => {
        const dir = mkdtempSync(join(tmpdir(), "omc-payload-est-"));
        try {
            const transcriptPath = join(dir, "transcript.jsonl");
            writeJsonl(transcriptPath, [
                JSON.stringify({
                    type: "message",
                    content: "literal compact_boundary text",
                }),
                JSON.stringify({ type: "message", content: "after" }),
            ]);
            expect(estimatePayloadFromTranscriptPath(transcriptPath)?.estimatedBytes).toBe(readFileSync(transcriptPath).length);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("subtracts bytes before and including the last compact boundary", () => {
        const dir = mkdtempSync(join(tmpdir(), "omc-payload-est-"));
        try {
            const transcriptPath = join(dir, "transcript.jsonl");
            const liveEpoch = `${JSON.stringify({ type: "message", content: "live" })}\n`;
            writeFileSync(transcriptPath, `${JSON.stringify({ type: "message", content: "old" })}\n` +
                `${JSON.stringify({ type: "compact_boundary" })}\n` +
                liveEpoch);
            expect(estimatePayloadFromTranscriptPath(transcriptPath)?.estimatedBytes).toBe(Buffer.byteLength(liveEpoch));
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("uses the latest compact boundary when multiple boundaries exist", () => {
        const dir = mkdtempSync(join(tmpdir(), "omc-payload-est-"));
        try {
            const transcriptPath = join(dir, "transcript.jsonl");
            const liveEpoch = `${JSON.stringify({ type: "message", content: "latest" })}\n`;
            writeFileSync(transcriptPath, `${JSON.stringify({ type: "message", content: "old" })}\n` +
                `${JSON.stringify({ type: "compact_boundary" })}\n` +
                `${JSON.stringify({ type: "message", content: "middle" })}\n` +
                `${JSON.stringify({ type: "compact_boundary" })}\n` +
                liveEpoch);
            expect(estimatePayloadFromTranscriptPath(transcriptPath)?.estimatedBytes).toBe(Buffer.byteLength(liveEpoch));
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("does not throw on malformed JSONL lines while finding boundaries", () => {
        const dir = mkdtempSync(join(tmpdir(), "omc-payload-est-"));
        try {
            const transcriptPath = join(dir, "transcript.jsonl");
            const liveEpoch = `{malformed after boundary}\n`;
            writeFileSync(transcriptPath, `{malformed before compact_boundary}\n` +
                `${JSON.stringify({ type: "compact_boundary" })}\n` +
                liveEpoch);
            expect(() => estimatePayloadFromTranscriptPath(transcriptPath)).not.toThrow();
            expect(estimatePayloadFromTranscriptPath(transcriptPath)?.estimatedBytes).toBe(Buffer.byteLength(liveEpoch));
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=payload-estimate.test.js.map