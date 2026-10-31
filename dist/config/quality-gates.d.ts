/**
 * Configurable quality gates for OMC workflow stages.
 *
 * Gates are configured in the merged PluginConfig `qualityGates` block. A gate
 * names a Claude Code skill, defaults to advisory mode, and may override model.
 */
import type { PluginConfig } from "../shared/types.js";
export declare const QUALITY_GATE_STAGES: readonly ["deep-interview", "ralplan", "omc-review"];
export type QualityGateStage = (typeof QUALITY_GATE_STAGES)[number];
export type QualityGateMode = "blocking" | "advisory";
export type QualityGateEntry = string | QualityGateObject;
export interface QualityGateObject {
    skill: string;
    mode?: QualityGateMode;
    model?: string;
}
export interface NormalizedGate {
    skill: string;
    mode: QualityGateMode;
    model?: string;
}
export type QualityGatesConfig = Partial<Record<QualityGateStage, QualityGateEntry[]>>;
export interface QualityGateValidationError {
    stage: string;
    skillIndex?: number;
    entry?: string;
    error: string;
}
export interface QualityGateSkillResolutionOptions {
    cwd?: string;
    userConfigDir?: string;
    omcRoot?: string;
    bundledSkillsDir?: string;
    pluginRoot?: string | null;
}
export declare function validateSkillName(skill: string): {
    valid: boolean;
    error?: string;
};
export declare function normalizeGate(entry: unknown): NormalizedGate | null;
/** Return the raw quality-gate block from the normal merged user/project config. */
export declare function readQualityGatesConfig(config?: PluginConfig): unknown;
/** Validate every configured stage and return the normalized gates for one stage. */
export declare function readValidatedQualityGates(stage: QualityGateStage, config?: PluginConfig): {
    gates: NormalizedGate[];
    errors: QualityGateValidationError[];
};
/** Resolve a named skill using the same project/user/bundled roots as OMC skill discovery. */
export declare function resolveQualityGateSkillPath(skillName: string, options?: QualityGateSkillResolutionOptions): string | null;
export declare function getGatesForStage(stage: QualityGateStage, config?: PluginConfig): NormalizedGate[];
export declare function getAdvisoryGatesForStage(stage: QualityGateStage, config?: PluginConfig): NormalizedGate[];
export declare function getBlockingGatesForStage(stage: QualityGateStage, config?: PluginConfig): NormalizedGate[];
//# sourceMappingURL=quality-gates.d.ts.map