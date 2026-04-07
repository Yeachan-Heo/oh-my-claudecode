import { isAbsolute, relative } from "node:path";
import { clearModeStateFile, readModeState, writeModeState } from "../../lib/mode-state-io.js";
const STATE_MODE = "prompt-prerequisites";
const DEFAULT_SECTION_NAMES = {
    memory: ["MÉMOIRE", "MEMOIRE", "MEMORY"],
    skills: ["SKILLS"],
    verifyFirst: ["VERIFY-FIRST", "VERIFY FIRST", "VERIFY_FIRST"],
    context: ["CONTEXT"],
};
const DEFAULT_BLOCKING_TOOLS = ["Edit", "MultiEdit", "Write", "Agent", "Task"];
const DEFAULT_EXECUTION_KEYWORDS = ["ralph", "ultrawork", "autopilot"];
const HEADING_PATTERN = /^#{1,6}\s+(.+?)\s*$/gm;
const FILE_PATH_PATTERN = /(?:(?:^|\s|["'`(]))(\.{1,2}\/[^\s"'`)<>\]]+|\/[^\s"'`)<>\]]+|(?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+)(?=$|\s|["'`),:;\]])/gm;
function normalizeHeading(value) {
    return value
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .trim();
}
function dedupe(values) {
    return [...new Set(values)];
}
function normalizePath(value) {
    return value.trim().replace(/^[("'`]+|[)"'`]+$/g, "");
}
function isLikelyPath(value) {
    if (!value)
        return false;
    if (/^https?:\/\//i.test(value))
        return false;
    if (value.startsWith("#"))
        return false;
    if (value.includes("://"))
        return false;
    // Require an explicit path prefix to avoid false positives on
    // slash-separated English words like "read/write", "input/output".
    if (value.startsWith("./") || value.startsWith("../") || value.startsWith("/"))
        return true;
    // For bare relative paths (e.g. "src/foo.ts"), require a recognisable
    // file extension in the last segment to distinguish from natural language.
    const lastSegment = value.split("/").pop() || "";
    return /\.[a-z0-9]{1,10}$/i.test(lastSegment);
}
export function getPromptPrerequisiteConfig(config) {
    const raw = config?.promptPrerequisites;
    return {
        enabled: raw?.enabled !== false,
        sectionNames: {
            memory: dedupe([...(raw?.sectionNames?.memory ?? []), ...DEFAULT_SECTION_NAMES.memory]),
            skills: dedupe([...(raw?.sectionNames?.skills ?? []), ...DEFAULT_SECTION_NAMES.skills]),
            verifyFirst: dedupe([
                ...(raw?.sectionNames?.verifyFirst ?? []),
                ...DEFAULT_SECTION_NAMES.verifyFirst,
            ]),
            context: dedupe([...(raw?.sectionNames?.context ?? []), ...DEFAULT_SECTION_NAMES.context]),
        },
        blockingTools: dedupe(raw?.blockingTools?.length ? raw.blockingTools : DEFAULT_BLOCKING_TOOLS),
        executionKeywords: dedupe(raw?.executionKeywords?.length ? raw.executionKeywords : DEFAULT_EXECUTION_KEYWORDS),
    };
}
function getSectionKind(heading, config) {
    const normalized = normalizeHeading(heading);
    for (const [kind, aliases] of Object.entries(config.sectionNames)) {
        if (aliases.some((alias) => normalizeHeading(alias) === normalized)) {
            return kind;
        }
    }
    return null;
}
export function parsePromptPrerequisiteSections(promptText, config) {
    const sections = [];
    const matches = [...promptText.matchAll(HEADING_PATTERN)];
    for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index];
        const heading = match[1]?.trim() ?? "";
        const kind = getSectionKind(heading, config);
        if (!kind || match.index === undefined) {
            continue;
        }
        const start = match.index + match[0].length;
        const end = index + 1 < matches.length && matches[index + 1].index !== undefined
            ? matches[index + 1].index
            : promptText.length;
        const content = promptText.slice(start, end).trim();
        if (!content) {
            continue;
        }
        sections.push({ kind, heading, content });
    }
    const requiredToolCalls = dedupe(sections.flatMap((section) => extractRequiredToolCalls(section.content)));
    const requiredFilePaths = dedupe(sections.flatMap((section) => extractFilePaths(section.content)));
    return {
        sections,
        requiredToolCalls,
        requiredFilePaths,
    };
}
export function extractRequiredToolCalls(content) {
    const required = [];
    if (/\bnotepad_read\b/i.test(content)) {
        required.push("notepad_read");
    }
    if (/\bproject_memory_read\b/i.test(content)) {
        required.push("project_memory_read");
    }
    if (/\bsupermemory(?:\s+|_)?search\b|\bmcp__supermemory__search\b/i.test(content)) {
        required.push("supermemory.search");
    }
    return required;
}
export function extractFilePaths(content) {
    const paths = [];
    for (const match of content.matchAll(FILE_PATH_PATTERN)) {
        const candidate = normalizePath(match[1] ?? "");
        if (isLikelyPath(candidate)) {
            paths.push(candidate);
        }
    }
    return dedupe(paths);
}
export function shouldEnforcePromptPrerequisites(keywords, parseResult, config) {
    if (!config.enabled) {
        return false;
    }
    if (!keywords.some((keyword) => config.executionKeywords.includes(keyword))) {
        return false;
    }
    return parseResult.requiredToolCalls.length > 0 || parseResult.requiredFilePaths.length > 0;
}
export function readPromptPrerequisiteState(directory, sessionId) {
    return readModeState(STATE_MODE, directory, sessionId);
}
export function clearPromptPrerequisiteState(directory, sessionId) {
    return clearModeStateFile(STATE_MODE, directory, sessionId);
}
export function activatePromptPrerequisiteState(directory, sessionId, executionKeywords, parseResult) {
    if (parseResult.requiredToolCalls.length === 0 && parseResult.requiredFilePaths.length === 0) {
        clearPromptPrerequisiteState(directory, sessionId);
        return null;
    }
    const now = new Date().toISOString();
    const state = {
        active: true,
        session_id: sessionId,
        execution_keywords: executionKeywords,
        required_tool_calls: parseResult.requiredToolCalls,
        required_file_paths: parseResult.requiredFilePaths,
        completed_tool_calls: [],
        completed_file_paths: [],
        created_at: now,
        updated_at: now,
    };
    return writeModeState(STATE_MODE, state, directory, sessionId)
        ? state
        : null;
}
export function buildPromptPrerequisiteReminder(state) {
    const toolList = state.required_tool_calls.length > 0
        ? state.required_tool_calls.map((tool) => `- Call \`${tool}\``).join("\n")
        : "";
    const fileList = state.required_file_paths.length > 0
        ? state.required_file_paths.map((path) => `- Read \`${path}\``).join("\n")
        : "";
    return `<system-reminder>
[BLOCKING PREREQUISITE GATE]
This prompt declared prerequisite context. Before any Edit/Write/Agent/Task tool use, you MUST satisfy every prerequisite below.

Required MCP/tool calls:
${toolList || "- None"}

Required file reads:
${fileList || "- None"}

Do the prerequisite reads first. Do not edit files. Do not spawn/delegate agents until the list is complete.
</system-reminder>`;
}
export function isPromptPrerequisiteBlockingTool(toolName, config) {
    return Boolean(toolName && config.blockingTools.includes(toolName));
}
function matchesToolRequirement(toolName, requiredTool) {
    if (!toolName) {
        return false;
    }
    const normalizedTool = toolName.toLowerCase();
    switch (requiredTool) {
        case "notepad_read":
            return normalizedTool === "notepad_read" || normalizedTool.endsWith("__notepad_read");
        case "project_memory_read":
            return normalizedTool === "project_memory_read" || normalizedTool.endsWith("__project_memory_read");
        case "supermemory.search":
            return normalizedTool === "supermemory_search"
                || normalizedTool === "supermemory.search"
                || /supermemory.*search/i.test(toolName);
        default:
            return normalizedTool === requiredTool.toLowerCase();
    }
}
function extractReadFilePath(toolName, toolInput) {
    if ((toolName || "").toLowerCase() !== "read") {
        return null;
    }
    if (!toolInput || typeof toolInput !== "object") {
        return null;
    }
    const input = toolInput;
    const filePath = input.file_path ?? input.path;
    return typeof filePath === "string" && filePath.trim().length > 0 ? filePath.trim() : null;
}
export function recordPromptPrerequisiteProgress(directory, sessionId, toolName, toolInput) {
    const state = readPromptPrerequisiteState(directory, sessionId);
    if (!state?.active) {
        return null;
    }
    let toolSatisfied = null;
    let fileSatisfied = null;
    for (const requiredTool of state.required_tool_calls) {
        if (!state.completed_tool_calls.includes(requiredTool) && matchesToolRequirement(toolName, requiredTool)) {
            state.completed_tool_calls = dedupe([...state.completed_tool_calls, requiredTool]);
            toolSatisfied = requiredTool;
        }
    }
    const readPath = extractReadFilePath(toolName, toolInput);
    if (readPath) {
        for (const requiredPath of state.required_file_paths) {
            const normalizedRead = normalizePath(readPath);
            const relativeRead = isAbsolute(normalizedRead) ? relative(directory, normalizedRead) : normalizedRead;
            if (!state.completed_file_paths.includes(requiredPath) && (relativeRead === requiredPath || normalizedRead === requiredPath)) {
                state.completed_file_paths = dedupe([...state.completed_file_paths, requiredPath]);
                fileSatisfied = requiredPath;
            }
        }
    }
    const remainingToolCalls = state.required_tool_calls.filter((requiredTool) => !state.completed_tool_calls.includes(requiredTool));
    const remainingFilePaths = state.required_file_paths.filter((requiredPath) => !state.completed_file_paths.includes(requiredPath));
    const isComplete = remainingToolCalls.length === 0 && remainingFilePaths.length === 0;
    if (isComplete) {
        clearPromptPrerequisiteState(directory, sessionId);
    }
    else if (toolSatisfied || fileSatisfied) {
        state.updated_at = new Date().toISOString();
        writeModeState(STATE_MODE, state, directory, sessionId);
    }
    return {
        toolSatisfied,
        fileSatisfied,
        remainingToolCalls,
        remainingFilePaths,
        isComplete,
    };
}
export function getRemainingPromptPrerequisites(state) {
    return {
        remainingToolCalls: state.required_tool_calls.filter((requiredTool) => !state.completed_tool_calls.includes(requiredTool)),
        remainingFilePaths: state.required_file_paths.filter((requiredPath) => !state.completed_file_paths.includes(requiredPath)),
    };
}
export function buildPromptPrerequisiteDenyReason(state, toolName) {
    const remaining = getRemainingPromptPrerequisites(state);
    const toolBits = remaining.remainingToolCalls.length > 0
        ? `Missing tool calls: ${remaining.remainingToolCalls.join(", ")}.`
        : "";
    const fileBits = remaining.remainingFilePaths.length > 0
        ? `Missing file reads: ${remaining.remainingFilePaths.join(", ")}.`
        : "";
    return `[PROMPT PREREQUISITES] Blocking ${toolName || "tool"} until prompt prerequisites are completed. ${toolBits} ${fileBits}`.trim();
}
//# sourceMappingURL=index.js.map