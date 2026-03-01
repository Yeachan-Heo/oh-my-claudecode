/**
 * Slack WebSocket Message Validation
 *
 * Validates incoming Slack Socket Mode WebSocket messages before they can be
 * injected into Claude Code sessions via the reply-listener.
 *
 * Security measures:
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
// Types
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
