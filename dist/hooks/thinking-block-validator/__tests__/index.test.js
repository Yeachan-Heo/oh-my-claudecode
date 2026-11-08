import { describe, expect, it } from 'vitest';
import { createThinkingBlockValidatorHook, validateMessage, } from '../index.js';
const MODEL_ID = 'claude-sonnet-4-6';
const SYNTHETIC_THINKING_CONTENT = '[Synthetic thinking block inserted to preserve message structure]';
describe('thinking-block-validator issue #1386 regression', () => {
    it('does not reuse unrelated prior assistant thinking in validateMessage', () => {
        const staleThinking = 'Stale prior reasoning about a different task';
        const messages = [
            {
                info: { id: 'assistant-1', role: 'assistant' },
                parts: [{ type: 'thinking', thinking: staleThinking }],
            },
            {
                info: { id: 'assistant-2', role: 'assistant', sessionID: 'session-1' },
                parts: [{ type: 'text', text: 'Fresh answer content' }],
            },
        ];
        const result = validateMessage(messages[1], messages, 1, MODEL_ID);
        expect(result.fixed).toBe(true);
        expect(messages[1].parts[0]).toMatchObject({
            type: 'thinking',
            synthetic: true,
            thinking: SYNTHETIC_THINKING_CONTENT,
        });
        expect(messages[1].parts[0].thinking).not.toContain(staleThinking);
    });
    it('does not copy earlier assistant thinking when the transform hook fixes later messages', async () => {
        const staleThinking = 'Sensitive stale chain-of-thought from an older turn';
        const hook = createThinkingBlockValidatorHook();
        const output = {
            messages: [
                {
                    info: { id: 'assistant-1', role: 'assistant' },
                    parts: [{ type: 'thinking', thinking: staleThinking }],
                },
                {
                    info: { id: 'assistant-2', role: 'assistant', sessionID: 'session-1' },
                    parts: [{ type: 'tool_use', id: 'tool-1' }],
                },
                {
                    info: { id: 'user-1', role: 'user', modelID: MODEL_ID },
                    parts: [{ type: 'text', text: 'Latest user request' }],
                },
            ],
        };
        await hook['experimental.chat.messages.transform']?.({}, output);
        const insertedPart = output.messages[1].parts[0];
        expect(insertedPart).toMatchObject({
            type: 'thinking',
            synthetic: true,
            thinking: SYNTHETIC_THINKING_CONTENT,
        });
        expect(insertedPart.thinking).not.toContain(staleThinking);
    });
});
//# sourceMappingURL=index.test.js.map