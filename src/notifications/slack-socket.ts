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
 */

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

  private readonly log: LogFn;

  constructor(
    private readonly config: SlackSocketConfig,
    private readonly onMessage: MessageHandler,
    log: LogFn,
  ) {
    // Wrap the log function to automatically redact tokens from all messages
    this.log = (msg: string) => log(redactTokens(msg));
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
    await this.connect();
  }

  /**
   * Gracefully shut down the connection.
   */
  stop(): void {
    this.isShuttingDown = true;
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
      const envelope = JSON.parse(raw) as {
        envelope_id?: string;
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

      // Handle disconnect requests from Slack
      if (envelope.type === 'disconnect') {
        this.log(`Slack requested disconnect: ${envelope.reason || 'unknown'}`);
        if (this.ws) {
          this.ws.close();
        }
        return;
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
