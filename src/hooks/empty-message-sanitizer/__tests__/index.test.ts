import { describe, it, expect } from 'vitest';
import {
  hasTextContent,
  isToolPart,
  hasValidContent,
  sanitizeMessage,
  sanitizeMessages,
  createEmptyMessageSanitizerHook,
  PLACEHOLDER_TEXT,
  TOOL_PART_TYPES,
  HOOK_NAME,
} from '../index.js';
import type {
  MessagePart,
  MessageWithParts,
  EmptyMessageSanitizerInput,
} from '../types.js';

// Helper to create message parts
function createTextPart(text?: string, id?: string): MessagePart {
  return {
    id: id || `part-${Date.now()}`,
    type: 'text',
    text,
  };
}

function createToolPart(type: string, id?: string): MessagePart {
  return {
    id: id || `part-${Date.now()}`,
    type,
  };
}

// Helper to create messages
function createMessage(
  role: 'user' | 'assistant',
  parts: MessagePart[],
  id?: string
): MessageWithParts {
  return {
    info: {
      id: id || `msg-${Date.now()}`,
      role,
      sessionID: 'test-session',
    },
    parts,
  };
}

describe('empty-message-sanitizer', () => {
  describe('hasTextContent', () => {
    it('should return true for part with non-empty text', () => {
      const part = createTextPart('Hello');
      expect(hasTextContent(part)).toBe(true);
    });

    it('should return false for part with empty text', () => {
      const part = createTextPart('');
      expect(hasTextContent(part)).toBe(false);
    });

    it('should return false for part with whitespace only', () => {
      const part = createTextPart('   \n\t  ');
      expect(hasTextContent(part)).toBe(false);
    });

    it('should return false for part with undefined text', () => {
      const part = createTextPart(undefined);
      expect(hasTextContent(part)).toBe(false);
    });

    it('should return false for non-text part types', () => {
      const part = createToolPart('tool_use');
      expect(hasTextContent(part)).toBe(false);
    });

    it('should return true for text with only newlines but also content', () => {
      const part = createTextPart('\nHello\n');
      expect(hasTextContent(part)).toBe(true);
    });

    it('should return false for null-like text value', () => {
      const part: MessagePart = { type: 'text', text: null as unknown as string };
      expect(hasTextContent(part)).toBe(false);
    });
  });

  describe('isToolPart', () => {
    it('should return true for tool part type', () => {
      const part = createToolPart('tool');
      expect(isToolPart(part)).toBe(true);
    });

    it('should return true for tool_use part type', () => {
      const part = createToolPart('tool_use');
      expect(isToolPart(part)).toBe(true);
    });

    it('should return true for tool_result part type', () => {
      const part = createToolPart('tool_result');
      expect(isToolPart(part)).toBe(true);
    });

    it('should return false for text part type', () => {
      const part = createTextPart('text content');
      expect(isToolPart(part)).toBe(false);
    });

    it('should return false for image part type', () => {
      const part: MessagePart = { type: 'image' };
      expect(isToolPart(part)).toBe(false);
    });

    it('should return false for unknown part type', () => {
      const part: MessagePart = { type: 'unknown_type' };
      expect(isToolPart(part)).toBe(false);
    });

    it('should use TOOL_PART_TYPES constant', () => {
      expect(TOOL_PART_TYPES.has('tool')).toBe(true);
      expect(TOOL_PART_TYPES.has('tool_use')).toBe(true);
      expect(TOOL_PART_TYPES.has('tool_result')).toBe(true);
    });
  });

  describe('hasValidContent', () => {
    it('should return true for parts with non-empty text', () => {
      const parts = [createTextPart('Hello')];
      expect(hasValidContent(parts)).toBe(true);
    });

    it('should return true for parts with tool part', () => {
      const parts = [createToolPart('tool_use')];
      expect(hasValidContent(parts)).toBe(true);
    });

    it('should return true for parts with both text and tool', () => {
      const parts = [
        createTextPart('Hello'),
        createToolPart('tool_use'),
      ];
      expect(hasValidContent(parts)).toBe(true);
    });

    it('should return false for empty parts array', () => {
      expect(hasValidContent([])).toBe(false);
    });

    it('should return false for parts with only empty text', () => {
      const parts = [createTextPart(''), createTextPart('   ')];
      expect(hasValidContent(parts)).toBe(false);
    });

    it('should return false for parts with undefined text', () => {
      const parts = [createTextPart(undefined)];
      expect(hasValidContent(parts)).toBe(false);
    });

    it('should return true when one part has valid text among empties', () => {
      const parts = [
        createTextPart(''),
        createTextPart('Valid'),
        createTextPart('   '),
      ];
      expect(hasValidContent(parts)).toBe(true);
    });

    it('should return true when tool part exists among empty text parts', () => {
      const parts = [
        createTextPart(''),
        createToolPart('tool_result'),
      ];
      expect(hasValidContent(parts)).toBe(true);
    });
  });

  describe('sanitizeMessage', () => {
    it('should not modify message with valid text content', () => {
      const message = createMessage('user', [createTextPart('Hello')]);
      const result = sanitizeMessage(message, false);
      expect(result).toBe(false);
      expect(message.parts[0].text).toBe('Hello');
    });

    it('should not modify message with tool part', () => {
      const message = createMessage('assistant', [createToolPart('tool_use')]);
      const result = sanitizeMessage(message, false);
      expect(result).toBe(false);
    });

    it('should skip final assistant message', () => {
      const message = createMessage('assistant', []);
      const result = sanitizeMessage(message, true);
      expect(result).toBe(false);
      expect(message.parts.length).toBe(0);
    });

    it('should sanitize non-final assistant message with empty content', () => {
      const message = createMessage('assistant', []);
      const result = sanitizeMessage(message, false);
      expect(result).toBe(true);
      expect(message.parts.length).toBe(1);
      expect(message.parts[0].text).toBe(PLACEHOLDER_TEXT);
      expect(message.parts[0].synthetic).toBe(true);
    });

    it('should sanitize user message with empty parts array', () => {
      const message = createMessage('user', []);
      const result = sanitizeMessage(message, false);
      expect(result).toBe(true);
      expect(message.parts.length).toBe(1);
      expect(message.parts[0].text).toBe(PLACEHOLDER_TEXT);
    });

    it('should replace existing empty text part', () => {
      const message = createMessage('user', [createTextPart('')]);
      const result = sanitizeMessage(message, false);
      expect(result).toBe(true);
      expect(message.parts.length).toBe(1);
      expect(message.parts[0].text).toBe(PLACEHOLDER_TEXT);
      expect(message.parts[0].synthetic).toBe(true);
    });

    it('should replace whitespace-only text part', () => {
      const message = createMessage('user', [createTextPart('   \n  ')]);
      const result = sanitizeMessage(message, false);
      expect(result).toBe(true);
      expect(message.parts[0].text).toBe(PLACEHOLDER_TEXT);
    });

    it('should insert text part before tool part when no text exists', () => {
      const message = createMessage('user', [createToolPart('tool_use')]);
      const originalLength = message.parts.length;
      const result = sanitizeMessage(message, false);
      expect(result).toBe(false); // Tool part counts as valid content
    });

    it('should append text part when no tool parts exist', () => {
      const message = createMessage('user', []);
      sanitizeMessage(message, false);
      expect(message.parts.length).toBe(1);
      expect(message.parts[0].type).toBe('text');
    });

    it('should use custom placeholder text', () => {
      const message = createMessage('user', []);
      const customPlaceholder = '[custom placeholder]';
      sanitizeMessage(message, false, customPlaceholder);
      expect(message.parts[0].text).toBe(customPlaceholder);
    });

    it('should set synthetic flag on injected parts', () => {
      const message = createMessage('user', []);
      sanitizeMessage(message, false);
      expect(message.parts[0].synthetic).toBe(true);
    });

    it('should sanitize empty text parts alongside valid content', () => {
      const message = createMessage('user', [
        createTextPart('Valid'),
        createTextPart(''),
      ]);
      const result = sanitizeMessage(message, false);
      expect(result).toBe(true);
      expect(message.parts[1].text).toBe(PLACEHOLDER_TEXT);
      expect(message.parts[1].synthetic).toBe(true);
    });

    it('should not modify non-empty text alongside empty text', () => {
      const message = createMessage('user', [
        createTextPart('Valid'),
        createTextPart(''),
      ]);
      sanitizeMessage(message, false);
      expect(message.parts[0].text).toBe('Valid');
      expect(message.parts[0].synthetic).toBeUndefined();
    });

    it('should handle message with multiple empty text parts', () => {
      const message = createMessage('user', [
        createTextPart(''),
        createTextPart('  '),
      ]);
      sanitizeMessage(message, false);
      // First empty text part should be replaced
      expect(message.parts[0].text).toBe(PLACEHOLDER_TEXT);
    });
  });

  describe('sanitizeMessages', () => {
    it('should sanitize all messages in input', () => {
      const input: EmptyMessageSanitizerInput = {
        messages: [
          createMessage('user', []),
          createMessage('assistant', [createTextPart('')]),
          createMessage('user', [createTextPart('Valid')]),
        ],
      };
      const result = sanitizeMessages(input);
      expect(result.sanitizedCount).toBe(2);
      expect(result.modified).toBe(true);
    });

    it('should return modified false when no sanitization needed', () => {
      const input: EmptyMessageSanitizerInput = {
        messages: [
          createMessage('user', [createTextPart('Hello')]),
          createMessage('assistant', [createTextPart('World')]),
        ],
      };
      const result = sanitizeMessages(input);
      expect(result.sanitizedCount).toBe(0);
      expect(result.modified).toBe(false);
    });

    it('should skip final assistant message', () => {
      const input: EmptyMessageSanitizerInput = {
        messages: [
          createMessage('user', [createTextPart('Hello')]),
          createMessage('assistant', []), // Last message, assistant with empty content
        ],
      };
      const result = sanitizeMessages(input);
      expect(result.sanitizedCount).toBe(0);
      expect(input.messages[1].parts.length).toBe(0);
    });

    it('should use custom placeholder text from config', () => {
      const input: EmptyMessageSanitizerInput = {
        messages: [createMessage('user', [])],
      };
      const result = sanitizeMessages(input, { placeholderText: '[custom]' });
      expect(input.messages[0].parts[0].text).toBe('[custom]');
    });

    it('should return messages array in output', () => {
      const input: EmptyMessageSanitizerInput = {
        messages: [createMessage('user', [createTextPart('Test')])],
      };
      const result = sanitizeMessages(input);
      expect(result.messages).toBe(input.messages);
    });

    it('should handle empty messages array', () => {
      const input: EmptyMessageSanitizerInput = {
        messages: [],
      };
      const result = sanitizeMessages(input);
      expect(result.sanitizedCount).toBe(0);
      expect(result.modified).toBe(false);
    });

    it('should sanitize non-final assistant message in the middle', () => {
      const input: EmptyMessageSanitizerInput = {
        messages: [
          createMessage('user', [createTextPart('Hello')]),
          createMessage('assistant', []), // Not last, should be sanitized
          createMessage('user', [createTextPart('Follow up')]),
        ],
      };
      const result = sanitizeMessages(input);
      expect(result.sanitizedCount).toBe(1);
      expect(input.messages[1].parts[0].text).toBe(PLACEHOLDER_TEXT);
    });

    it('should handle single message array', () => {
      const input: EmptyMessageSanitizerInput = {
        messages: [createMessage('user', [])],
      };
      const result = sanitizeMessages(input);
      // Single user message is not the "last assistant", so should be sanitized
      expect(result.sanitizedCount).toBe(1);
    });

    it('should preserve sessionId in input', () => {
      const input: EmptyMessageSanitizerInput = {
        messages: [createMessage('user', [createTextPart('Test')])],
        sessionId: 'test-session-123',
      };
      const result = sanitizeMessages(input);
      expect(result.messages).toBe(input.messages);
    });
  });

  describe('createEmptyMessageSanitizerHook', () => {
    it('should create hook with sanitize method', () => {
      const hook = createEmptyMessageSanitizerHook();
      expect(typeof hook.sanitize).toBe('function');
    });

    it('should create hook with getName method', () => {
      const hook = createEmptyMessageSanitizerHook();
      expect(typeof hook.getName).toBe('function');
      expect(hook.getName()).toBe(HOOK_NAME);
    });

    it('should sanitize messages via hook sanitize method', () => {
      const hook = createEmptyMessageSanitizerHook();
      const input: EmptyMessageSanitizerInput = {
        messages: [createMessage('user', [])],
      };
      const result = hook.sanitize(input);
      expect(result.sanitizedCount).toBe(1);
      expect(result.modified).toBe(true);
    });

    it('should use custom placeholder from config', () => {
      const hook = createEmptyMessageSanitizerHook({ placeholderText: '[hook custom]' });
      const input: EmptyMessageSanitizerInput = {
        messages: [createMessage('user', [])],
      };
      hook.sanitize(input);
      expect(input.messages[0].parts[0].text).toBe('[hook custom]');
    });

    it('should use default placeholder when no config', () => {
      const hook = createEmptyMessageSanitizerHook();
      const input: EmptyMessageSanitizerInput = {
        messages: [createMessage('user', [])],
      };
      hook.sanitize(input);
      expect(input.messages[0].parts[0].text).toBe(PLACEHOLDER_TEXT);
    });
  });

  describe('constants', () => {
    it('should export PLACEHOLDER_TEXT', () => {
      expect(PLACEHOLDER_TEXT).toBe('[user interrupted]');
    });

    it('should export HOOK_NAME', () => {
      expect(HOOK_NAME).toBe('empty-message-sanitizer');
    });

    it('should export TOOL_PART_TYPES with correct values', () => {
      expect(TOOL_PART_TYPES.size).toBe(3);
      expect(TOOL_PART_TYPES.has('tool')).toBe(true);
      expect(TOOL_PART_TYPES.has('tool_use')).toBe(true);
      expect(TOOL_PART_TYPES.has('tool_result')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle message with mixed valid and invalid parts', () => {
      const message = createMessage('user', [
        createTextPart(''),
        createToolPart('tool_use'),
        createTextPart('  '),
        createTextPart('Valid'),
      ]);
      const result = sanitizeMessage(message, false);
      // Empty text parts should be sanitized
      expect(result).toBe(true);
    });

    it('should handle very long placeholder text', () => {
      const longPlaceholder = 'x'.repeat(1000);
      const message = createMessage('user', []);
      sanitizeMessage(message, false, longPlaceholder);
      expect(message.parts[0].text).toBe(longPlaceholder);
    });

    it('should handle special characters in text', () => {
      const message = createMessage('user', [createTextPart('!@#$%^&*()')]);
      const result = sanitizeMessage(message, false);
      expect(result).toBe(false);
      expect(message.parts[0].text).toBe('!@#$%^&*()');
    });

    it('should handle unicode text', () => {
      const message = createMessage('user', [createTextPart('한글 テスト 中文')]);
      const result = sanitizeMessage(message, false);
      expect(result).toBe(false);
      expect(message.parts[0].text).toBe('한글 テスト 中文');
    });

    it('should handle emoji text', () => {
      const message = createMessage('user', [createTextPart('Hello 👋 World 🌍')]);
      const result = sanitizeMessage(message, false);
      expect(result).toBe(false);
    });

    it('should preserve message info when sanitizing', () => {
      const message = createMessage('user', [], 'my-custom-id');
      sanitizeMessage(message, false);
      expect(message.info.id).toBe('my-custom-id');
      expect(message.info.role).toBe('user');
    });

    it('should set correct messageID on synthetic part', () => {
      const message = createMessage('user', [], 'test-msg-id');
      sanitizeMessage(message, false);
      expect(message.parts[0].messageID).toBe('test-msg-id');
    });
  });
});
