import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ULTRAWORK_MESSAGE } from '../installer/hooks.js';
import { getUltraworkMessage } from '../hooks/keyword-detector/ultrawork/index.js';
describe('issue #2652 runtime wiring and output contract', () => {
    it('ships the Stop hook through persistent-mode.mjs', () => {
        const hooksJsonPath = join(process.cwd(), 'hooks', 'hooks.json');
        const hooks = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
        const stopCommands = (hooks.hooks?.Stop ?? [])
            .flatMap((entry) => entry.hooks ?? [])
            .map((hook) => hook.command ?? '');
        expect(stopCommands.some((command) => command.includes('/scripts/persistent-mode.mjs'))).toBe(true);
        expect(stopCommands.some((command) => command.includes('/scripts/persistent-mode.cjs'))).toBe(false);
    });
    it('ultrawork mode instructs spawned agents to keep outputs concise', () => {
        expect(ULTRAWORK_MESSAGE).toBe(getUltraworkMessage());
        expect(ULTRAWORK_MESSAGE).toContain('CONCISE OUTPUTS');
        expect(ULTRAWORK_MESSAGE).toContain('under 100 words');
        expect(ULTRAWORK_MESSAGE).toContain('files touched');
        expect(ULTRAWORK_MESSAGE).toContain('verification status');
    });
});
//# sourceMappingURL=issue-2652-runtime-wiring-and-output-contract.test.js.map