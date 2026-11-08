/**
 * Slack Socket Mode Client
 *
 * Minimal implementation of Slack Socket Mode for receiving messages.
 * Uses Node.js built-in WebSocket (available in Node 20+) to avoid
 * adding heavy SDK dependencies.
 *
 * Protocol:
 * 1. POST apps.connections.open with app-level token to get WSS URL
 * 2. Connect via WebSocket
 * 3. Receive envelope events, send acknowledgements
 * 4. Handle reconnection with exponential backoff
 *
 * Security:
 * - App-level token (xapp-...) only used for Socket Mode WebSocket
 * - Bot token (xoxb-...) only used for Web API calls
 * - Channel filtering ensures messages from other channels are ignored
 * - HMAC-SHA256 signing secret verification (Slack v0 signatures)
 * - Timestamp-based replay attack prevention (5-minute window)
 * - Message envelope structure validation
 * - Connection state tracking (reject messages during reconnection windows)
 *
 * References:
 * - https://api.slack.com/authentication/verifying-requests-from-slack
 * - https://api.slack.com/apis/socket-mode
 */
/** Connection states for Slack Socket Mode */
export type SlackConnectionState = 'disconnected' | 'connecting' | 'authenticated' | 'reconnecting';
/** Result of message validation */
export interface SlackValidationResult {
    valid: boolean;
    reason?: string;
}
/** Slack Socket Mode message envelope */
export interface SlackSocketEnvelope {
    envelope_id?: string;
    type: string;
    payload?: Record<string, unknown>;
    accepts_response_payload?: boolean;
    retry_attempt?: number;
    retry_reason?: string;
}
/**
 * Verify Slack request signature using HMAC-SHA256.
 *
 * Implements Slack's v0 signing verification:
 *   sig_basestring = 'v0:' + timestamp + ':' + body
 *   signature = 'v0=' + HMAC-SHA256(signing_secret, sig_basestring)
 *
 * Uses timing-safe comparison to prevent timing attacks.
 * Includes replay protection via timestamp validation.
 */
export declare function verifySlackSignature(signingSecret: string, signature: string, timestamp: string, body: string): boolean;
/**
 * Check if a request timestamp is within the acceptable window.
 *
 * Rejects timestamps older than maxAgeSeconds (default: 5 minutes)
 * to prevent replay attacks.
 */
export declare function isTimestampValid(timestamp: string, maxAgeSeconds?: number): boolean;
/**
 * Validate Slack Socket Mode message envelope structure.
 *
 * Ensures the message has required fields and a valid type
 * before it can be processed for session injection.
 */
export declare function validateSlackEnvelope(data: unknown): SlackValidationResult;
/**
 * Connection state tracker for Slack Socket Mode.
 *
 * Tracks authentication status across the connection lifecycle:
 * - disconnected: No WebSocket connection
 * - connecting: WebSocket opening, not yet authenticated
 * - authenticated: Hello message received, ready to process
 * - reconnecting: Connection lost, attempting to re-establish
 *
 * Messages are ONLY processed in the 'authenticated' state.
 * This prevents injection during reconnection windows where
 * authentication has not been re-established.
 */
export declare class SlackConnectionStateTracker {
    private state;
    private authenticatedAt;
    private reconnectCount;
    private readonly maxReconnectAttempts;
    private messageQueue;
    private readonly maxQueueSize;
    constructor(options?: {
        maxReconnectAttempts?: number;
        maxQueueSize?: number;
    });
    getState(): SlackConnectionState;
    getReconnectCount(): number;
    getAuthenticatedAt(): number | null;
    /** Transition to connecting state. */
    onConnecting(): void;
    /**
     * Transition to authenticated state (received 'hello' message).
     * Resets reconnect counter on successful authentication.
     */
    onAuthenticated(): void;
    /**
     * Transition to reconnecting state.
     * Increments reconnect counter and clears authentication timestamp.
     */
    onReconnecting(): void;
    /**
     * Transition to disconnected state.
     * Clears message queue to prevent processing stale messages.
     */
    onDisconnected(): void;
    /** Check if maximum reconnection attempts have been exceeded. */
    hasExceededMaxReconnects(): boolean;
    /**
     * Check if messages can be safely processed in the current state.
     * Only allows processing when the connection is authenticated.
     */
    canProcessMessages(): boolean;
    /**
     * Queue a message for processing after reconnection.
     * Drops oldest messages when queue exceeds maxQueueSize to
     * prevent unbounded memory growth.
     *
     * Returns true if queued, false if queue is at capacity (oldest was dropped).
     */
    queueMessage(envelope: SlackSocketEnvelope): boolean;
    /**
     * Drain the message queue (called after re-authentication).
     * Returns queued messages and clears the queue.
     */
    drainQueue(): SlackSocketEnvelope[];
    /** Get current queue size. */
    getQueueSize(): number;
}
/**
 * Validate a Slack WebSocket message before session injection.
 *
 * Performs all validation checks in order:
 * 1. Connection state verification (must be authenticated)
 * 2. JSON parsing
 * 3. Message envelope structure validation
 * 4. Signing secret verification (when signing material is provided)
 *
 * Returns validation result with reason on failure.
 */
export declare function validateSlackMessage(rawMessage: string, connectionState: SlackConnectionStateTracker, signingSecret?: string, signature?: string, timestamp?: string): SlackValidationResult;
/** Slack message event payload */
export interface SlackMessageEvent {
    type: string;
    channel: string;
    user: string;
    text: string;
    ts: string;
    thread_ts?: string;
}
/** Socket Mode configuration */
export interface SlackSocketConfig {
    appToken: string;
    botToken: string;
    channelId: string;
    /** Optional signing secret for additional message verification */
    signingSecret?: string;
}
type MessageHandler = (event: SlackMessageEvent) => void | Promise<void>;
type LogFn = (message: string) => void;
/**
 * Minimal Slack Socket Mode client.
 *
 * Establishes a WebSocket connection to Slack's Socket Mode endpoint,
 * receives events, acknowledges them, and dispatches message events
 * to the registered handler.
 */
export declare class SlackSocketClient {
    private readonly config;
    private readonly onMessage;
    private ws;
    private reconnectAttempts;
    private readonly maxReconnectAttempts;
    private readonly baseReconnectDelayMs;
    private readonly maxReconnectDelayMs;
    private isShuttingDown;
    private reconnectTimer;
    private readonly connectionState;
    private onWsOpen;
    private onWsMessage;
    private onWsClose;
    private onWsError;
    private readonly log;
    constructor(config: SlackSocketConfig, onMessage: MessageHandler, log: LogFn);
    /** Get the connection state tracker for external inspection. */
    getConnectionState(): SlackConnectionStateTracker;
    /**
     * Start the Socket Mode connection.
     * Obtains a WebSocket URL from Slack and connects.
     */
    start(): Promise<void>;
    /**
     * Gracefully shut down the connection.
     */
    stop(): void;
    /**
     * Remove all event listeners from the current WebSocket, close it,
     * and null the reference. Safe to call multiple times.
     */
    private cleanupWs;
    /**
     * Establish WebSocket connection to Slack Socket Mode.
     */
    private connect;
    /**
     * Process a Socket Mode envelope.
     *
     * Envelope types:
     * - hello: connection established
     * - disconnect: server requesting reconnect
     * - events_api: contains event payloads (messages, etc.)
     */
    private handleEnvelope;
    /**
     * Schedule a reconnection attempt with exponential backoff.
     */
    private scheduleReconnect;
}
/**
 * Send a message via Slack Web API chat.postMessage.
 * Returns the message timestamp (ts) which serves as Slack's message ID.
 */
export declare function postSlackBotMessage(botToken: string, channel: string, text: string): Promise<{
    ok: boolean;
    ts?: string;
    error?: string;
}>;
/**
 * Add a reaction to a Slack message (for injection confirmation).
 */
export declare function addSlackReaction(botToken: string, channel: string, timestamp: string, emoji?: string): Promise<void>;
/**
 * Send a threaded reply in Slack (for injection confirmation).
 */
export declare function replySlackThread(botToken: string, channel: string, threadTs: string, text: string): Promise<void>;
export {};
//# sourceMappingURL=slack-socket.d.ts.map