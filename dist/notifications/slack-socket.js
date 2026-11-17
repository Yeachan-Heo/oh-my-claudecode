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
import { createHmac, timingSafeEqual } from 'crypto';
// ============================================================================
// Constants
// ============================================================================
/** Maximum age for request timestamps (5 minutes, per Slack docs) */
const MAX_TIMESTAMP_AGE_SECONDS = 300;
/** Valid Slack Socket Mode envelope types */
const VALID_ENVELOPE_TYPES = new Set([
    'events_api',
    'slash_commands',
    'interactive',
    'hello',
    'disconnect',
]);
// ============================================================================
// Signing Secret Verification
// ============================================================================
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
export function verifySlackSignature(signingSecret, signature, timestamp, body) {
    if (!signingSecret || !signature || !timestamp) {
        return false;
    }
    // Replay protection: reject stale timestamps
    if (!isTimestampValid(timestamp)) {
        return false;
    }
    const sigBasestring = `v0:${timestamp}:${body}`;
    const expectedSignature = 'v0=' +
        createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');
    // Timing-safe comparison to prevent timing attacks
    try {
        return timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));
    }
    catch {
        // Buffer length mismatch means signatures don't match
        return false;
    }
}
// ============================================================================
// Timestamp Validation
// ============================================================================
/**
 * Check if a request timestamp is within the acceptable window.
 *
 * Rejects timestamps older than maxAgeSeconds (default: 5 minutes)
 * to prevent replay attacks.
 */
export function isTimestampValid(timestamp, maxAgeSeconds = MAX_TIMESTAMP_AGE_SECONDS) {
    const requestTime = parseInt(timestamp, 10);
    if (isNaN(requestTime)) {
        return false;
    }
    const now = Math.floor(Date.now() / 1000);
    return Math.abs(now - requestTime) <= maxAgeSeconds;
}
// ============================================================================
// Envelope Validation
// ============================================================================
/**
 * Validate Slack Socket Mode message envelope structure.
 *
 * Ensures the message has required fields and a valid type
 * before it can be processed for session injection.
 */
export function validateSlackEnvelope(data) {
    if (typeof data !== 'object' || data === null) {
        return { valid: false, reason: 'Message is not an object' };
    }
    const envelope = data;
    // type is required and must be known before type-specific requirements.
    if (typeof envelope.type !== 'string' || !envelope.type.trim()) {
        return { valid: false, reason: 'Missing or empty message type' };
    }
    // Validate against known Slack Socket Mode types
    if (!VALID_ENVELOPE_TYPES.has(envelope.type)) {
        return {
            valid: false,
            reason: `Unknown envelope type: ${envelope.type}`,
        };
    }
    const isControlFrame = envelope.type === 'hello' || envelope.type === 'disconnect';
    // envelope_id is required for envelopes that Slack expects us to ACK.
    // Protocol control frames may legitimately omit it.
    if (!isControlFrame &&
        (typeof envelope.envelope_id !== 'string' ||
            !envelope.envelope_id.trim())) {
        return { valid: false, reason: 'Missing or empty envelope_id' };
    }
    // events_api type must have a payload
    if (envelope.type === 'events_api') {
        if (typeof envelope.payload !== 'object' || envelope.payload === null) {
            return {
                valid: false,
                reason: 'events_api envelope missing payload',
            };
        }
    }
    return { valid: true };
}
// ============================================================================
// Connection State Tracker
// ============================================================================
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
export class SlackConnectionStateTracker {
    state = 'disconnected';
    authenticatedAt = null;
    reconnectCount = 0;
    maxReconnectAttempts;
    messageQueue = [];
    maxQueueSize;
    constructor(options) {
        this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 5;
        this.maxQueueSize = options?.maxQueueSize ?? 100;
    }
    getState() {
        return this.state;
    }
    getReconnectCount() {
        return this.reconnectCount;
    }
    getAuthenticatedAt() {
        return this.authenticatedAt;
    }
    /** Transition to connecting state. */
    onConnecting() {
        this.state = 'connecting';
    }
    /**
     * Transition to authenticated state (received 'hello' message).
     * Resets reconnect counter on successful authentication.
     */
    onAuthenticated() {
        this.state = 'authenticated';
        this.authenticatedAt = Date.now();
        this.reconnectCount = 0;
    }
    /**
     * Transition to reconnecting state.
     * Increments reconnect counter and clears authentication timestamp.
     */
    onReconnecting() {
        this.state = 'reconnecting';
        this.reconnectCount++;
        this.authenticatedAt = null;
    }
    /**
     * Transition to disconnected state.
     * Clears message queue to prevent processing stale messages.
     */
    onDisconnected() {
        this.state = 'disconnected';
        this.authenticatedAt = null;
        this.messageQueue = [];
    }
    /** Check if maximum reconnection attempts have been exceeded. */
    hasExceededMaxReconnects() {
        return this.reconnectCount >= this.maxReconnectAttempts;
    }
    /**
     * Check if messages can be safely processed in the current state.
     * Only allows processing when the connection is authenticated.
     */
    canProcessMessages() {
        return this.state === 'authenticated';
    }
    /**
     * Queue a message for processing after reconnection.
     * Drops oldest messages when queue exceeds maxQueueSize to
     * prevent unbounded memory growth.
     *
     * Returns true if queued, false if queue is at capacity (oldest was dropped).
     */
    queueMessage(envelope) {
        const wasFull = this.messageQueue.length >= this.maxQueueSize;
        if (wasFull) {
            this.messageQueue.shift();
        }
        this.messageQueue.push(envelope);
        return !wasFull;
    }
    /**
     * Drain the message queue (called after re-authentication).
     * Returns queued messages and clears the queue.
     */
    drainQueue() {
        const messages = [...this.messageQueue];
        this.messageQueue = [];
        return messages;
    }
    /** Get current queue size. */
    getQueueSize() {
        return this.messageQueue.length;
    }
}
// ============================================================================
// Top-Level Validation
// ============================================================================
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
export function validateSlackMessage(rawMessage, connectionState, signingSecret, signature, timestamp) {
    // 1. Check connection state - reject during reconnection windows
    if (!connectionState.canProcessMessages()) {
        return {
            valid: false,
            reason: `Connection not authenticated (state: ${connectionState.getState()})`,
        };
    }
    // 2. Parse message
    let parsed;
    try {
        parsed = JSON.parse(rawMessage);
    }
    catch {
        return { valid: false, reason: 'Invalid JSON message' };
    }
    // 3. Validate envelope structure
    const envelopeResult = validateSlackEnvelope(parsed);
    if (!envelopeResult.valid) {
        return envelopeResult;
    }
    // 4. Verify signing secret (when signing material is provided)
    if (signingSecret && signature && timestamp) {
        if (!verifySlackSignature(signingSecret, signature, timestamp, rawMessage)) {
            return { valid: false, reason: 'Signature verification failed' };
        }
    }
    else if (signingSecret && (!signature || !timestamp)) {
        // Signing secret is configured but signing material is missing
        return {
            valid: false,
            reason: 'Signing secret configured but signature/timestamp missing',
        };
    }
    return { valid: true };
}
import { redactTokens } from './redact.js';
/** Timeout for Slack API calls */
const API_TIMEOUT_MS = 10_000;
/** Confirmation reaction timeout */
const REACTION_TIMEOUT_MS = 5_000;
/**
 * Minimal Slack Socket Mode client.
 *
 * Establishes a WebSocket connection to Slack's Socket Mode endpoint,
 * receives events, acknowledges them, and dispatches message events
 * to the registered handler.
 */
export class SlackSocketClient {
    config;
    onMessage;
    ws = null;
    reconnectAttempts = 0;
    maxReconnectAttempts = 10;
    baseReconnectDelayMs = 1_000;
    maxReconnectDelayMs = 30_000;
    isShuttingDown = false;
    reconnectTimer = null;
    connectionState = new SlackConnectionStateTracker();
    // Bound listener references for proper removal on cleanup.
    // Typed as generic handlers for addEventListener/removeEventListener compat.
    onWsOpen = null;
    onWsMessage = null;
    onWsClose = null;
    onWsError = null;
    log;
    constructor(config, onMessage, log) {
        this.config = config;
        this.onMessage = onMessage;
        // Wrap the log function to automatically redact tokens from all messages
        this.log = (msg) => log(redactTokens(msg));
    }
    /** Get the connection state tracker for external inspection. */
    getConnectionState() {
        return this.connectionState;
    }
    /**
     * Start the Socket Mode connection.
     * Obtains a WebSocket URL from Slack and connects.
     */
    async start() {
        if (typeof WebSocket === 'undefined') {
            this.log('WARN: WebSocket not available, Slack Socket Mode requires Node 20.10+');
            return;
        }
        this.connectionState.onConnecting();
        await this.connect();
    }
    /**
     * Gracefully shut down the connection.
     */
    stop() {
        this.isShuttingDown = true;
        this.connectionState.onDisconnected();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.cleanupWs();
    }
    /**
     * Remove all event listeners from the current WebSocket, close it,
     * and null the reference. Safe to call multiple times.
     */
    cleanupWs() {
        const ws = this.ws;
        if (!ws)
            return;
        this.ws = null;
        // Remove listeners before closing to prevent callbacks on dead socket
        if (this.onWsOpen)
            ws.removeEventListener('open', this.onWsOpen);
        if (this.onWsMessage)
            ws.removeEventListener('message', this.onWsMessage);
        if (this.onWsClose)
            ws.removeEventListener('close', this.onWsClose);
        if (this.onWsError)
            ws.removeEventListener('error', this.onWsError);
        this.onWsOpen = null;
        this.onWsMessage = null;
        this.onWsClose = null;
        this.onWsError = null;
        try {
            ws.close();
        }
        catch {
            // Ignore close errors on already-closed sockets
        }
    }
    /**
     * Establish WebSocket connection to Slack Socket Mode.
     */
    async connect() {
        if (this.isShuttingDown)
            return;
        this.connectionState.onConnecting();
        // Clean up any previous connection before creating a new one
        this.cleanupWs();
        try {
            // Step 1: Get WebSocket URL via apps.connections.open
            const resp = await fetch('https://slack.com/api/apps.connections.open', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.config.appToken}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                signal: AbortSignal.timeout(API_TIMEOUT_MS),
            });
            const data = await resp.json();
            if (!data.ok || !data.url) {
                throw new Error(`apps.connections.open failed: ${data.error || 'no url returned'}`);
            }
            // Step 2: Connect via WebSocket with tracked listeners
            this.ws = new WebSocket(data.url);
            this.onWsOpen = () => {
                this.log('Slack Socket Mode connected');
                this.reconnectAttempts = 0;
            };
            this.onWsMessage = (event) => {
                const ev = event;
                this.handleEnvelope(String(ev.data));
            };
            this.onWsClose = () => {
                this.cleanupWs();
                if (!this.isShuttingDown) {
                    this.connectionState.onReconnecting();
                    this.log('Slack Socket Mode disconnected, scheduling reconnect');
                    this.scheduleReconnect();
                }
            };
            this.onWsError = (e) => {
                this.log(`Slack Socket Mode WebSocket error: ${e instanceof Error ? e.message : 'unknown'}`);
            };
            this.ws.addEventListener('open', this.onWsOpen);
            this.ws.addEventListener('message', this.onWsMessage);
            this.ws.addEventListener('close', this.onWsClose);
            this.ws.addEventListener('error', this.onWsError);
        }
        catch (error) {
            this.log(`Slack Socket Mode connection error: ${error instanceof Error ? error.message : String(error)}`);
            if (!this.isShuttingDown) {
                this.scheduleReconnect();
            }
        }
    }
    /**
     * Process a Socket Mode envelope.
     *
     * Envelope types:
     * - hello: connection established
     * - disconnect: server requesting reconnect
     * - events_api: contains event payloads (messages, etc.)
     */
    handleEnvelope(raw) {
        try {
            // Validate envelope structure before processing
            let parsed;
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                this.log('REJECTED Slack message: Invalid JSON');
                return;
            }
            const envelopeValidation = validateSlackEnvelope(parsed);
            if (!envelopeValidation.valid) {
                this.log(`REJECTED Slack message: ${envelopeValidation.reason}`);
                return;
            }
            const envelope = parsed;
            // Always acknowledge envelopes that have an ID
            if (envelope.envelope_id && this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
            }
            // Handle hello - marks connection as authenticated
            if (envelope.type === 'hello') {
                this.connectionState.onAuthenticated();
                this.log('Slack Socket Mode authenticated (hello received)');
                // Drain any queued messages from reconnection window
                const queued = this.connectionState.drainQueue();
                if (queued.length > 0) {
                    this.log(`Processing ${queued.length} queued messages after re-authentication`);
                    for (const queuedEnvelope of queued) {
                        this.handleEnvelope(JSON.stringify(queuedEnvelope));
                    }
                }
                return;
            }
            // Handle disconnect requests from Slack
            if (envelope.type === 'disconnect') {
                this.connectionState.onReconnecting();
                this.log(`Slack requested disconnect: ${envelope.reason || 'unknown'}`);
                if (this.ws) {
                    this.ws.close();
                }
                return;
            }
            // Reject messages during reconnection windows
            if (!this.connectionState.canProcessMessages()) {
                this.log(`REJECTED Slack message: connection not authenticated (state: ${this.connectionState.getState()})`);
                // Queue for processing after re-authentication
                this.connectionState.queueMessage(envelope);
                return;
            }
            // Verify signing secret if configured
            if (this.config.signingSecret) {
                // Socket Mode doesn't provide HTTP-style headers, but if signing
                // material is embedded in the envelope, verify it
                const envelopeAny = envelope;
                const sig = envelopeAny['x_slack_signature'];
                const ts = envelopeAny['x_slack_request_timestamp'];
                if (sig && ts) {
                    if (!verifySlackSignature(this.config.signingSecret, sig, ts, raw)) {
                        this.log('REJECTED Slack message: Signature verification failed');
                        return;
                    }
                }
            }
            // Process events_api envelopes containing message events
            if (envelope.type === 'events_api' && envelope.payload?.event) {
                const event = envelope.payload.event;
                // Filter: only 'message' type in our channel, no subtypes (edits, joins, etc.)
                if (event.type === 'message' &&
                    event.channel === this.config.channelId &&
                    !event.subtype &&
                    event.text) {
                    // Fire-and-forget: don't block the WebSocket handler
                    Promise.resolve(this.onMessage(event)).catch(err => {
                        this.log(`Slack message handler error: ${err instanceof Error ? err.message : String(err)}`);
                    });
                }
            }
        }
        catch (error) {
            this.log(`Slack envelope parse error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Schedule a reconnection attempt with exponential backoff.
     */
    scheduleReconnect() {
        if (this.isShuttingDown)
            return;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.log(`Slack Socket Mode max reconnect attempts (${this.maxReconnectAttempts}) reached`);
            return;
        }
        // Clear any existing reconnect timer to prevent leaks on rapid disconnects
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const delay = Math.min(this.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelayMs);
        this.reconnectAttempts++;
        this.log(`Slack Socket Mode reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.isShuttingDown) {
                this.connect();
            }
        }, delay);
    }
}
// ============================================================================
// Slack Web API Helpers
// ============================================================================
/**
 * Send a message via Slack Web API chat.postMessage.
 * Returns the message timestamp (ts) which serves as Slack's message ID.
 */
export async function postSlackBotMessage(botToken, channel, text) {
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${botToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel, text }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    return await resp.json();
}
/**
 * Add a reaction to a Slack message (for injection confirmation).
 */
export async function addSlackReaction(botToken, channel, timestamp, emoji = 'white_check_mark') {
    await fetch('https://slack.com/api/reactions.add', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${botToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel, timestamp, name: emoji }),
        signal: AbortSignal.timeout(REACTION_TIMEOUT_MS),
    });
}
/**
 * Send a threaded reply in Slack (for injection confirmation).
 */
export async function replySlackThread(botToken, channel, threadTs, text) {
    await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${botToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel, text, thread_ts: threadTs }),
        signal: AbortSignal.timeout(REACTION_TIMEOUT_MS),
    });
}
//# sourceMappingURL=slack-socket.js.map