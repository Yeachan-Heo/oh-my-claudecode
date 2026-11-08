import { describe, it, expect, vi } from 'vitest';
import { factoryCommand } from '../factory.js';
describe('omc factory listen --port', () => {
    it.each(['abc', '7788x', '70000', '-1', '1.5'])('rejects invalid port %j before starting the listener', async (raw) => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code) => {
            throw new Error(`exit:${code}`);
        }));
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            await expect(factoryCommand().parseAsync(['listen', '--repo', 'o/r', '--port', raw], { from: 'user' })).rejects.toThrow('exit:1');
            const message = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(message).toContain('--port');
        }
        finally {
            exitSpy.mockRestore();
            stderrSpy.mockRestore();
        }
    });
});
//# sourceMappingURL=factory-listen-port.test.js.map