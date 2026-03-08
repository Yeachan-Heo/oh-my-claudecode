import { describe, it, expect } from 'vitest';
import { createDeprecatedCliOnlyEnvelope, createDeprecatedCliOnlyEnvelopeWithArgs } from '../team-server.js';
describe('team-server MCP runtime tool deprecation envelopes', () => {
    it.each([
        ['omc_run_team_start', 'omc team start'],
        ['omc_run_team_status', 'omc team status <job_id>'],
        ['omc_run_team_wait', 'omc team wait <job_id>'],
        ['omc_run_team_cleanup', 'omc team cleanup <job_id>'],
    ])('returns stable deprecated_cli_only envelope for %s', (toolName, cliReplacement) => {
        const first = createDeprecatedCliOnlyEnvelope(toolName);
        const second = createDeprecatedCliOnlyEnvelope(toolName);
        expect(first).toEqual(second);
        expect(first.isError).toBe(true);
        const payload = JSON.parse(first.content[0].text);
        expect(payload).toMatchObject({
            code: 'deprecated_cli_only',
            tool: toolName,
            message: 'Legacy team MCP runtime tools are deprecated. Use the omc team CLI instead.',
            cli_replacement: cliReplacement,
        });
    });
});
describe('team-server MCP deprecation envelope CLI argument mapping', () => {
    it('maps start tool args to omc team start command flags', () => {
        const envelope = createDeprecatedCliOnlyEnvelopeWithArgs('omc_run_team_start', {
            teamName: 'alpha-team',
            agentTypes: ['codex', 'codex'],
            tasks: [{ subject: 'S1', description: 'review auth flow' }],
            cwd: '/tmp/project',
            newWindow: true,
        });
        const payload = JSON.parse(envelope.content[0].text);
        expect(payload.cli_replacement).toContain('omc team start');
        expect(payload.cli_replacement).toContain('--name "alpha-team"');
        expect(payload.cli_replacement).toContain('--cwd "/tmp/project"');
        expect(payload.cli_replacement).toContain('--agent "codex"');
        expect(payload.cli_replacement).toContain('--count 2');
        expect(payload.cli_replacement).toContain('--task "review auth flow"');
        expect(payload.cli_replacement).toContain('--new-window');
    });
    it('maps wait/cleanup tool args to timeout/grace flags', () => {
        const waitEnvelope = createDeprecatedCliOnlyEnvelopeWithArgs('omc_run_team_wait', {
            job_id: 'omc-abc123',
            timeout_ms: 120000,
        });
        const cleanupEnvelope = createDeprecatedCliOnlyEnvelopeWithArgs('omc_run_team_cleanup', {
            job_id: 'omc-abc123',
            grace_ms: 5000,
        });
        const waitPayload = JSON.parse(waitEnvelope.content[0].text);
        const cleanupPayload = JSON.parse(cleanupEnvelope.content[0].text);
        expect(waitPayload.cli_replacement).toBe('omc team wait --job-id "omc-abc123" --timeout-ms 120000');
        expect(cleanupPayload.cli_replacement).toBe('omc team cleanup --job-id "omc-abc123" --grace-ms 5000');
    });
});
//# sourceMappingURL=team-server-deprecation.test.js.map