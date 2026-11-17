/**
 * HUD payload byte pressure estimation.
 *
 * Claude Code does not expose the exact serialized Anthropic request body to
 * statusline hooks. The HUD can only observe local session artifacts such as the
 * transcript JSONL path. Transcript size is therefore a conservative signal for
 * screenshot/tool-output-heavy sessions, not an exact API payload byte count.
 */
export declare const ANTHROPIC_REQUEST_PAYLOAD_LIMIT_BYTES = 32000000;
export declare const PAYLOAD_WARNING_BYTES = 22000000;
export declare const PAYLOAD_CRITICAL_BYTES = 26000000;
export type PayloadPressure = "normal" | "warning" | "critical";
export interface PayloadEstimate {
    /** Approximate local transcript-backed payload pressure in bytes. */
    estimatedBytes: number;
    /** API request payload cap used for the warning label. */
    limitBytes: number;
    /** Threshold bucket for color/message selection. */
    pressure: PayloadPressure;
    /** Human-readable label; includes "est" because this is not exact API bytes. */
    label: string;
}
export declare function formatPayloadMegabytes(bytes: number): string;
export declare function formatPayloadEstimateLabel(estimatedBytes: number, limitBytes?: number): string;
export declare function createPayloadEstimate(estimatedBytes: number, limitBytes?: number): PayloadEstimate | null;
export declare function estimatePayloadFromTranscriptPath(transcriptPath: string | null | undefined): PayloadEstimate | null;
//# sourceMappingURL=payload-estimate.d.ts.map