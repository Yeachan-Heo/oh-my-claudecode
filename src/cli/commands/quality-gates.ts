import type { PluginConfig } from "../../shared/types.js";
import {
  QUALITY_GATE_STAGES,
  readValidatedQualityGates,
  resolveQualityGateSkillPath,
  type QualityGateSkillResolutionOptions,
  type QualityGateStage,
} from "../../config/quality-gates.js";
import { loadConfig } from "../../config/loader.js";

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

export function buildQualityGatesListReport(
  stage: QualityGateStage,
  options: QualityGatesListOptions = {},
): QualityGatesListReport {
  const { gates, errors } = readValidatedQualityGates(
    stage,
    options.config ?? loadConfig(),
  );
  const warnings: QualityGatesListReport["warnings"] = [];
  const listedGates = gates.map((gate): ListedGate => {
    let resolvedPath: string | null = null;
    try {
      resolvedPath = resolveQualityGateSkillPath(
        gate.skill,
        options.skillResolution,
      );
    } catch {
      // Resolution problems are surfaced as gate_unavailable, never a stage failure.
    }
    if (resolvedPath) {
      return { ...gate, resolvedPath };
    }

    const message = `Quality gate skill '${gate.skill}' could not be resolved; status is gate_unavailable and it will not block the stage.`;
    warnings.push({ gate: gate.skill, status: "gate_unavailable", message });
    return { ...gate, status: "gate_unavailable" };
  });

  return {
    stage,
    gates: listedGates,
    warnings,
    validationErrors: errors,
  };
}

export function qualityGatesListCommand(
  stage: QualityGateStage,
  json = false,
  options: QualityGatesListOptions = {},
): string {
  const report = buildQualityGatesListReport(stage, options);
  if (json) return JSON.stringify(report, null, 2);

  const lines = [`Quality gates for ${report.stage}:`];
  if (report.gates.length === 0) lines.push("  (none configured)");
  for (const gate of report.gates) {
    const details = [
      `mode=${gate.mode}`,
      ...(gate.model ? [`model=${gate.model}`] : []),
      gate.resolvedPath ? `path=${gate.resolvedPath}` : `status=${gate.status}`,
    ];
    lines.push(`  - ${gate.skill} (${details.join(", ")})`);
  }
  for (const warning of report.warnings)
    lines.push(`Warning: ${warning.message}`);
  for (const error of report.validationErrors) {
    const location =
      error.skillIndex === undefined
        ? `qualityGates.${error.stage}`
        : `qualityGates.${error.stage}[${error.skillIndex}]`;
    lines.push(`Validation error: ${location}: ${error.error}`);
  }
  return lines.join("\n");
}

export function isQualityGateStage(value: string): value is QualityGateStage {
  return QUALITY_GATE_STAGES.some((stage) => stage === value);
}
