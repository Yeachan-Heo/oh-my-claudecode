import { join, posix } from "path";
import { validatePath } from "../lib/worktree-paths.js";
export const DEFAULT_PLAN_OUTPUT_DIRECTORY = ".omc/plans";
export const DEFAULT_PLAN_OUTPUT_FILENAME_TEMPLATE = "{{name}}.md";
function sanitizePlanOutputSegment(value) {
    const sanitized = value
        .trim()
        .toLowerCase()
        .replace(/\.\./g, "")
        .replace(/[\/]/g, "-")
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    return sanitized || "plan";
}
export function getPlanOutputDirectory(config) {
    const directory = config?.planOutput?.directory?.trim();
    if (!directory)
        return DEFAULT_PLAN_OUTPUT_DIRECTORY;
    try {
        validatePath(directory);
        return directory;
    }
    catch {
        return DEFAULT_PLAN_OUTPUT_DIRECTORY;
    }
}
export function getPlanOutputFilenameTemplate(config) {
    const template = config?.planOutput?.filenameTemplate?.trim();
    if (!template)
        return DEFAULT_PLAN_OUTPUT_FILENAME_TEMPLATE;
    if (template.includes("/") ||
        template.includes("\\") ||
        template.includes("..")) {
        return DEFAULT_PLAN_OUTPUT_FILENAME_TEMPLATE;
    }
    return template;
}
export function resolvePlanOutputFilename(kind, config) {
    const safeKind = sanitizePlanOutputSegment(kind);
    const template = getPlanOutputFilenameTemplate(config);
    const rendered = template
        .replaceAll("{{name}}", safeKind)
        .replaceAll("{{kind}}", safeKind)
        .trim();
    const fallback = DEFAULT_PLAN_OUTPUT_FILENAME_TEMPLATE.replace("{{name}}", safeKind);
    const filename = rendered || fallback;
    if (filename.includes("/") ||
        filename.includes("\\") ||
        filename.includes("..")) {
        return fallback;
    }
    return filename;
}
export function resolvePlanOutputPath(kind, config) {
    return posix.join(getPlanOutputDirectory(config), resolvePlanOutputFilename(kind, config));
}
export function resolvePlanOutputAbsolutePath(directory, kind, config) {
    return join(directory, resolvePlanOutputPath(kind, config));
}
export function resolveAutopilotPlanPath(config) {
    return resolvePlanOutputPath("autopilot-impl", config);
}
export function resolveOpenQuestionsPlanPath(config) {
    return resolvePlanOutputPath("open-questions", config);
}
//# sourceMappingURL=plan-output.js.map