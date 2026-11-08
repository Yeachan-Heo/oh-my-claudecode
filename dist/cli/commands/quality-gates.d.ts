import type { PluginConfig } from "../../shared/types.js";
import { readValidatedQualityGates, type QualityGateSkillResolutionOptions, type QualityGateStage } from "../../config/quality-gates.js";
interface ListedGate {
    skill: string;
    mode: "blocking" | "advisory";
    model?: string;
    resolvedPath?: string;
    status?: "gate_unavailable";
}
interface QualityGatesListReport {
    stage: QualityGateStage;
    gates: ListedGate[];
    warnings: Array<{
        gate: string;
        status: "gate_unavailable";
        message: string;
    }>;
    validationErrors: ReturnType<typeof readValidatedQualityGates>["errors"];
}
export interface QualityGatesListOptions {
    config?: PluginConfig;
    skillResolution?: QualityGateSkillResolutionOptions;
}
export declare function buildQualityGatesListReport(stage: QualityGateStage, options?: QualityGatesListOptions): QualityGatesListReport;
export declare function qualityGatesListCommand(stage: QualityGateStage, json?: boolean, options?: QualityGatesListOptions): string;
export declare function isQualityGateStage(value: string): value is QualityGateStage;
export {};
//# sourceMappingURL=quality-gates.d.ts.map