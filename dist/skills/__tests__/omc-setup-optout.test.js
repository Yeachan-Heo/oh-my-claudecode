import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const phasePath = join(process.cwd(), 'skills', 'omc-setup', 'phases', '01-install-claude-md.md');
const phase = readFileSync(phasePath, 'utf8');
const optoutHeading = '## Check the Global Opt-Out Before Asking About Install Style';
const optoutStart = phase.indexOf(optoutHeading);
const styleQuestion = phase.indexOf('**Question:** "Global setup will change your base Claude config. Which behavior do you want?"');
const probeSection = phase.slice(optoutStart, styleQuestion);
const probeMatch = probeSection.match(/^node -e "\n([\s\S]*?)\n"$/m);
const probe = probeMatch?.[1];
const roots = [];
function createHome() {
    const home = mkdtempSync(join(tmpdir(), 'omc-setup-optout-'));
    roots.push(home);
    return home;
}
function runProbe(home, configDir) {
    if (probe === undefined)
        throw new Error('omc-setup global opt-out probe is missing');
    return spawnSync(process.execPath, ['-e', probe], {
        env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: configDir },
        encoding: 'utf8',
    });
}
afterEach(() => {
    for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true });
});
describe('omc-setup global CLAUDE.md opt-out', () => {
    it('checks the flag before the overwrite/preserve question and skips that question when disabled', () => {
        expect(optoutStart).toBeGreaterThanOrEqual(0);
        expect(styleQuestion).toBeGreaterThan(optoutStart);
        expect(probe).toBeDefined();
        expect(probeSection).toContain('If the probe prints `disabled`, do not ask the overwrite/preserve question');
        expect(probeSection).toContain('If the probe fails or prints neither status, stop before asking or running setup');
    });
    it.each(['~/profile', `~${String.fromCharCode(92)}profile`])('detects explicit false in the expanded custom config dir %s', (configDirValue) => {
        const home = createHome();
        const customDir = join(home, 'profile');
        mkdirSync(customDir);
        writeFileSync(join(customDir, '.omc-config.json'), JSON.stringify({ claudeMdEnabled: false }));
        const result = runProbe(home, configDirValue);
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe('disabled');
    });
    it('defaults to enabled for missing, invalid, or non-false config values', () => {
        const home = createHome();
        const defaultDir = join(home, '.claude');
        mkdirSync(defaultDir);
        expect(runProbe(home, '').stdout.trim()).toBe('enabled');
        writeFileSync(join(defaultDir, '.omc-config.json'), '{invalid json');
        expect(runProbe(home, '').stdout.trim()).toBe('enabled');
        writeFileSync(join(defaultDir, '.omc-config.json'), JSON.stringify({ claudeMdEnabled: 'false' }));
        expect(runProbe(home, '').stdout.trim()).toBe('enabled');
        writeFileSync(join(defaultDir, '.omc-config.json'), JSON.stringify({ claudeMdEnabled: false }));
        expect(runProbe(home, '').stdout.trim()).toBe('disabled');
    });
});
//# sourceMappingURL=omc-setup-optout.test.js.map