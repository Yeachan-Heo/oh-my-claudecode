// src/planning/artifacts.ts
/**
 * Planning artifacts reader.
 *
 * Reads .omc/plans/ directory for PRD and test-spec files,
 * and extracts approved execution launch hints embedded in PRD markdown.
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
function readFileSafe(path) {
    try {
        return readFileSync(path, "utf-8");
    }
    catch {
        return null;
    }
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function getSectionContent(markdown, heading) {
    const headingRe = new RegExp(`^##\\s+${escapeRegex(heading)}[ \\t]*$`, "im");
    const headingMatch = headingRe.exec(markdown);
    if (!headingMatch || headingMatch.index === undefined)
        return null;
    const bodyStart = headingMatch.index + headingMatch[0].length;
    const rest = markdown.slice(bodyStart).replace(/^\r?\n/, "");
    const nextHeadingMatch = /\r?\n##\s+/.exec(rest);
    const body = (nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest).trim();
    return body.length > 0 ? body : null;
}
function hasRequiredSections(markdown, headings) {
    return headings.every((heading) => getSectionContent(markdown, heading) !== null);
}
/**
 * Read planning artifacts from .omc/plans/ directory.
 * Returns paths to all PRD and test-spec files found.
 */
export function readPlanningArtifacts(cwd) {
    const plansDir = join(cwd, ".omc", "plans");
    if (!existsSync(plansDir)) {
        return { prdPaths: [], testSpecPaths: [] };
    }
    let entries;
    try {
        entries = readdirSync(plansDir);
    }
    catch {
        return { prdPaths: [], testSpecPaths: [] };
    }
    const prdPaths = [];
    const testSpecPaths = [];
    for (const entry of entries) {
        if (entry.startsWith("prd-") && entry.endsWith(".md")) {
            prdPaths.push(join(plansDir, entry));
        }
        else if (entry.startsWith("test-spec-") && entry.endsWith(".md")) {
            testSpecPaths.push(join(plansDir, entry));
        }
    }
    // Sort descending so newest (lexicographically last) is first
    prdPaths.sort((a, b) => b.localeCompare(a));
    testSpecPaths.sort((a, b) => b.localeCompare(a));
    return { prdPaths, testSpecPaths };
}
/**
 * Returns true when the latest PRD and latest test spec contain
 * the required non-empty quality-gate sections.
 */
export function isPlanningComplete(artifacts) {
    if (artifacts.prdPaths.length === 0 || artifacts.testSpecPaths.length === 0) {
        return false;
    }
    const latestPrd = readFileSafe(artifacts.prdPaths[0]);
    const latestTestSpec = readFileSafe(artifacts.testSpecPaths[0]);
    if (!latestPrd || !latestTestSpec) {
        return false;
    }
    return (hasRequiredSections(latestPrd, [
        "Acceptance criteria",
        "Requirement coverage map",
    ]) &&
        hasRequiredSections(latestTestSpec, [
            "Unit coverage",
            "Verification mapping",
        ]));
}
/**
 * Regex patterns for extracting omc team/ralph launch commands from PRD markdown.
 *
 * Matches lines like:
 *   omc team 3:claude "implement the feature"
 *   omc team 2:codex "fix the bug" --linked-ralph
 *   omc ralph "do the work"
 */
const TEAM_LAUNCH_RE = /\bomc\s+team\s+(?:(\d+):(\w+)\s+)?"([^"]+)"((?:\s+--[\w-]+)*)/;
const RALPH_LAUNCH_RE = /\bomc\s+ralph\s+"([^"]+)"((?:\s+--[\w-]+)*)/;
function parseFlags(flagStr) {
    return {
        linkedRalph: /--linked-ralph/.test(flagStr),
    };
}
/**
 * Read the latest PRD file and extract an embedded launch hint for the given mode.
 * Returns null when no hint is found.
 */
export function readApprovedExecutionLaunchHint(cwd, mode) {
    const artifacts = readPlanningArtifacts(cwd);
    if (artifacts.prdPaths.length === 0)
        return null;
    const prdPath = artifacts.prdPaths[0];
    const content = readFileSafe(prdPath);
    if (!content)
        return null;
    if (mode === "team") {
        const match = TEAM_LAUNCH_RE.exec(content);
        if (!match)
            return null;
        const [fullMatch, workerCountStr, agentType, task, flagStr] = match;
        const { linkedRalph } = parseFlags(flagStr ?? "");
        return {
            mode: "team",
            command: fullMatch.trim(),
            task,
            workerCount: workerCountStr ? parseInt(workerCountStr, 10) : undefined,
            agentType: agentType || undefined,
            linkedRalph,
            sourcePath: prdPath,
        };
    }
    const match = RALPH_LAUNCH_RE.exec(content);
    if (!match)
        return null;
    const [fullMatch, task, flagStr] = match;
    const { linkedRalph } = parseFlags(flagStr ?? "");
    return {
        mode: "ralph",
        command: fullMatch.trim(),
        task,
        linkedRalph,
        sourcePath: prdPath,
    };
}
//# sourceMappingURL=artifacts.js.map