import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('team cli runtime boundary', () => {
  it('does not import or reference src/mcp/team-server.ts', () => {
    const source = readFileSync(join(__dirname, '..', 'team.ts'), 'utf-8');

    expect(source).not.toMatch(/mcp\/team-server/i);
    expect(source).not.toMatch(/team-server\.ts/i);
  });

  it('publishes one immutable job identity before spawning runtime-cli', () => {
    const source = readFileSync(join(__dirname, '..', 'team.ts'), 'utf-8');
    const identity = source.indexOf('const instanceId = randomUUID();');
    const firstPublication = source.indexOf('writeJobToDisk(jobId, job, jobsDir);', identity);
    const spawn = source.indexOf('child = spawn(process.execPath', firstPublication);

    expect(identity).toBeGreaterThan(-1);
    expect(firstPublication).toBeGreaterThan(identity);
    expect(spawn).toBeGreaterThan(firstPublication);
    expect(source).toContain('instanceId,');
    expect(source).not.toContain('clearScopedTeamState');
  });

  it('passes the job identity to the v2 cleanup boundary', () => {
    const source = readFileSync(join(__dirname, '..', 'team.ts'), 'utf-8');

    expect(source).toContain('shutdownTeamV2(job.teamName, job.cwd, {');
    expect(source).toContain('instanceId: job.instanceId');
    expect(source).toContain('runtimeV2.shutdownTeamV2(teamName, cwd, {');
    expect(source).not.toContain('shutdownTeam(');
  });

  it('rejects legacy startup and keeps explicit shutdown on the identity-bound v2 protocol', () => {
    const source = readFileSync(join(__dirname, '..', 'commands', 'team.ts'), 'utf-8');
    const start = source.indexOf('async function handleTeamStart');
    const shutdown = source.indexOf('async function handleTeamShutdown');

    expect(start).toBeGreaterThan(-1);
    expect(shutdown).toBeGreaterThan(start);

    const startSection = source.slice(start, shutdown);
    const shutdownSection = source.slice(shutdown);
    expect(startSection).toContain('team_start_unsafe_runtime_v1');
    expect(startSection).toContain('if (!isRuntimeV2Enabled())');
    expect(startSection).toContain('startTeamV2({');
    expect(startSection).not.toContain('startTeam({');
    expect(startSection).not.toContain('from \'../../team/runtime.js\'');

    expect(shutdownSection).toContain('readTeamConfig');
    expect(shutdownSection).toContain('isValidTeamInstanceId');
    expect(shutdownSection).toContain('shutdownTeamV2(teamName, cwd, {');
    expect(shutdownSection).toContain('instanceId,');
    expect(shutdownSection).not.toContain('isRuntimeV2Enabled');
    expect(shutdownSection).not.toContain('shutdownTeam(');
    expect(shutdownSection).toContain("if (shutdown.outcome !== 'cleaned')");
  });
});
