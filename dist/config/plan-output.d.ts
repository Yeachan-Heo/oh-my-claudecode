import type { PluginConfig } from "../shared/types.js";
export declare const DEFAULT_PLAN_OUTPUT_DIRECTORY = ".omc/plans";
export declare const DEFAULT_PLAN_OUTPUT_FILENAME_TEMPLATE = "{{name}}.md";
export type PlanOutputKind = "autopilot-impl" | "open-questions";
export declare function getPlanOutputDirectory(config?: PluginConfig): string;
export declare function getPlanOutputFilenameTemplate(config?: PluginConfig): string;
export declare function resolvePlanOutputFilename(kind: string, config?: PluginConfig): string;
export declare function resolvePlanOutputPath(kind: string, config?: PluginConfig): string;
export declare function resolvePlanOutputAbsolutePath(directory: string, kind: string, config?: PluginConfig): string;
export declare function resolveAutopilotPlanPath(config?: PluginConfig): string;
export declare function resolveOpenQuestionsPlanPath(config?: PluginConfig): string;
//# sourceMappingURL=plan-output.d.ts.map