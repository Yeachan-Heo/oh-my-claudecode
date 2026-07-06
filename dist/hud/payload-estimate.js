/**
 * HUD payload byte pressure estimation.
 *
 * Claude Code does not expose the exact serialized Anthropic request body to
 * statusline hooks. The HUD can only observe local session artifacts such as the
 * transcript JSONL path. Transcript size is therefore a conservative signal for
 * screenshot/tool-output-heavy sessions, not an exact API payload byte count.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "fs";
export const ANTHROPIC_REQUEST_PAYLOAD_LIMIT_BYTES = 32_000_000;
export const PAYLOAD_WARNING_BYTES = 22_000_000;
export const PAYLOAD_CRITICAL_BYTES = 26_000_000;
const COMPACT_BOUNDARY_MARKER = "compact_boundary";
const COMPACT_BOUNDARY_MARKER_BYTES = Buffer.from(COMPACT_BOUNDARY_MARKER);
const SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_BOUNDARY_LINE_BYTES = 256 * 1024;
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
function containsCompactBoundaryMarker(value) {
    if (!value || typeof value !== "object")
        return false;
    if (Array.isArray(value)) {
        return value.some(containsCompactBoundaryMarker);
    }
    return Object.entries(value).some(([key, nestedValue]) => {
        if (key === COMPACT_BOUNDARY_MARKER)
            return true;
        if ((key === "type" ||
            key === "subtype" ||
            key === "event" ||
            key === "kind") &&
            nestedValue === COMPACT_BOUNDARY_MARKER) {
            return true;
        }
        return containsCompactBoundaryMarker(nestedValue);
    });
}
function isCompactBoundaryLine(line) {
    const text = line.toString("utf8").trim();
    if (!text.includes(COMPACT_BOUNDARY_MARKER))
        return false;
    if (text === COMPACT_BOUNDARY_MARKER)
        return true;
    try {
        return containsCompactBoundaryMarker(JSON.parse(text));
    }
    catch {
        return false;
    }
}
function findByteBackward(fd, fromExclusive, byte) {
    let end = fromExclusive;
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    while (end > 0) {
        const start = Math.max(0, end - SCAN_CHUNK_BYTES);
        const length = end - start;
        readSync(fd, buffer, 0, length, start);
        const index = buffer.subarray(0, length).lastIndexOf(byte);
        if (index !== -1)
            return start + index;
        end = start;
    }
    return -1;
}
function findByteForward(fd, fromInclusive, size, byte) {
    let start = fromInclusive;
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    while (start < size) {
        const length = Math.min(SCAN_CHUNK_BYTES, size - start);
        readSync(fd, buffer, 0, length, start);
        const index = buffer.subarray(0, length).indexOf(byte);
        if (index !== -1)
            return start + index;
        start += length;
    }
    return -1;
}
function readLineContainingOffset(fd, size, offset) {
    const previousNewline = findByteBackward(fd, offset, 0x0a);
    const nextNewline = findByteForward(fd, offset, size, 0x0a);
    const startOffset = previousNewline === -1 ? 0 : previousNewline + 1;
    const endOffset = nextNewline === -1 ? size : nextNewline + 1;
    const length = endOffset - startOffset;
    if (length <= 0 || length > MAX_BOUNDARY_LINE_BYTES)
        return null;
    const line = Buffer.allocUnsafe(length);
    readSync(fd, line, 0, length, startOffset);
    return { line, endOffset };
}
function findLastCompactBoundaryEndOffset(transcriptPath, size) {
    if (size <= 0)
        return null;
    const fd = openSync(transcriptPath, "r");
    try {
        let end = size;
        const buffer = Buffer.allocUnsafe(Math.min(SCAN_CHUNK_BYTES, size));
        while (end > 0) {
            const start = Math.max(0, end - SCAN_CHUNK_BYTES);
            const length = end - start;
            readSync(fd, buffer, 0, length, start);
            const chunk = buffer.subarray(0, length);
            let index = chunk.lastIndexOf(COMPACT_BOUNDARY_MARKER_BYTES);
            while (index !== -1) {
                const candidateOffset = start + index;
                const line = readLineContainingOffset(fd, size, candidateOffset);
                if (line && isCompactBoundaryLine(line.line)) {
                    return line.endOffset;
                }
                index = chunk.lastIndexOf(COMPACT_BOUNDARY_MARKER_BYTES, index - 1);
            }
            if (start === 0)
                break;
            end = start + COMPACT_BOUNDARY_MARKER_BYTES.length - 1;
        }
    }
    finally {
        closeSync(fd);
    }
    return null;
}
function estimateTranscriptPayloadBytes(transcriptPath, size) {
    const boundaryEndOffset = findLastCompactBoundaryEndOffset(transcriptPath, size);
    return boundaryEndOffset === null
        ? size
        : Math.max(0, size - boundaryEndOffset);
}
export function estimatePayloadFromTranscriptPath(transcriptPath) {
    if (!transcriptPath || !existsSync(transcriptPath))
        return null;
    try {
        const stat = statSync(transcriptPath);
        if (!stat.isFile())
            return null;
        return createPayloadEstimate(estimateTranscriptPayloadBytes(transcriptPath, stat.size));
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=payload-estimate.js.map