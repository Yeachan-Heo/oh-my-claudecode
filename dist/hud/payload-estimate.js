/**
 * HUD payload byte pressure estimation.
 *
 * Claude Code does not expose the exact serialized Anthropic request body to
 * statusline hooks. The HUD can only observe local session artifacts such as the
 * transcript JSONL path. Transcript size is therefore a conservative signal for
 * screenshot/tool-output-heavy sessions, not an exact API payload byte count.
 */
import { existsSync, statSync } from "fs";
export const ANTHROPIC_REQUEST_PAYLOAD_LIMIT_BYTES = 32_000_000;
export const PAYLOAD_WARNING_BYTES = 22_000_000;
export const PAYLOAD_CRITICAL_BYTES = 26_000_000;
function toPressure(bytes) {
    if (bytes >= PAYLOAD_CRITICAL_BYTES)
        return "critical";
    if (bytes >= PAYLOAD_WARNING_BYTES)
        return "warning";
    return "normal";
}
export function formatPayloadMegabytes(bytes) {
    const mb = bytes / 1_000_000;
    if (mb < 10)
        return mb.toFixed(1);
    return String(Math.round(mb));
}
export function formatPayloadEstimateLabel(estimatedBytes, limitBytes = ANTHROPIC_REQUEST_PAYLOAD_LIMIT_BYTES) {
    return `payload est ~${formatPayloadMegabytes(estimatedBytes)} MB / ${formatPayloadMegabytes(limitBytes)} MB`;
}
export function createPayloadEstimate(estimatedBytes, limitBytes = ANTHROPIC_REQUEST_PAYLOAD_LIMIT_BYTES) {
    if (!Number.isFinite(estimatedBytes) || estimatedBytes < 0)
        return null;
    return {
        estimatedBytes,
        limitBytes,
        pressure: toPressure(estimatedBytes),
        label: formatPayloadEstimateLabel(estimatedBytes, limitBytes),
    };
}
export function estimatePayloadFromTranscriptPath(transcriptPath) {
    if (!transcriptPath || !existsSync(transcriptPath))
        return null;
    try {
        const stat = statSync(transcriptPath);
        if (!stat.isFile())
            return null;
        return createPayloadEstimate(stat.size);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=payload-estimate.js.map