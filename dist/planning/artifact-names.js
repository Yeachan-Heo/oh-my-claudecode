import { basename } from "path";
const PLANNING_ARTIFACT_TIMESTAMP_PATTERN = /^\d{8}T\d{6}Z$/;
export function planningArtifactTimestamp(date = new Date()) {
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function legacyTestSpecSlug(fileNameOrPath) {
    const match = basename(fileNameOrPath).match(/^test-?spec-(?<slug>.+)\.md$/i);
    return match?.groups?.slug ?? null;
}
function requiredTimestampedTestSpecFileName(prdArtifact) {
    return prdArtifact.kind === "prd" && prdArtifact.timestamp
        ? `test-spec-${prdArtifact.timestamp}-${prdArtifact.slug}.md`
        : null;
}
function splitTimestampPrefix(rawSlug) {
    const separatorIndex = rawSlug.indexOf("-");
    if (separatorIndex === -1) {
        return { slug: rawSlug };
    }
    const prefix = rawSlug.slice(0, separatorIndex);
    if (!PLANNING_ARTIFACT_TIMESTAMP_PATTERN.test(prefix)) {
        return { slug: rawSlug };
    }
    return {
        timestamp: prefix,
        slug: rawSlug.slice(separatorIndex + 1),
    };
}
export function parsePlanningArtifactFileName(fileNameOrPath) {
    const fileName = basename(fileNameOrPath);
    const autoresearchDeepInterviewMatch = fileName.match(/^deep-interview-autoresearch-(?<slug>.+)\.md$/i);
    if (autoresearchDeepInterviewMatch?.groups?.slug) {
        const parsedSlug = splitTimestampPrefix(autoresearchDeepInterviewMatch.groups.slug);
        if (!parsedSlug.slug)
            return null;
        return {
            kind: "deep-interview-autoresearch",
            ...parsedSlug,
        };
    }
    const deepInterviewMatch = fileName.match(/^deep-interview-(?<slug>.+)\.md$/i);
    if (deepInterviewMatch?.groups?.slug) {
        const parsedSlug = splitTimestampPrefix(deepInterviewMatch.groups.slug);
        if (!parsedSlug.slug)
            return null;
        return {
            kind: "deep-interview",
            ...parsedSlug,
        };
    }
    const prdMatch = fileName.match(/^prd-(?<slug>.+)\.md$/i);
    if (prdMatch?.groups?.slug) {
        const parsedSlug = splitTimestampPrefix(prdMatch.groups.slug);
        if (!parsedSlug.slug)
            return null;
        return {
            kind: "prd",
            ...parsedSlug,
        };
    }
    const testSpecMatch = fileName.match(/^test-?spec-(?<slug>.+)\.md$/i);
    if (testSpecMatch?.groups?.slug) {
        const parsedSlug = splitTimestampPrefix(testSpecMatch.groups.slug);
        if (!parsedSlug.slug)
            return null;
        return {
            kind: "test-spec",
            ...parsedSlug,
        };
    }
    return null;
}
export function planningArtifactSlug(fileNameOrPath, kind) {
    const parsed = parsePlanningArtifactFileName(fileNameOrPath);
    return parsed?.kind === kind ? parsed.slug : null;
}
export function comparePlanningArtifactPaths(left, right) {
    const leftParsed = parsePlanningArtifactFileName(left);
    const rightParsed = parsePlanningArtifactFileName(right);
    if (leftParsed?.timestamp && rightParsed?.timestamp && leftParsed.timestamp !== rightParsed.timestamp) {
        return leftParsed.timestamp.localeCompare(rightParsed.timestamp);
    }
    if (leftParsed?.timestamp && !rightParsed?.timestamp) {
        return 1;
    }
    if (!leftParsed?.timestamp && rightParsed?.timestamp) {
        return -1;
    }
    return left.localeCompare(right);
}
export function selectMatchingTestSpecsForPrd(prdPath, testSpecPaths) {
    if (!prdPath) {
        return [];
    }
    const prdArtifact = parsePlanningArtifactFileName(prdPath);
    if (prdArtifact?.kind !== "prd") {
        return [];
    }
    const requiredTimestampedFileName = requiredTimestampedTestSpecFileName(prdArtifact);
    return (requiredTimestampedFileName
        ? testSpecPaths.filter((path) => basename(path) === requiredTimestampedFileName)
        : testSpecPaths.filter((path) => legacyTestSpecSlug(path) === prdArtifact.slug))
        .sort(comparePlanningArtifactPaths);
}
export function selectLatestPlanningArtifactPath(paths) {
    return [...paths].sort(comparePlanningArtifactPaths).at(-1) ?? null;
}
//# sourceMappingURL=artifact-names.js.map