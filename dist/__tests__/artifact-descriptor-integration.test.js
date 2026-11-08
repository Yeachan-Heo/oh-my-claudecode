import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
const INTEGRATION_CANDIDATES = [
    {
        label: 'shared interop state',
        path: join(process.cwd(), 'src', 'interop', 'shared-state.ts'),
    },
];
function readCandidateSources() {
    return INTEGRATION_CANDIDATES
        .filter((candidate) => existsSync(candidate.path))
        .map((candidate) => ({
        ...candidate,
        source: readFileSync(candidate.path, 'utf-8'),
    }));
}
describe('artifact descriptor low-risk integration', () => {
    it('wires descriptor helpers into the shared interop handoff path', () => {
        const candidates = readCandidateSources();
        expect(candidates.length).toBe(INTEGRATION_CANDIDATES.length);
        const sharedInteropState = candidates.find((candidate) => candidate.label === 'shared interop state');
        expect(sharedInteropState?.source).toMatch(/artifact-descriptor\.js/);
        expect(sharedInteropState?.source).toMatch(/createArtifactHandoff/);
    });
    it('keeps inline-vs-descriptor thresholding explicit at the chosen call site', () => {
        const candidates = readCandidateSources();
        const thresholdMatches = candidates.filter(({ source }) => /(thresholdBytes|INLINE_ARTIFACT|ARTIFACT_INLINE_THRESHOLD|MAX_INLINE)/i.test(source) &&
            /(summary|inlineContent|descriptor)/.test(source));
        expect(thresholdMatches.length).toBeGreaterThan(0);
    });
});
//# sourceMappingURL=artifact-descriptor-integration.test.js.map