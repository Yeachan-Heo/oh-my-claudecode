/** Native wrapper tags OMC recognizes (emitted by Claude Code, not OMC). */
const WRAPPER_TAGS = [
    { tag: "task-notification", kind: "subagent" },
    { tag: "teammate-message", kind: "teammate" },
    { tag: "agent-message", kind: "peer-session" },
];
/**
 * Classify an agent spawned through a native Task/Agent tool call.
 *
 * Named spawns (name="...") are teammates on the native agent team; unnamed
 * spawns are anonymous subagents. `spawnedBy` is the session that issued the
 * tool call — the only spawn evidence OMC observes in the transcript. Legacy
 * transcripts without a session id keep the kind but carry no spawner claim.
 */
export function classifyAgentSpawn(input) {
    const spawnedBy = input.sessionId || undefined;
    return input.hasName
        ? { kind: "teammate", spawnedBy }
        : { kind: "subagent", spawnedBy };
}
/** Extract the value of a `name="..."` / `name='...'` attribute from a tag. */
function extractAttribute(openTag, attr) {
    const match = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "i").exec(openTag);
    return match ? match[1] : undefined;
}
/** Extract `<task-id>` / `<task_id>` body from a task-notification payload. */
function extractTaskId(payload) {
    const match = /<task[-_]id>([^<]+)<\/task[-_]id>/i.exec(payload);
    return match ? match[1] : undefined;
}
/**
 * Recognize a native agent wrapper at the start of the message text and
 * classify its sender.
 *
 * Determinism / spoof resistance:
 * - The FIRST (outermost) wrapper in the string wins; quoted wrappers nested
 *   inside a payload are never re-classified.
 * - Identity comes only from the wrapper's own opening-tag attributes.
 * - The payload is discarded; the result carries no payload bytes.
 *
 * @returns the classified sender, or null when the text is not a wrapper.
 */
export function parseIncomingAgentWrapper(content, sessionId) {
    if (!content || typeof content !== "string")
        return null;
    let best = null;
    for (const wrapper of WRAPPER_TAGS) {
        const index = content.indexOf(`<${wrapper.tag}`);
        if (index !== -1 && (best === null || index < best.index)) {
            best = { index, tag: wrapper.tag, kind: wrapper.kind };
        }
    }
    if (!best)
        return null;
    const openTagEnd = content.indexOf(">", best.index);
    if (openTagEnd === -1)
        return null;
    const openTag = content.slice(best.index, openTagEnd + 1);
    switch (best.kind) {
        case "subagent":
            return {
                kind: "subagent",
                senderId: extractTaskId(content.slice(openTagEnd + 1)) ?? "unknown",
                spawnedBy: sessionId || undefined,
                redacted: true,
            };
        case "teammate":
            return {
                kind: "teammate",
                senderId: extractAttribute(openTag, "teammate_id") ?? "unknown",
                spawnedBy: "native-team",
                redacted: true,
            };
        case "peer-session":
            return {
                kind: "peer-session",
                senderId: extractAttribute(openTag, "from") ?? "unknown",
                spawnedBy: undefined,
                redacted: true,
            };
    }
}
//# sourceMappingURL=agent-kind.js.map