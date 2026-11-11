import { QUALITY_GATE_STAGES, readValidatedQualityGates, resolveQualityGateSkillPath, } from "../../config/quality-gates.js";
import { loadConfig } from "../../config/loader.js";
export function buildQualityGatesListReport(stage, options = {}) {
    const { gates, errors } = readValidatedQualityGates(stage, options.config ?? loadConfig());
    const warnings = [];
    const listedGates = gates.map((gate) => {
        let resolvedPath = null;
        try {
            resolvedPath = resolveQualityGateSkillPath(gate.skill, options.skillResolution);
        }
        catch {
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
export function qualityGatesListCommand(stage, json = false, options = {}) {
    const report = buildQualityGatesListReport(stage, options);
    if (json)
        return JSON.stringify(report, null, 2);
    const lines = [`Quality gates for ${report.stage}:`];
    if (report.gates.length === 0)
        lines.push("  (none configured)");
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
        const location = error.skillIndex === undefined
            ? `qualityGates.${error.stage}`
            : `qualityGates.${error.stage}[${error.skillIndex}]`;
        lines.push(`Validation error: ${location}: ${error.error}`);
    }
    return lines.join("\n");
}
export function isQualityGateStage(value) {
    return QUALITY_GATE_STAGES.some((stage) => stage === value);
}
//# sourceMappingURL=quality-gates.js.map