import type { PluginConfig } from "../../shared/types.js";
export type PromptPrerequisiteSectionKind = "memory" | "skills" | "verifyFirst" | "context";
export interface PromptPrerequisiteSection {
    kind: PromptPrerequisiteSectionKind;
    heading: string;
    content: string;
}
export interface PromptPrerequisiteParseResult {
    sections: PromptPrerequisiteSection[];
    requiredToolCalls: string[];
    requiredFilePaths: string[];
}
export interface PromptPrerequisiteState {
    active: boolean;
    session_id?: string;
    execution_keywords: string[];
    required_tool_calls: string[];
    required_file_paths: string[];
    completed_tool_calls: string[];
    completed_file_paths: string[];
    created_at: string;
    updated_at: string;
}
export interface PromptPrerequisiteConfig {
    enabled: boolean;
    sectionNames: Record<PromptPrerequisiteSectionKind, string[]>;
    blockingTools: string[];
    executionKeywords: string[];
}
export interface PromptPrerequisiteProgress {
    toolSatisfied?: string | null;
    fileSatisfied?: string | null;
    remainingToolCalls: string[];
    remainingFilePaths: string[];
    isComplete: boolean;
}
export declare function getPromptPrerequisiteConfig(config?: PluginConfig): PromptPrerequisiteConfig;
export declare function parsePromptPrerequisiteSections(promptText: string, config: PromptPrerequisiteConfig): PromptPrerequisiteParseResult;
export declare function extractRequiredToolCalls(content: string): string[];
export declare function extractFilePaths(content: string): string[];
export declare function shouldEnforcePromptPrerequisites(keywords: string[], parseResult: PromptPrerequisiteParseResult, config: PromptPrerequisiteConfig): boolean;
export declare function readPromptPrerequisiteState(directory: string, sessionId?: string): PromptPrerequisiteState | null;
export declare function clearPromptPrerequisiteState(directory: string, sessionId?: string): boolean;
export declare function activatePromptPrerequisiteState(directory: string, sessionId: string | undefined, executionKeywords: string[], parseResult: PromptPrerequisiteParseResult): PromptPrerequisiteState | null;
export declare function buildPromptPrerequisiteReminder(state: PromptPrerequisiteState): string;
export declare function isPromptPrerequisiteBlockingTool(toolName: string | undefined, config: PromptPrerequisiteConfig): boolean;
export declare function recordPromptPrerequisiteProgress(directory: string, sessionId: string | undefined, toolName: string | undefined, toolInput: unknown): PromptPrerequisiteProgress | null;
export declare function getRemainingPromptPrerequisites(state: PromptPrerequisiteState): {
    remainingToolCalls: string[];
    remainingFilePaths: string[];
};
export declare function buildPromptPrerequisiteDenyReason(state: PromptPrerequisiteState, toolName: string | undefined): string;
//# sourceMappingURL=index.d.ts.map