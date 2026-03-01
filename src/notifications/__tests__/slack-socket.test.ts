import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import {
  verifySlackSignature,
  isTimestampValid,
  validateSlackEnvelope,
  validateSlackMessage,
  SlackConnectionStateTracker,
} from '../slack-socket.js';

// ============================================================================
// Helper: generate a valid Slack v0 signature
// ============================================================================

function generateSlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
): string {
  const sigBasestring = `v0:${timestamp}:${body}`;
  return (
    'v0=' + createHmac('sha256', signingSecret).update(sigBasestring).digest('hex')
  );
}

function currentTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

// ============================================================================
// verifySlackSignature
// ============================================================================

describe('verifySlackSignature', () => {
  const signingSecret = 'test_signing_secret_abc123';
  const body = '{"type":"event_callback","event":{"text":"hello"}}';

  it('accepts a valid signature', () => {
    const ts = currentTimestamp();
    const sig = generateSlackSignature(signingSecret, ts, body);
    expect(verifySlackSignature(signingSecret, sig, ts, body)).toBe(true);
  });

  it('rejects an invalid signature', () => {
    const ts = currentTimestamp();
    expect(
      verifySlackSignature(signingSecret, 'v0=invalid_hex', ts, body),
    ).toBe(false);
  });

  it('rejects a signature with wrong secret', () => {
    const ts = currentTimestamp();
    const sig = generateSlackSignature('wrong_secret', ts, body);
    expect(verifySlackSignature(signingSecret, sig, ts, body)).toBe(false);
  });

  it('rejects a signature with tampered body', () => {
    const ts = currentTimestamp();
    const sig = generateSlackSignature(signingSecret, ts, body);
    expect(
      verifySlackSignature(signingSecret, sig, ts, body + 'tampered'),
    ).toBe(false);
  });

  it('rejects when timestamp is too old (replay attack)', () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 600); // 10 minutes ago
    const sig = generateSlackSignature(signingSecret, staleTs, body);
    expect(verifySlackSignature(signingSecret, sig, staleTs, body)).toBe(
      false,
    );
  });

  it('rejects empty signing secret', () => {
    const ts = currentTimestamp();
    expect(verifySlackSignature('', 'v0=abc', ts, body)).toBe(false);
  });

  it('rejects empty signature', () => {
    const ts = currentTimestamp();
    expect(verifySlackSignature(signingSecret, '', ts, body)).toBe(false);
  });

  it('rejects empty timestamp', () => {
    expect(verifySlackSignature(signingSecret, 'v0=abc', '', body)).toBe(
      false,
    );
  });

  it('uses timing-safe comparison (different length signatures)', () => {
    const ts = currentTimestamp();
    // A signature with different length should not crash
    expect(verifySlackSignature(signingSecret, 'v0=short', ts, body)).toBe(
      false,
    );
  });
});

// ============================================================================
// isTimestampValid
// ============================================================================

describe('isTimestampValid', () => {
  it('accepts a current timestamp', () => {
    expect(isTimestampValid(currentTimestamp())).toBe(true);
  });

  it('accepts a timestamp within the 5-minute window', () => {
    const ts = String(Math.floor(Date.now() / 1000) - 200); // 200 seconds ago
    expect(isTimestampValid(ts)).toBe(true);
  });

  it('rejects a timestamp older than 5 minutes', () => {
    const ts = String(Math.floor(Date.now() / 1000) - 400); // 400 seconds ago
    expect(isTimestampValid(ts)).toBe(false);
  });

  it('rejects a future timestamp beyond the window', () => {
    const ts = String(Math.floor(Date.now() / 1000) + 400); // 400 seconds in future
    expect(isTimestampValid(ts)).toBe(false);
  });

  it('rejects non-numeric timestamp', () => {
    expect(isTimestampValid('not-a-number')).toBe(false);
  });

  it('rejects empty timestamp', () => {
    expect(isTimestampValid('')).toBe(false);
  });

  it('respects custom maxAgeSeconds', () => {
    const ts = String(Math.floor(Date.now() / 1000) - 50);
    expect(isTimestampValid(ts, 30)).toBe(false); // 50s > 30s limit
    expect(isTimestampValid(ts, 60)).toBe(true); // 50s < 60s limit
  });
});

// ============================================================================
// validateSlackEnvelope
// ============================================================================

describe('validateSlackEnvelope', () => {
  it('accepts a valid events_api envelope', () => {
    const envelope = {
      envelope_id: 'abc-123',
      type: 'events_api',
      payload: { event: { text: 'hello' } },
    };
    expect(validateSlackEnvelope(envelope)).toEqual({ valid: true });
  });

  it('accepts a valid hello envelope', () => {
    const envelope = {
      envelope_id: 'hello-123',
      type: 'hello',
    };
    expect(validateSlackEnvelope(envelope)).toEqual({ valid: true });
  });

  it('accepts a valid disconnect envelope', () => {
    const envelope = {
      envelope_id: 'disc-123',
      type: 'disconnect',
    };
    expect(validateSlackEnvelope(envelope)).toEqual({ valid: true });
  });

  it('accepts slash_commands envelope', () => {
    const envelope = {
      envelope_id: 'cmd-123',
      type: 'slash_commands',
      payload: { command: '/test' },
    };
    expect(validateSlackEnvelope(envelope)).toEqual({ valid: true });
  });

  it('accepts interactive envelope', () => {
    const envelope = {
      envelope_id: 'int-123',
      type: 'interactive',
      payload: { action: 'click' },
    };
    expect(validateSlackEnvelope(envelope)).toEqual({ valid: true });
  });

  it('rejects null', () => {
    const result = validateSlackEnvelope(null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Message is not an object');
  });

  it('rejects non-object', () => {
    const result = validateSlackEnvelope('not an object');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Message is not an object');
  });

  it('rejects missing envelope_id', () => {
    const result = validateSlackEnvelope({ type: 'hello' });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Missing or empty envelope_id');
  });

  it('rejects empty envelope_id', () => {
    const result = validateSlackEnvelope({ envelope_id: '  ', type: 'hello' });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Missing or empty envelope_id');
  });

  it('rejects missing type', () => {
    const result = validateSlackEnvelope({ envelope_id: 'abc-123' });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Missing or empty message type');
  });

  it('rejects unknown envelope type', () => {
    const result = validateSlackEnvelope({
      envelope_id: 'abc-123',
      type: 'unknown_type',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Unknown envelope type');
  });

  it('rejects events_api without payload', () => {
    const result = validateSlackEnvelope({
      envelope_id: 'abc-123',
      type: 'events_api',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('events_api envelope missing payload');
  });

  it('rejects events_api with null payload', () => {
    const result = validateSlackEnvelope({
      envelope_id: 'abc-123',
      type: 'events_api',
      payload: null,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('events_api envelope missing payload');
  });
});

// ============================================================================
// SlackConnectionStateTracker
// ============================================================================

describe('SlackConnectionStateTracker', () => {
  let tracker: SlackConnectionStateTracker;

  beforeEach(() => {
    tracker = new SlackConnectionStateTracker();
  });

  describe('state transitions', () => {
    it('starts in disconnected state', () => {
      expect(tracker.getState()).toBe('disconnected');
      expect(tracker.canProcessMessages()).toBe(false);
    });

    it('transitions to connecting', () => {
      tracker.onConnecting();
      expect(tracker.getState()).toBe('connecting');
      expect(tracker.canProcessMessages()).toBe(false);
    });

    it('transitions to authenticated', () => {
      tracker.onConnecting();
      tracker.onAuthenticated();
      expect(tracker.getState()).toBe('authenticated');
      expect(tracker.canProcessMessages()).toBe(true);
      expect(tracker.getAuthenticatedAt()).not.toBeNull();
    });

    it('transitions to reconnecting', () => {
      tracker.onConnecting();
      tracker.onAuthenticated();
      tracker.onReconnecting();
      expect(tracker.getState()).toBe('reconnecting');
      expect(tracker.canProcessMessages()).toBe(false);
      expect(tracker.getAuthenticatedAt()).toBeNull();
    });

    it('transitions to disconnected and clears queue', () => {
      tracker.onConnecting();
      tracker.onAuthenticated();
      tracker.onReconnecting();
      tracker.queueMessage({
        envelope_id: 'test',
        type: 'events_api',
        payload: {},
      });
      expect(tracker.getQueueSize()).toBe(1);

      tracker.onDisconnected();
      expect(tracker.getState()).toBe('disconnected');
      expect(tracker.canProcessMessages()).toBe(false);
      expect(tracker.getQueueSize()).toBe(0);
    });
  });

  describe('reconnection tracking', () => {
    it('increments reconnect count', () => {
      expect(tracker.getReconnectCount()).toBe(0);
      tracker.onReconnecting();
      expect(tracker.getReconnectCount()).toBe(1);
      tracker.onReconnecting();
      expect(tracker.getReconnectCount()).toBe(2);
    });

    it('resets reconnect count on authentication', () => {
      tracker.onReconnecting();
      tracker.onReconnecting();
      expect(tracker.getReconnectCount()).toBe(2);
      tracker.onAuthenticated();
      expect(tracker.getReconnectCount()).toBe(0);
    });

    it('detects exceeded max reconnects (default 5)', () => {
      for (let i = 0; i < 5; i++) {
        tracker.onReconnecting();
      }
      expect(tracker.hasExceededMaxReconnects()).toBe(true);
    });

    it('does not exceed before reaching max', () => {
      for (let i = 0; i < 4; i++) {
        tracker.onReconnecting();
      }
      expect(tracker.hasExceededMaxReconnects()).toBe(false);
    });

    it('respects custom maxReconnectAttempts', () => {
      const custom = new SlackConnectionStateTracker({
        maxReconnectAttempts: 2,
      });
      custom.onReconnecting();
      expect(custom.hasExceededMaxReconnects()).toBe(false);
      custom.onReconnecting();
      expect(custom.hasExceededMaxReconnects()).toBe(true);
    });
  });

  describe('message queue', () => {
    it('queues messages during reconnection', () => {
      tracker.onReconnecting();
      const result = tracker.queueMessage({
        envelope_id: 'msg-1',
        type: 'events_api',
        payload: {},
      });
      expect(result).toBe(true);
      expect(tracker.getQueueSize()).toBe(1);
    });

    it('drains queue after re-authentication', () => {
      tracker.onReconnecting();
      tracker.queueMessage({
        envelope_id: 'msg-1',
        type: 'events_api',
        payload: {},
      });
      tracker.queueMessage({
        envelope_id: 'msg-2',
        type: 'events_api',
        payload: {},
      });

      const messages = tracker.drainQueue();
      expect(messages).toHaveLength(2);
      expect(messages[0].envelope_id).toBe('msg-1');
      expect(messages[1].envelope_id).toBe('msg-2');
      expect(tracker.getQueueSize()).toBe(0);
    });

    it('drops oldest when queue exceeds maxQueueSize', () => {
      const small = new SlackConnectionStateTracker({ maxQueueSize: 2 });
      small.onReconnecting();
      small.queueMessage({ envelope_id: 'msg-1', type: 'hello' });
      small.queueMessage({ envelope_id: 'msg-2', type: 'hello' });
      const wasFull = !small.queueMessage({
        envelope_id: 'msg-3',
        type: 'hello',
      });
      expect(wasFull).toBe(true); // oldest was dropped
      expect(small.getQueueSize()).toBe(2);

      const messages = small.drainQueue();
      expect(messages[0].envelope_id).toBe('msg-2');
      expect(messages[1].envelope_id).toBe('msg-3');
    });
  });

  describe('canProcessMessages', () => {
    it('only returns true when authenticated', () => {
      expect(tracker.canProcessMessages()).toBe(false); // disconnected
      tracker.onConnecting();
      expect(tracker.canProcessMessages()).toBe(false); // connecting
      tracker.onAuthenticated();
      expect(tracker.canProcessMessages()).toBe(true); // authenticated
      tracker.onReconnecting();
      expect(tracker.canProcessMessages()).toBe(false); // reconnecting
      tracker.onAuthenticated();
      expect(tracker.canProcessMessages()).toBe(true); // re-authenticated
      tracker.onDisconnected();
      expect(tracker.canProcessMessages()).toBe(false); // disconnected
    });
  });
});

// ============================================================================
// validateSlackMessage (orchestrator)
// ============================================================================

describe('validateSlackMessage', () => {
  let tracker: SlackConnectionStateTracker;
  const signingSecret = 'test_secret_xyz';

  beforeEach(() => {
    tracker = new SlackConnectionStateTracker();
    tracker.onConnecting();
    tracker.onAuthenticated();
  });

  it('accepts a valid message without signing secret', () => {
    const msg = JSON.stringify({
      envelope_id: 'abc-123',
      type: 'hello',
    });
    const result = validateSlackMessage(msg, tracker);
    expect(result.valid).toBe(true);
  });

  it('accepts a valid message with valid signature', () => {
    const msg = JSON.stringify({
      envelope_id: 'abc-123',
      type: 'hello',
    });
    const ts = currentTimestamp();
    const sig = generateSlackSignature(signingSecret, ts, msg);
    const result = validateSlackMessage(msg, tracker, signingSecret, sig, ts);
    expect(result.valid).toBe(true);
  });

  it('rejects when connection is not authenticated', () => {
    const disconnected = new SlackConnectionStateTracker();
    const msg = JSON.stringify({ envelope_id: 'abc', type: 'hello' });
    const result = validateSlackMessage(msg, disconnected);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not authenticated');
  });

  it('rejects during reconnection', () => {
    tracker.onReconnecting();
    const msg = JSON.stringify({ envelope_id: 'abc', type: 'hello' });
    const result = validateSlackMessage(msg, tracker);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('reconnecting');
  });

  it('rejects invalid JSON', () => {
    const result = validateSlackMessage('not json', tracker);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Invalid JSON message');
  });

  it('rejects invalid envelope structure', () => {
    const msg = JSON.stringify({ not_an_envelope: true });
    const result = validateSlackMessage(msg, tracker);
    expect(result.valid).toBe(false);
  });

  it('rejects when signature verification fails', () => {
    const msg = JSON.stringify({
      envelope_id: 'abc-123',
      type: 'hello',
    });
    const ts = currentTimestamp();
    const result = validateSlackMessage(
      msg,
      tracker,
      signingSecret,
      'v0=bad_signature',
      ts,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Signature verification failed');
  });

  it('rejects when signing secret is set but signature is missing', () => {
    const msg = JSON.stringify({
      envelope_id: 'abc-123',
      type: 'hello',
    });
    const result = validateSlackMessage(msg, tracker, signingSecret);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('signature/timestamp missing');
  });

  it('rejects when signing secret is set but timestamp is missing', () => {
    const msg = JSON.stringify({
      envelope_id: 'abc-123',
      type: 'hello',
    });
    const result = validateSlackMessage(
      msg,
      tracker,
      signingSecret,
      'v0=abc',
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('signature/timestamp missing');
  });
});

// ============================================================================
// Slack message validation in reply-listener context
// ============================================================================

describe('Slack validation integration', () => {
  it('source code imports slack-socket validation', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'reply-listener.ts'),
      'utf-8',
    );
    expect(source).toContain("from './slack-socket.js'");
    expect(source).toContain('validateSlackMessage');
    expect(source).toContain('SlackConnectionStateTracker');
  });

  it('reply-listener exports processSlackSocketMessage', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'reply-listener.ts'),
      'utf-8',
    );
    expect(source).toContain('export function processSlackSocketMessage');
  });

  it('reply-listener validates before injection', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'reply-listener.ts'),
      'utf-8',
    );
    // processSlackSocketMessage calls validateSlackMessage before injectReply
    expect(source).toContain('validateSlackMessage');
    expect(source).toContain('REJECTED Slack message');
  });

  it('ReplyListenerDaemonConfig includes slackSigningSecret', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'reply-listener.ts'),
      'utf-8',
    );
    expect(source).toContain('slackSigningSecret?: string');
  });

  it('SlackNotificationConfig includes signingSecret', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'types.ts'),
      'utf-8',
    );
    expect(source).toContain('signingSecret?: string');
  });

  it('index.ts exports Slack validation functions', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'index.ts'),
      'utf-8',
    );
    expect(source).toContain('verifySlackSignature');
    expect(source).toContain('validateSlackEnvelope');
    expect(source).toContain('validateSlackMessage');
    expect(source).toContain('SlackConnectionStateTracker');
  });
});
