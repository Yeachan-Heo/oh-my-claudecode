import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
const REPO_ROOT = '/home/bellman/Workspace/oh-my-claudecode-dev';
const CLI_ENTRY = '/home/bellman/Workspace/oh-my-claudecode-dev/src/cli/index.ts';
function runCli(args, homeDir) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            HOME: homeDir,
            CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
        },
        encoding: 'utf-8',
    });
    return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
    };
}
function readConfig(configPath) {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
}
describe('omc config-ecomode and config-agent-tiers', () => {
    it('toggles ecomode.enabled in ~/.claude/.omc-config.json', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-config-ecomode-home-'));
        const configPath = join(homeDir, '.claude', '.omc-config.json');
        mkdirSync(join(homeDir, '.claude'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({ silentAutoUpdate: false }, null, 2));
        const disable = runCli(['config-ecomode', '--disable'], homeDir);
        expect(disable.status).toBe(0);
        expect(readConfig(configPath).ecomode).toEqual({ enabled: false });
        const enable = runCli(['config-ecomode', '--enable'], homeDir);
        expect(enable.status).toBe(0);
        expect(readConfig(configPath).ecomode).toEqual({ enabled: true });
        const show = runCli(['config-ecomode', '--show'], homeDir);
        expect(show.status).toBe(0);
        expect(show.stdout).toContain('"ecomode"');
    });
    it('toggles agentTiers.lowEnabled in ~/.claude/.omc-config.json', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'omc-cli-config-tiers-home-'));
        const configPath = join(homeDir, '.claude', '.omc-config.json');
        mkdirSync(join(homeDir, '.claude'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({ silentAutoUpdate: false }, null, 2));
        const disableLow = runCli(['config-agent-tiers', '--disable-low'], homeDir);
        expect(disableLow.status).toBe(0);
        expect(readConfig(configPath).agentTiers).toEqual({ lowEnabled: false });
        const enableLow = runCli(['config-agent-tiers', '--enable-low'], homeDir);
        expect(enableLow.status).toBe(0);
        expect(readConfig(configPath).agentTiers).toEqual({ lowEnabled: true });
        const show = runCli(['config-agent-tiers', '--show'], homeDir);
        expect(show.status).toBe(0);
        expect(show.stdout).toContain('"agentTiers"');
    });
});
//# sourceMappingURL=cli-config-ecomode-and-tiers.test.js.map