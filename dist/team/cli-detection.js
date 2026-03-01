// Re-exports from model-contract.ts for backward compatibility
// and additional CLI detection utilities
export { isCliAvailable, validateCliAvailable, getContract } from './model-contract.js';
import { spawnSync } from 'child_process';
export function detectCli(binary) {
    try {
        const versionResult = spawnSync(binary, ['--version'], { timeout: 5000 });
        if (versionResult.status === 0) {
            const pathResult = spawnSync('which', [binary], { timeout: 5000 });
            return {
                available: true,
                version: versionResult.stdout?.toString().trim(),
                path: pathResult.stdout?.toString().trim(),
            };
        }
        return { available: false };
    }
    catch {
        return { available: false };
    }
}
export function detectAllClis() {
    return {
        claude: detectCli('claude'),
        codex: detectCli('codex'),
        gemini: detectCli('gemini'),
    };
}
//# sourceMappingURL=cli-detection.js.map