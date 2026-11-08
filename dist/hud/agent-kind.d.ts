/**
 * OMC HUD — Agent kind / ownership classification (issue #3666)
 *
 * Deterministic, backward-compatible metadata that tells a coordinator which
 * mechanism owns an agent or an incoming message sender, and — when OMC can
 * actually observe it — which session spawned the agent.
 *
 * Scope honesty:
 * - `<task-notification>`, `<teammate-message>` and `<agent-message>` are
 *   emitted by Claude Code itself; OMC never rewrites them. OMC's authority
 *   here is classification of the senders when the wrappers appear in
 *   transcript content, and enrichment of OMC's own agent model.
 * - Identity is taken ONLY from the wrapper's own attributes. Payload bodies
 *   are never parsed for identity (a payload claiming `from: "coordinator"`
 *   cannot launder a peer/teammate message into the coordinator's identity),
 *   and payload bytes are never surfaced (redaction).
 * - `tool_result` content is never classified as an incoming wrapper, so an
 *   agent quoting a wrapper inside its output cannot spoof a message.
 */
export type AgentKind = "subagent" | "teammate" | "peer-session" | "unknown";
export interface AgentSpawnIdentity {
    kind: AgentKind;
    /** Session id that issued the spawning tool call, when observable. Absent for legacy payloads. */
    spawnedBy?: string;
}
export interface IncomingAgentMessage {
    kind: AgentKind;
    /** Identity from the wrapper attribute (teammate_id / from / task-id); 'unknown' when absent. */
    senderId: string;
    /**
     * Owning mechanism when OMC can observe it:
     * - teammate: the native Claude team surface ('native-team')
     * - subagent (task-notification): the session the notice was delivered into
     * - peer-session: absent — a peer is its own session with its own permission
     *   context; claiming a spawner would be dishonest and unsafe.
     */
    spawnedBy?: string;
    /** Payload bytes were discarded; only identity metadata is surfaced. */
    redacted: true;
}
/**
 * Classify an agent spawned through a native Task/Agent tool call.
 *
 * Named spawns (name="...") are teammates on the native agent team; unnamed
 * spawns are anonymous subagents. `spawnedBy` is the session that issued the
 * tool call — the only spawn evidence OMC observes in the transcript. Legacy
 * transcripts without a session id keep the kind but carry no spawner claim.
 */
export declare function classifyAgentSpawn(input: {
    hasName: boolean;
    sessionId?: string;
}): AgentSpawnIdentity;
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
export declare function parseIncomingAgentWrapper(content: string, sessionId?: string): IncomingAgentMessage | null;
//# sourceMappingURL=agent-kind.d.ts.map