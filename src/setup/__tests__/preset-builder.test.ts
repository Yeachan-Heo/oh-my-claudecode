/**
 * preset-builder.ts — pure buildPreset(answers) tests.
 *
 * Scenario coverage: minimal/full answers, default application,
 * validation rejection (agentCount not in {2,3,5}), mcp credential
 * handling, custom MCP server spec pass-through.
 */

import { describe, it, expect } from 'vitest';
import { buildPreset, type AnswersFile } from '../preset-builder.js';
import { InvalidOptionsError } from '../options.js';

describe('buildPreset — minimal answers', () => {
  it('empty answers → full SetupOptions with defaults', () => {
    const opts = buildPreset({});
    expect(opts.target).toBe('local');
    expect(opts.installStyle).toBe('overwrite');
    expect(opts.installCli).toBe(false);
    expect(opts.skipHud).toBe(false);
    expect(opts.mcp.enabled).toBe(false);
    expect(opts.mcp.onMissingCredentials).toBe('skip');
    expect(opts.mcp.scope).toBe('user');
    expect(opts.mcp.servers).toEqual([]);
    expect(opts.teams.enabled).toBe(false);
    expect(opts.teams.displayMode).toBe('auto');
    expect(opts.teams.agentCount).toBe(3);
    expect(opts.teams.agentType).toBe('executor');
    expect(opts.starRepo).toBe(false);
    // Phases always set to full wizard flow for skill-built presets.
    expect(opts.phases.has('claude-md')).toBe(true);
    expect(opts.phases.has('infra')).toBe(true);
    expect(opts.phases.has('integrations')).toBe(true);
    expect(opts.phases.has('welcome')).toBe(true);
  });

  it('target=global + installStyle=overwrite → passes', () => {
    const opts = buildPreset({ target: 'global', installStyle: 'overwrite' });
    expect(opts.target).toBe('global');
    expect(opts.installStyle).toBe('overwrite');
  });
});

describe('buildPreset — full answers', () => {
  it('full answers → validated pass-through', () => {
    const answers: AnswersFile = {
      target: 'global',
      installStyle: 'preserve',
      executionMode: 'ultrawork',
      installCli: true,
      taskTool: 'bd',
      mcp: {
        enabled: true,
        servers: ['context7', 'exa'],
        credentials: { exa: 'sk-xxx' },
        onMissingCredentials: 'error',
      },
      teams: {
        enabled: true,
        displayMode: 'tmux',
        agentCount: 5,
        agentType: 'debugger',
      },
      starRepo: true,
    };
    const opts = buildPreset(answers);
    expect(opts.target).toBe('global');
    expect(opts.installStyle).toBe('preserve');
    expect(opts.executionMode).toBe('ultrawork');
    expect(opts.installCli).toBe(true);
    expect(opts.taskTool).toBe('bd');
    expect(opts.mcp.enabled).toBe(true);
    expect(opts.mcp.servers).toEqual(['context7', 'exa']);
    expect(opts.mcp.credentials.exa).toBe('sk-xxx');
    expect(opts.mcp.onMissingCredentials).toBe('error');
    expect(opts.teams.enabled).toBe(true);
    expect(opts.teams.displayMode).toBe('tmux');
    expect(opts.teams.agentCount).toBe(5);
    expect(opts.teams.agentType).toBe('debugger');
    expect(opts.starRepo).toBe(true);
  });
});

describe('buildPreset — validation failures', () => {
  it('teams.agentCount=4 → throws with clear error', () => {
    expect(() =>
      buildPreset({
        teams: { enabled: true, agentCount: 4 },
      }),
    ).toThrow(InvalidOptionsError);
    expect(() =>
      buildPreset({
        teams: { enabled: true, agentCount: 4 },
      }),
    ).toThrow(/invalid teams.agentCount: 4 \(expected 2\|3\|5\)/);
  });

  it('teams.agentType=unknown → throws', () => {
    expect(() =>
      buildPreset({
        teams: {
          enabled: true,
          agentType: 'unknown' as unknown as 'executor',
        },
      }),
    ).toThrow(/invalid teams.agentType/);
  });

  it('teams.displayMode=invalid → throws', () => {
    expect(() =>
      buildPreset({
        teams: {
          enabled: true,
          displayMode: 'curses' as unknown as 'auto',
        },
      }),
    ).toThrow(/invalid teams.displayMode/);
  });

  it('executionMode=unknown → throws', () => {
    expect(() =>
      buildPreset({
        executionMode: 'bogus' as unknown as 'ultrawork',
      }),
    ).toThrow(/invalid executionMode/);
  });

  it('taskTool=unknown → throws', () => {
    expect(() =>
      buildPreset({
        taskTool: 'bogus' as unknown as 'builtin',
      }),
    ).toThrow(/invalid taskTool/);
  });

  it('installStyle=preserve + target=local → throws', () => {
    expect(() =>
      buildPreset({ target: 'local', installStyle: 'preserve' }),
    ).toThrow(/installStyle=preserve only valid with target=global/);
  });

  it('installStyle=invalid → throws', () => {
    expect(() =>
      buildPreset({
        installStyle: 'rebuild' as unknown as 'overwrite',
      }),
    ).toThrow(/invalid installStyle/);
  });

  it('target=invalid → throws', () => {
    expect(() =>
      buildPreset({
        target: 'whatever' as unknown as 'local',
      }),
    ).toThrow(/invalid target/);
  });
});

describe('buildPreset — MCP handling', () => {
  it('mcp with credentials → preset includes credentials', () => {
    const opts = buildPreset({
      mcp: { enabled: true, credentials: { exa: 'sk-test', github: 'ghp_test' } },
    });
    expect(opts.mcp.enabled).toBe(true);
    expect(opts.mcp.credentials.exa).toBe('sk-test');
    expect(opts.mcp.credentials.github).toBe('ghp_test');
  });

  it('mcp without credentials → onMissingCredentials=skip default', () => {
    const opts = buildPreset({ mcp: { enabled: true } });
    expect(opts.mcp.enabled).toBe(true);
    expect(opts.mcp.onMissingCredentials).toBe('skip');
    expect(opts.mcp.credentials).toEqual({});
  });

  it('mcp onMissingCredentials=invalid → throws', () => {
    expect(() =>
      buildPreset({
        mcp: {
          enabled: true,
          onMissingCredentials: 'retry' as unknown as 'skip',
        },
      }),
    ).toThrow(/invalid mcp.onMissingCredentials/);
  });

  it('custom MCP server spec → passes through', () => {
    const opts = buildPreset({
      mcp: {
        enabled: true,
        servers: [
          'context7',
          {
            name: 'my-server',
            spec: {
              name: 'my-server',
              command: '/usr/bin/my-mcp',
              args: ['--flag'],
              env: { MY_KEY: 'v' },
            },
          },
        ],
      },
    });
    expect(opts.mcp.servers).toHaveLength(2);
    expect(opts.mcp.servers[0]).toBe('context7');
    const custom = opts.mcp.servers[1];
    expect(typeof custom).toBe('object');
    if (typeof custom === 'object') {
      expect(custom.name).toBe('my-server');
      expect(custom.spec.command).toBe('/usr/bin/my-mcp');
      expect(custom.spec.args).toEqual(['--flag']);
      expect(custom.spec.env).toEqual({ MY_KEY: 'v' });
    }
  });

  it('mcp with unknown named server → throws', () => {
    expect(() =>
      buildPreset({
        mcp: {
          enabled: true,
          servers: ['bogus'],
        },
      }),
    ).toThrow(/invalid MCP server name: bogus/);
  });

  it('mcp custom server missing name → throws', () => {
    expect(() =>
      buildPreset({
        mcp: {
          enabled: true,
          servers: [
            {
              name: 'x',
              // spec without .name
              spec: {} as unknown as { name: string },
            },
          ],
        },
      }),
    ).toThrow(/invalid custom MCP server spec/);
  });
});

describe('buildPreset — phase derivation', () => {
  it('always produces full wizard phases', () => {
    const opts = buildPreset({ target: 'local' });
    const sorted = Array.from(opts.phases).sort();
    expect(sorted).toEqual(['claude-md', 'infra', 'integrations', 'welcome'].sort());
  });
});
