import { vi, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { join } from 'path';
import { parseTranscript, loadTranscript } from '../../analytics/transcript-parser.js';
describe('transcript-parser', () => {
    const fixturesDir = join(__dirname, '..', 'fixtures');
    const sampleTranscriptPath = join(fixturesDir, 'sample-transcript.jsonl');
    describe('parseTranscript()', () => {
        it('yields entries in order', async () => {
            const entries = [];
            for await (const entry of parseTranscript(sampleTranscriptPath)) {
                entries.push(entry);
            }
            expect(entries).toHaveLength(5);
            // Verify order is preserved
            expect(entries[0]).toMatchObject({
                type: 'assistant',
                sessionId: 'test-session-1',
                timestamp: '2026-01-24T01:00:00.000Z',
            });
            expect(entries[1]).toMatchObject({
                type: 'assistant',
                sessionId: 'test-session-1',
                timestamp: '2026-01-24T01:01:00.000Z',
            });
            expect(entries[4]).toMatchObject({
                type: 'assistant',
                sessionId: 'test-session-1',
                timestamp: '2026-01-24T01:03:00.000Z',
            });
        });
        it('parses usage data correctly', async () => {
            const entries = [];
            for await (const entry of parseTranscript(sampleTranscriptPath)) {
                entries.push(entry);
            }
            const firstEntry = entries[0];
            expect(firstEntry.message.usage).toEqual({
                input_tokens: 100,
                output_tokens: 50,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            });
            const secondEntry = entries[1];
            expect(secondEntry.message.usage).toEqual({
                input_tokens: 200,
                output_tokens: 80,
                cache_creation_input_tokens: 500,
                cache_read_input_tokens: 1000,
            });
        });
        it('handles malformed JSON lines gracefully with default warning', async () => {
            const tempPath = join(fixturesDir, 'malformed-test.jsonl');
            const content = [
                '{"type":"assistant","sessionId":"test","timestamp":"2026-01-24T00:00:00.000Z","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
                'INVALID JSON LINE',
                '{"type":"assistant","sessionId":"test","timestamp":"2026-01-24T00:01:00.000Z","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","usage":{"input_tokens":20,"output_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
            ].join('\n');
            fs.writeFileSync(tempPath, content);
            const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
            try {
                const entries = [];
                for await (const entry of parseTranscript(tempPath)) {
                    entries.push(entry);
                }
                expect(entries).toHaveLength(2);
                expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('[transcript-parser] Skipping malformed line'));
            }
            finally {
                consoleWarnSpy.mockRestore();
                fs.unlinkSync(tempPath);
            }
        });
        it('handles malformed JSON lines gracefully with custom error handler', async () => {
            const tempPath = join(fixturesDir, 'malformed-custom-test.jsonl');
            const content = [
                '{"type":"assistant","sessionId":"test","timestamp":"2026-01-24T00:00:00.000Z","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
                'INVALID JSON LINE',
                '{"type":"assistant","sessionId":"test","timestamp":"2026-01-24T00:01:00.000Z","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","usage":{"input_tokens":20,"output_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
            ].join('\n');
            fs.writeFileSync(tempPath, content);
            const errors = [];
            const onParseError = (line, error) => {
                errors.push({ line, error });
            };
            try {
                const entries = [];
                for await (const entry of parseTranscript(tempPath, { onParseError })) {
                    entries.push(entry);
                }
                expect(entries).toHaveLength(2);
                expect(errors).toHaveLength(1);
                expect(errors[0].line).toBe('INVALID JSON LINE');
                expect(errors[0].error).toBeInstanceOf(Error);
            }
            finally {
                fs.unlinkSync(tempPath);
            }
        });
        it('respects AbortSignal', async () => {
            const controller = new AbortController();
            const entries = [];
            let count = 0;
            for await (const entry of parseTranscript(sampleTranscriptPath, {
                signal: controller.signal,
            })) {
                entries.push(entry);
                count++;
                if (count === 2) {
                    controller.abort();
                }
            }
            expect(entries.length).toBeLessThan(5); // Should stop early
            expect(entries).toHaveLength(2);
        });
        it('handles empty files', async () => {
            const tempPath = join(fixturesDir, 'empty-test.jsonl');
            fs.writeFileSync(tempPath, '');
            try {
                const entries = [];
                for await (const entry of parseTranscript(tempPath)) {
                    entries.push(entry);
                }
                expect(entries).toHaveLength(0);
            }
            finally {
                fs.unlinkSync(tempPath);
            }
        });
        it('handles files with only empty lines', async () => {
            const tempPath = join(fixturesDir, 'empty-lines-test.jsonl');
            fs.writeFileSync(tempPath, '\n\n\n\n');
            try {
                const entries = [];
                for await (const entry of parseTranscript(tempPath)) {
                    entries.push(entry);
                }
                expect(entries).toHaveLength(0);
            }
            finally {
                fs.unlinkSync(tempPath);
            }
        });
        it('throws if file does not exist', async () => {
            const nonExistentPath = join(fixturesDir, 'non-existent.jsonl');
            await expect(async () => {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                for await (const entry of parseTranscript(nonExistentPath)) {
                    // Should not reach here
                }
            }).rejects.toThrow('Transcript file not found');
        });
        it('handles files with whitespace lines', async () => {
            const tempPath = join(fixturesDir, 'whitespace-test.jsonl');
            const content = [
                '{"type":"assistant","sessionId":"test","timestamp":"2026-01-24T00:00:00.000Z","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
                '   ',
                '\t\t',
                '{"type":"assistant","sessionId":"test","timestamp":"2026-01-24T00:01:00.000Z","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","usage":{"input_tokens":20,"output_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
            ].join('\n');
            fs.writeFileSync(tempPath, content);
            try {
                const entries = [];
                for await (const entry of parseTranscript(tempPath)) {
                    entries.push(entry);
                }
                expect(entries).toHaveLength(2);
            }
            finally {
                fs.unlinkSync(tempPath);
            }
        });
        it('streams large files efficiently without loading all into memory', async () => {
            // Create a large file with many entries
            const tempPath = join(fixturesDir, 'large-test.jsonl');
            const entryTemplate = {
                type: 'assistant',
                sessionId: 'large-test',
                timestamp: '2026-01-24T00:00:00.000Z',
                message: {
                    model: 'claude-sonnet-4-5-20250929',
                    role: 'assistant',
                    usage: {
                        input_tokens: 100,
                        output_tokens: 50,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                },
            };
            // Write 10,000 entries
            const writeStream = fs.createWriteStream(tempPath);
            for (let i = 0; i < 10000; i++) {
                writeStream.write(JSON.stringify(entryTemplate) + '\n');
            }
            writeStream.end();
            // Wait for write to complete
            await new Promise((resolve) => writeStream.on('finish', resolve));
            try {
                let count = 0;
                const startMemory = process.memoryUsage().heapUsed;
                for await (const entry of parseTranscript(tempPath)) {
                    count++;
                    expect(entry.type).toBe('assistant');
                    // Check memory hasn't grown excessively (allow some growth for overhead)
                    if (count % 1000 === 0) {
                        const currentMemory = process.memoryUsage().heapUsed;
                        const memoryGrowth = currentMemory - startMemory;
                        // Should not grow by more than 50MB for streaming
                        expect(memoryGrowth).toBeLessThan(50 * 1024 * 1024);
                    }
                }
                expect(count).toBe(10000);
            }
            finally {
                fs.unlinkSync(tempPath);
            }
        });
        it('cleans up resources on abort', async () => {
            const controller = new AbortController();
            // Start parsing
            const generator = parseTranscript(sampleTranscriptPath, {
                signal: controller.signal,
            });
            // Get first entry
            await generator.next();
            // Abort immediately
            controller.abort();
            // Try to get next entry
            const result = await generator.next();
            expect(result.done).toBe(true);
        });
    });
    describe('loadTranscript()', () => {
        it('loads all entries into memory', async () => {
            const entries = await loadTranscript(sampleTranscriptPath);
            expect(entries).toHaveLength(5);
            expect(entries[0].sessionId).toBe('test-session-1');
        });
        it('respects AbortSignal', async () => {
            const controller = new AbortController();
            // Abort after a short delay
            setTimeout(() => controller.abort(), 10);
            const entries = await loadTranscript(sampleTranscriptPath, {
                signal: controller.signal,
            });
            // May or may not complete depending on timing, but should not throw
            expect(Array.isArray(entries)).toBe(true);
        });
        it('handles custom error handler', async () => {
            const tempPath = join(fixturesDir, 'malformed-load-test.jsonl');
            const content = [
                '{"type":"assistant","sessionId":"test","timestamp":"2026-01-24T00:00:00.000Z","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
                'INVALID',
                '{"type":"assistant","sessionId":"test","timestamp":"2026-01-24T00:01:00.000Z","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","usage":{"input_tokens":20,"output_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
            ].join('\n');
            fs.writeFileSync(tempPath, content);
            const errors = [];
            const onParseError = (line) => {
                errors.push(line);
            };
            try {
                const entries = await loadTranscript(tempPath, { onParseError });
                expect(entries).toHaveLength(2);
                expect(errors).toHaveLength(1);
                expect(errors[0]).toBe('INVALID');
            }
            finally {
                fs.unlinkSync(tempPath);
            }
        });
        it('returns empty array for empty file', async () => {
            const tempPath = join(fixturesDir, 'empty-load-test.jsonl');
            fs.writeFileSync(tempPath, '');
            try {
                const entries = await loadTranscript(tempPath);
                expect(entries).toEqual([]);
            }
            finally {
                fs.unlinkSync(tempPath);
            }
        });
    });
});
//# sourceMappingURL=transcript-parser.test.js.map