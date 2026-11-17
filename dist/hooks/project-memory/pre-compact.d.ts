/**
 * PreCompact Handler for Project Memory
 * Ensures project memory (especially user directives) survives compaction
 */
export interface PreCompactInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    hook_event_name: 'PreCompact';
    trigger: 'manual' | 'auto';
    custom_instructions?: string;
}
export interface PreCompactOutput {
    continue: boolean;
    systemMessage?: string;
}
/**
 * Process PreCompact hook - inject project memory into system message
 * This ensures user directives and project context survive compaction
 */
export declare function processPreCompact(input: PreCompactInput): Promise<PreCompactOutput>;
//# sourceMappingURL=pre-compact.d.ts.map