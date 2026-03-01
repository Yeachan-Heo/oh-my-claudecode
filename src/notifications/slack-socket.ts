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
// Validation Types
// ============================================================================

/** Connection states for Slack Socket Mode */
export type SlackConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'authenticated'
  | 'reconnecting';

/** Result of message validation */
export interface SlackValidationResult {
  valid: boolean;
  reason?: string;
}

/** Slack Socket Mode message envelope */
export interface SlackSocketEnvelope {
  envelope_id: string;
  type: string;
  payload?: Record<string, unknown>;
  accepts_response_payload?: boolean;
  retry_attempt?: number;
  retry_reason?: string;
}

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
export function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  body: string,
): boolean {
  if (!signingSecret || !signature || !timestamp) {
    return false;
  }

  // Replay protection: reject stale timestamps
  if (!isTimestampValid(timestamp)) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const expectedSignature =
    'v0=' +
    createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');

  // Timing-safe comparison to prevent timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(signature),
    );
  } catch {
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
export function isTimestampValid(
  timestamp: string,
  maxAgeSeconds: number = MAX_TIMESTAMP_AGE_SECONDS,
): boolean {
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
export function validateSlackEnvelope(
  data: unknown,
): SlackValidationResult {
  if (typeof data !== 'object' || data === null) {
    return { valid: false, reason: 'Message is not an object' };
  }

  const envelope = data as Record<string, unknown>;

  // envelope_id is required for Socket Mode messages
  if (
    typeof envelope.envelope_id !== 'string' ||
    !envelope.envelope_id.trim()
  ) {
    return { valid: false, reason: 'Missing or empty envelope_id' };
  }

  // type is required
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
  private state: SlackConnectionState = 'disconnected';
  private authenticatedAt: number | null = null;
  private reconnectCount = 0;
  private readonly maxReconnectAttempts: number;
  private messageQueue: SlackSocketEnvelope[] = [];
  private readonly maxQueueSize: number;

  constructor(options?: {
    maxReconnectAttempts?: number;
    maxQueueSize?: number;
  }) {
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 5;
    this.maxQueueSize = options?.maxQueueSize ?? 100;
  }

  getState(): SlackConnectionState {
    return this.state;
  }

  getReconnectCount(): number {
    return this.reconnectCount;
  }

  getAuthenticatedAt(): number | null {
    return this.authenticatedAt;
  }

  /** Transition to connecting state. */
  onConnecting(): void {
    this.state = 'connecting';
  }

  /**
   * Transition to authenticated state (received 'hello' message).
   * Resets reconnect counter on successful authentication.
   */
  onAuthenticated(): void {
    this.state = 'authenticated';
    this.authenticatedAt = Date.now();
    this.reconnectCount = 0;
  }

  /**
   * Transition to reconnecting state.
   * Increments reconnect counter and clears authentication timestamp.
   */
  onReconnecting(): void {
    this.state = 'reconnecting';
    this.reconnectCount++;
    this.authenticatedAt = null;
  }

  /**
   * Transition to disconnected state.
   * Clears message queue to prevent processing stale messages.
   */
  onDisconnected(): void {
    this.state = 'disconnected';
    this.authenticatedAt = null;
    this.messageQueue = [];
  }

  /** Check if maximum reconnection attempts have been exceeded. */
  hasExceededMaxReconnects(): boolean {
    return this.reconnectCount >= this.maxReconnectAttempts;
  }

  /**
   * Check if messages can be safely processed in the current state.
   * Only allows processing when the connection is authenticated.
   */
  canProcessMessages(): boolean {
    return this.state === 'authenticated';
  }

  /**
   * Queue a message for processing after reconnection.
   * Drops oldest messages when queue exceeds maxQueueSize to
   * prevent unbounded memory growth.
   *
   * Returns true if queued, false if queue is at capacity (oldest was dropped).
   */
  queueMessage(envelope: SlackSocketEnvelope): boolean {
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
  drainQueue(): SlackSocketEnvelope[] {
    const messages = [...this.messageQueue];
    this.messageQueue = [];
    return messages;
  }

  /** Get current queue size. */
  getQueueSize(): number {
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
export function validateSlackMessage(
  rawMessage: string,
  connectionState: SlackConnectionStateTracker,
  signingSecret?: string,
  signature?: string,
  timestamp?: string,
): SlackValidationResult {
  // 1. Check connection state - reject during reconnection windows
  if (!connectionState.canProcessMessages()) {
    return {
      valid: false,
      reason: `Connection not authenticated (state: ${connectionState.getState()})`,
    };
  }

  // 2. Parse message
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return { valid: false, reason: 'Invalid JSON message' };
  }

  // 3. Validate envelope structure
  const envelopeResult = validateSlackEnvelope(parsed);
  if (!envelopeResult.valid) {
    return envelopeResult;
  }

  // 4. Verify signing secret (when signing material is provided)
  if (signingSecret && signature && timestamp) {
    if (
      !verifySlackSignature(signingSecret, signature, timestamp, rawMessage)
    ) {
      return { valid: false, reason: 'Signature verification failed' };
    }
  } else if (signingSecret && (!signature || !timestamp)) {
    // Signing secret is configured but signing material is missing
    return {
      valid: false,
      reason: 'Signing secret configured but signature/timestamp missing',
    };
  }

  return { valid: true };
}

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
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly baseReconnectDelayMs = 1_000;
  private readonly maxReconnectDelayMs = 30_000;
  private isShuttingDown = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly connectionState = new SlackConnectionStateTracker();

  private readonly log: LogFn;

  constructor(
    private readonly config: SlackSocketConfig,
    private readonly onMessage: MessageHandler,
    log: LogFn,
  ) {
    // Wrap the log function to automatically redact tokens from all messages
    this.log = (msg: string) => log(redactTokens(msg));
  }

  /** Get the connection state tracker for external inspection. */
  getConnectionState(): SlackConnectionStateTracker {
    return this.connectionState;
  }

  /**
   * Start the Socket Mode connection.
   * Obtains a WebSocket URL from Slack and connects.
   */
  async start(): Promise<void> {
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
  stop(): void {
    this.isShuttingDown = true;
    this.connectionState.onDisconnected();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  /**
   * Establish WebSocket connection to Slack Socket Mode.
   */
  private async connect(): Promise<void> {
    if (this.isShuttingDown) return;
    this.connectionState.onConnecting();

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

      const data = await resp.json() as { ok: boolean; url?: string; error?: string };
      if (!data.ok || !data.url) {
        throw new Error(`apps.connections.open failed: ${data.error || 'no url returned'}`);
      }

      // Step 2: Connect via WebSocket
      this.ws = new WebSocket(data.url);

      this.ws.addEventListener('open', () => {
        this.log('Slack Socket Mode connected');
        this.reconnectAttempts = 0;
      });

      this.ws.addEventListener('message', (event) => {
        this.handleEnvelope(String(event.data));
      });

      this.ws.addEventListener('close', () => {
        this.ws = null;
        if (!this.isShuttingDown) {
          this.connectionState.onReconnecting();
          this.log('Slack Socket Mode disconnected, scheduling reconnect');
          this.scheduleReconnect();
        }
      });

      this.ws.addEventListener('error', (e) => {
        this.log(`Slack Socket Mode WebSocket error: ${e instanceof Error ? e.message : 'unknown'}`);
      });

    } catch (error) {
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
  private handleEnvelope(raw: string): void {
    try {
      // Validate envelope structure before processing
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.log('REJECTED Slack message: Invalid JSON');
        return;
      }

      const envelopeValidation = validateSlackEnvelope(parsed);
      if (!envelopeValidation.valid) {
        this.log(`REJECTED Slack message: ${envelopeValidation.reason}`);
        return;
      }

      const envelope = parsed as {
        envelope_id: string;
        type: string;
        payload?: {
          event?: SlackMessageEvent & { subtype?: string };
        };
        reason?: string;
      };

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
        this.connectionState.queueMessage(envelope as unknown as SlackSocketEnvelope);
        return;
      }

      // Verify signing secret if configured
      if (this.config.signingSecret) {
        // Socket Mode doesn't provide HTTP-style headers, but if signing
        // material is embedded in the envelope, verify it
        const envelopeAny = envelope as Record<string, unknown>;
        const sig = envelopeAny['x_slack_signature'] as string | undefined;
        const ts = envelopeAny['x_slack_request_timestamp'] as string | undefined;
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
        if (
          event.type === 'message' &&
          event.channel === this.config.channelId &&
          !event.subtype &&
          event.text
        ) {
          // Fire-and-forget: don't block the WebSocket handler
          Promise.resolve(this.onMessage(event)).catch(err => {
            this.log(`Slack message handler error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }

    } catch (error) {
      this.log(`Slack envelope parse error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.isShuttingDown) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log(`Slack Socket Mode max reconnect attempts (${this.maxReconnectAttempts}) reached`);
      return;
    }

    const delay = Math.min(
      this.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelayMs,
    );
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
export async function postSlackBotMessage(
  botToken: string,
  channel: string,
  text: string,
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, text }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  return await resp.json() as { ok: boolean; ts?: string; error?: string };
}

/**
 * Add a reaction to a Slack message (for injection confirmation).
 */
export async function addSlackReaction(
  botToken: string,
  channel: string,
  timestamp: string,
  emoji: string = 'white_check_mark',
): Promise<void> {
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
export async function replySlackThread(
  botToken: string,
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
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
