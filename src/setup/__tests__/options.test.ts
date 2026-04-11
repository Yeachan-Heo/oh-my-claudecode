/**
 * options.ts — flag parser, env var reader, preset loader, and
 * resolveOptions precedence + validation tests.
 *
 * Scenario coverage: flag precedence happy paths + all X1–X12 illegal
 * combinations as negative tests + preset JSON schema + env var support.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULTS,
  InvalidOptionsError,
  QUESTION_METADATA,
  loadPreset,
  parseFlagsToPartial,
  readEnvPartial,
  resolveOptions,
} from '../options.js';

// Fresh tmpdir per describe block for preset fixtures
let TMP: string;
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'omc-options-test-'));
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// QUESTION_METADATA
// ---------------------------------------------------------------------------

describe('QUESTION_METADATA', () => {
  it('has all 11 expected field keys', () => {
    const expected = [
      'target',
      'installStyle',
      'executionMode',
      'installCli',
      'taskTool',
      'mcpEnabled',
      'teamsEnabled',
      'teamsDisplayMode',
      'teamsAgentCount',
      'teamsAgentType',
      'starRepo',
    ];
    for (const key of expected) {
      expect(QUESTION_METADATA).toHaveProperty(key);
      expect(QUESTION_METADATA[key]?.question).toBeTruthy();
      expect(Array.isArray(QUESTION_METADATA[key]?.options)).toBe(true);
      expect((QUESTION_METADATA[key]?.options.length ?? 0)).toBeGreaterThan(0);
    }
    expect(Object.keys(QUESTION_METADATA).length).toBe(11);
  });

  it('target question text is verbatim from phase 1', () => {
    expect(QUESTION_METADATA.target!.question).toBe(
      'Where should I configure oh-my-claudecode?',
    );
  });

  it('executionMode question text is verbatim from phase 2', () => {
    expect(QUESTION_METADATA.executionMode!.question).toBe(
      "Which parallel execution mode should be your default when you say 'fast' or 'parallel'?",
    );
  });

  it('teamsEnabled question text is verbatim from phase 3', () => {
    expect(QUESTION_METADATA.teamsEnabled!.question).toContain('experimental Claude Code feature');
  });
});

// ---------------------------------------------------------------------------
// parseFlagsToPartial — per-flag tests
// ---------------------------------------------------------------------------

describe('parseFlagsToPartial', () => {
  it('bare (no flags) → empty-ish partial (no phases, no installerOptions)', () => {
    const p = parseFlagsToPartial([]);
    expect(p.phases).toBeUndefined();
    expect(p.installerOptions).toBeUndefined();
  });

  it('-f / --force → force + installerOptions.force', () => {
    const p = parseFlagsToPartial(['--force']);
    expect(p.force).toBe(true);
    expect(p.installerOptions?.force).toBe(true);
  });

  it('-q / --quiet → quiet + installerOptions.verbose=false', () => {
    const p = parseFlagsToPartial(['--quiet']);
    expect(p.quiet).toBe(true);
    expect(p.installerOptions?.verbose).toBe(false);
  });

  it('--local → target=local + phases includes claude-md', () => {
    const p = parseFlagsToPartial(['--local']);
    expect(p.target).toBe('local');
    expect(p.phases?.has('claude-md')).toBe(true);
  });

  it('--global --preserve → target=global + installStyle=preserve', () => {
    const p = parseFlagsToPartial(['--global', '--preserve']);
    expect(p.target).toBe('global');
    expect(p.installStyle).toBe('preserve');
  });

  it('--wizard → phases includes all 4 wizard phases', () => {
    const p = parseFlagsToPartial(['--wizard']);
    expect(p.phases?.has('claude-md')).toBe(true);
    expect(p.phases?.has('infra')).toBe(true);
    expect(p.phases?.has('integrations')).toBe(true);
    expect(p.phases?.has('welcome')).toBe(true);
  });

  it('--execution-mode ultrawork → executionMode set', () => {
    const p = parseFlagsToPartial(['--execution-mode', 'ultrawork']);
    expect(p.executionMode).toBe('ultrawork');
  });

  it('--execution-mode invalid → throws InvalidOptionsError', () => {
    expect(() => parseFlagsToPartial(['--execution-mode', 'bogus'])).toThrow(
      InvalidOptionsError,
    );
  });

  it('--task-tool bd → taskTool=bd', () => {
    const p = parseFlagsToPartial(['--task-tool', 'bd']);
    expect(p.taskTool).toBe('bd');
  });

  it('--install-cli / --no-install-cli → installCli boolean', () => {
    expect(parseFlagsToPartial(['--install-cli']).installCli).toBe(true);
    expect(parseFlagsToPartial(['--no-install-cli']).installCli).toBe(false);
  });

  it('--mcp-servers context7,exa → mcp.servers list', () => {
    const p = parseFlagsToPartial(['--mcp-servers', 'context7,exa']);
    expect(p.mcp?.servers).toEqual(['context7', 'exa']);
    expect(p.mcp?.enabled).toBe(true);
  });

  it('--mcp-servers with unknown name → throws', () => {
    expect(() => parseFlagsToPartial(['--mcp-servers', 'context7,bogus'])).toThrow(
      /unknown MCP server: bogus/,
    );
  });

  it('--exa-key inline → mcp.credentials.exa', () => {
    const p = parseFlagsToPartial(['--exa-key', 'sk-xxx']);
    expect(p.mcp?.credentials?.exa).toBe('sk-xxx');
  });

  it('--exa-key-file reads key from disk', () => {
    const keyPath = join(TMP, 'exa.key');
    writeFileSync(keyPath, 'sk-filecontent\n', 'utf-8');
    const p = parseFlagsToPartial(['--exa-key-file', keyPath]);
    expect(p.mcp?.credentials?.exa).toBe('sk-filecontent');
  });

  it('--exa-key-file missing → X10 error', () => {
    expect(() => parseFlagsToPartial(['--exa-key-file', '/nonexistent/path'])).toThrow(
      /exa key file not found/,
    );
  });

  it('--github-token-file reads token from disk', () => {
    const keyPath = join(TMP, 'gh.tok');
    writeFileSync(keyPath, 'ghp_abc\n', 'utf-8');
    const p = parseFlagsToPartial(['--github-token-file', keyPath]);
    expect(p.mcp?.credentials?.github).toBe('ghp_abc');
  });

  it('--github-token-file missing → error', () => {
    expect(() =>
      parseFlagsToPartial(['--github-token-file', '/nonexistent/path']),
    ).toThrow(/github token file not found/);
  });

  it('--mcp-scope user → mcp.scope=user', () => {
    const p = parseFlagsToPartial(['--mcp-scope', 'user']);
    expect(p.mcp?.scope).toBe('user');
  });

  it('--mcp-on-missing-creds error → mcp.onMissingCredentials=error', () => {
    const p = parseFlagsToPartial(['--mcp-on-missing-creds', 'error']);
    expect(p.mcp?.onMissingCredentials).toBe('error');
  });

  it('--enable-teams / --team-agents 5 / --team-type debugger', () => {
    const p = parseFlagsToPartial([
      '--enable-teams',
      '--team-agents',
      '5',
      '--team-type',
      'debugger',
    ]);
    expect(p.teams?.enabled).toBe(true);
    expect(p.teams?.agentCount).toBe(5);
    expect(p.teams?.agentType).toBe('debugger');
  });

  it('--team-agents invalid count → throws', () => {
    expect(() => parseFlagsToPartial(['--team-agents', '4'])).toThrow(
      /invalid --team-agents/,
    );
  });

  it('--teammate-display tmux → teams.displayMode=tmux', () => {
    const p = parseFlagsToPartial(['--teammate-display', 'tmux']);
    expect(p.teams?.displayMode).toBe('tmux');
  });

  it('--star-repo / --no-star-repo', () => {
    expect(parseFlagsToPartial(['--star-repo']).starRepo).toBe(true);
    expect(parseFlagsToPartial(['--no-star-repo']).starRepo).toBe(false);
  });

  it('--claude-md-only → phases=[claude-md]', () => {
    const p = parseFlagsToPartial(['--claude-md-only']);
    expect(p.phases?.has('claude-md')).toBe(true);
    expect(p.phases?.size).toBe(1);
  });

  it('--mcp-only → phases=[mcp-only]', () => {
    const p = parseFlagsToPartial(['--mcp-only']);
    expect(p.phases?.has('mcp-only')).toBe(true);
    expect(p.phases?.size).toBe(1);
  });

  it('--state-save 3 → phases=[state], stateAction.op=save', () => {
    const p = parseFlagsToPartial(['--state-save', '3', '--state-config-type', 'local']);
    expect(p.phases?.has('state')).toBe(true);
    expect(p.stateAction).toEqual({ op: 'save', step: 3, configType: 'local' });
  });

  it('--state-clear → stateAction.op=clear', () => {
    const p = parseFlagsToPartial(['--state-clear']);
    expect(p.stateAction).toEqual({ op: 'clear' });
  });

  it('--state-resume → stateAction.op=resume', () => {
    const p = parseFlagsToPartial(['--state-resume']);
    expect(p.stateAction).toEqual({ op: 'resume' });
  });

  it('--state-complete 4.0.0 → stateAction.op=complete', () => {
    const p = parseFlagsToPartial(['--state-complete', '4.0.0']);
    expect(p.stateAction).toEqual({ op: 'complete', version: '4.0.0' });
  });

  it('--check-state → checkState=true', () => {
    const p = parseFlagsToPartial(['--check-state']);
    expect(p.checkState).toBe(true);
  });

  it('--preset <file> → presetFile set', () => {
    const p = parseFlagsToPartial(['--preset', '/some/path.json']);
    expect(p.presetFile).toBe('/some/path.json');
  });

  it('--skip-hooks forwarded to installerOptions.skipHooks', () => {
    const p = parseFlagsToPartial(['--skip-hooks']);
    expect(
      (p.installerOptions as { skipHooks?: boolean } | undefined)?.skipHooks,
    ).toBe(true);
  });

  it('--plugin-dir-mode forwarded to installerOptions.pluginDirMode', () => {
    const p = parseFlagsToPartial(['--plugin-dir-mode']);
    expect(p.installerOptions?.pluginDirMode).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readEnvPartial — env var support
// ---------------------------------------------------------------------------

describe('readEnvPartial (env var support)', () => {
  it('EXA_API_KEY → mcp.credentials.exa', () => {
    const p = readEnvPartial({ EXA_API_KEY: 'sk-env' });
    expect(p.mcp?.credentials?.exa).toBe('sk-env');
  });

  it('GITHUB_TOKEN → mcp.credentials.github', () => {
    const p = readEnvPartial({ GITHUB_TOKEN: 'ghp_env' });
    expect(p.mcp?.credentials?.github).toBe('ghp_env');
  });

  it('OMC_SETUP_EXECUTION_MODE → executionMode', () => {
    const p = readEnvPartial({ OMC_SETUP_EXECUTION_MODE: 'ralph' });
    expect(p.executionMode).toBe('ralph');
  });

  it('OMC_SETUP_TASK_TOOL → taskTool', () => {
    const p = readEnvPartial({ OMC_SETUP_TASK_TOOL: 'bd' });
    expect(p.taskTool).toBe('bd');
  });

  it('OMC_SETUP_TEAMS_ENABLED=1 → teams.enabled=true', () => {
    const p = readEnvPartial({ OMC_SETUP_TEAMS_ENABLED: '1' });
    expect(p.teams?.enabled).toBe(true);
  });

  it('OMC_SETUP_TEAMS_AGENT_COUNT=5 → teams.agentCount=5', () => {
    const p = readEnvPartial({ OMC_SETUP_TEAMS_AGENT_COUNT: '5' });
    expect(p.teams?.agentCount).toBe(5);
  });

  it('OMC_SETUP_TEAMS_AGENT_TYPE=debugger → teams.agentType=debugger', () => {
    const p = readEnvPartial({ OMC_SETUP_TEAMS_AGENT_TYPE: 'debugger' });
    expect(p.teams?.agentType).toBe('debugger');
  });

  it('OMC_SETUP_MCP_SCOPE=local → mcp.scope=local', () => {
    const p = readEnvPartial({ OMC_SETUP_MCP_SCOPE: 'local' });
    expect(p.mcp?.scope).toBe('local');
  });

  it('OMC_SETUP_TARGET=global → target=global', () => {
    const p = readEnvPartial({ OMC_SETUP_TARGET: 'global' });
    expect(p.target).toBe('global');
  });

  it('OMC_SETUP_INSTALL_STYLE=preserve → installStyle=preserve', () => {
    const p = readEnvPartial({ OMC_SETUP_INSTALL_STYLE: 'preserve' });
    expect(p.installStyle).toBe('preserve');
  });

  it('OMC_SETUP_STAR_REPO=true → starRepo=true', () => {
    const p = readEnvPartial({ OMC_SETUP_STAR_REPO: 'true' });
    expect(p.starRepo).toBe(true);
  });

  it('unknown env vars are ignored', () => {
    const p = readEnvPartial({ RANDOM_VAR: 'ignored', OMC_SETUP_TARGET: 'local' });
    expect(p.target).toBe('local');
  });

  it('invalid enum values are ignored, not thrown', () => {
    const p = readEnvPartial({ OMC_SETUP_EXECUTION_MODE: 'bogus' });
    expect(p.executionMode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loadPreset — JSON schema
// ---------------------------------------------------------------------------

describe('loadPreset', () => {
  it('valid preset loads', () => {
    const presetPath = join(TMP, 'p.json');
    writeFileSync(
      presetPath,
      JSON.stringify({
        target: 'global',
        installStyle: 'overwrite',
        installCli: true,
        executionMode: 'ultrawork',
        taskTool: 'builtin',
        mcp: { enabled: true, servers: ['context7', 'exa'], credentials: { exa: 'sk-x' } },
        teams: { enabled: true, displayMode: 'auto', agentCount: 3, agentType: 'executor' },
        starRepo: false,
      }),
      'utf-8',
    );
    const p = loadPreset(presetPath);
    expect(p.target).toBe('global');
    expect(p.installCli).toBe(true);
    expect(p.mcp?.servers).toEqual(['context7', 'exa']);
    expect(p.mcp?.credentials?.exa).toBe('sk-x');
    expect(p.teams?.agentCount).toBe(3);
  });

  it('missing field → accepted (all fields optional in preset)', () => {
    const presetPath = join(TMP, 'partial.json');
    writeFileSync(presetPath, JSON.stringify({ target: 'local' }), 'utf-8');
    const p = loadPreset(presetPath);
    expect(p.target).toBe('local');
    expect(p.installCli).toBeUndefined();
  });

  it('invalid type (e.g. target: 42) → throws invalid preset', () => {
    const presetPath = join(TMP, 'bad.json');
    writeFileSync(presetPath, JSON.stringify({ target: 42 }), 'utf-8');
    expect(() => loadPreset(presetPath)).toThrow(/invalid preset/);
  });

  it('extra unknown fields are preserved (passthrough)', () => {
    const presetPath = join(TMP, 'extra.json');
    writeFileSync(
      presetPath,
      JSON.stringify({ target: 'local', futureField: 'someValue' }),
      'utf-8',
    );
    expect(() => loadPreset(presetPath)).not.toThrow();
  });

  it('X8: --preset nonexistent → preset file not found', () => {
    expect(() => loadPreset(join(TMP, 'does-not-exist.json'))).toThrow(
      /preset file not found/,
    );
  });

  it('X9: --preset invalid JSON → invalid preset', () => {
    const presetPath = join(TMP, 'invalid.json');
    writeFileSync(presetPath, '{ this is not json', 'utf-8');
    expect(() => loadPreset(presetPath)).toThrow(/invalid preset/);
  });
});

// ---------------------------------------------------------------------------
// resolveOptions — precedence + phase derivation
// ---------------------------------------------------------------------------

describe('resolveOptions — precedence', () => {
  it('default (no flags, no env, no preset) → phases=[infra], target=local', () => {
    const opts = resolveOptions({}, undefined, { env: {}, isTTY: false });
    expect(Array.from(opts.phases)).toEqual(['infra']);
    expect(opts.target).toBe('local');
    expect(opts.installStyle).toBe('overwrite');
    expect(opts.mcp.enabled).toBe(false);
    expect(opts.teams.enabled).toBe(false);
  });

  it('preset beats default', () => {
    const opts = resolveOptions(
      {},
      { target: 'global', installStyle: 'preserve' },
      { env: {}, isTTY: true },
    );
    expect(opts.target).toBe('global');
    expect(opts.installStyle).toBe('preserve');
  });

  it('env beats preset', () => {
    const opts = resolveOptions(
      {},
      { target: 'local' },
      { env: { OMC_SETUP_TARGET: 'global' }, isTTY: false },
    );
    expect(opts.target).toBe('global');
  });

  it('flag beats env', () => {
    const flags = parseFlagsToPartial(['--local']);
    const opts = resolveOptions(flags, undefined, {
      env: { OMC_SETUP_TARGET: 'global' },
      isTTY: false,
    });
    expect(opts.target).toBe('local');
  });

  it('flag beats preset and env (full stack)', () => {
    const flags = parseFlagsToPartial(['--execution-mode', 'ralph']);
    const opts = resolveOptions(
      flags,
      { executionMode: 'autopilot' },
      { env: { OMC_SETUP_EXECUTION_MODE: 'ultrawork' }, isTTY: false },
    );
    expect(opts.executionMode).toBe('ralph');
  });

  it('mcp credentials from env merge into merged options', () => {
    const opts = resolveOptions({}, undefined, {
      env: { EXA_API_KEY: 'sk-env' },
      isTTY: false,
    });
    expect(opts.mcp.credentials.exa).toBe('sk-env');
  });
});

describe('resolveOptions — phases derivation', () => {
  it('bare → {infra}', () => {
    const flags = parseFlagsToPartial([]);
    const opts = resolveOptions(flags, undefined, { env: {}, isTTY: true });
    expect(Array.from(opts.phases)).toEqual(['infra']);
  });

  it('--claude-md-only → {claude-md}', () => {
    const flags = parseFlagsToPartial(['--claude-md-only']);
    const opts = resolveOptions(flags, undefined, { env: {}, isTTY: true });
    expect(Array.from(opts.phases)).toEqual(['claude-md']);
  });

  it('--wizard → {claude-md, infra, integrations, welcome}', () => {
    const flags = parseFlagsToPartial(['--wizard']);
    const opts = resolveOptions(flags, undefined, { env: {}, isTTY: true });
    const sorted = Array.from(opts.phases).sort();
    expect(sorted).toEqual(['claude-md', 'infra', 'integrations', 'welcome'].sort());
  });

  it('--mcp-only → {mcp-only} (with --mcp-servers)', () => {
    const flags = parseFlagsToPartial(['--mcp-only', '--mcp-servers', 'context7']);
    const opts = resolveOptions(flags, undefined, { env: {}, isTTY: true });
    expect(Array.from(opts.phases)).toEqual(['mcp-only']);
  });

  it('--state-save 2 → {state}', () => {
    const flags = parseFlagsToPartial(['--state-save', '2', '--state-config-type', 'local']);
    const opts = resolveOptions(flags, undefined, { env: {}, isTTY: false });
    expect(Array.from(opts.phases)).toEqual(['state']);
  });

  it('--global alone → {claude-md}', () => {
    const flags = parseFlagsToPartial(['--global']);
    const opts = resolveOptions(flags, undefined, { env: {}, isTTY: false });
    expect(Array.from(opts.phases)).toEqual(['claude-md']);
  });

  it('--local alone → {claude-md}', () => {
    const flags = parseFlagsToPartial(['--local']);
    const opts = resolveOptions(flags, undefined, { env: {}, isTTY: false });
    expect(Array.from(opts.phases)).toEqual(['claude-md']);
  });

  it('--interactive + TTY → full wizard phases', () => {
    const flags = parseFlagsToPartial(['--interactive']);
    const opts = resolveOptions(flags, undefined, { env: {}, isTTY: true });
    expect(opts.phases.has('claude-md')).toBe(true);
    expect(opts.phases.has('welcome')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// X1 – X12 illegal combinations (negative tests)
// ---------------------------------------------------------------------------

describe('X1–X12 illegal combinations', () => {
  it('X1: --local --global → "conflicting targets"', () => {
    const flags = parseFlagsToPartial(['--local', '--global']);
    expect(() => resolveOptions(flags, undefined, { env: {}, isTTY: true })).toThrow(
      /conflicting targets: --local and --global/,
    );
  });

  it('X2: --preserve without --global → "--preserve only valid with --global"', () => {
    const flags = parseFlagsToPartial(['--preserve']);
    expect(() => resolveOptions(flags, undefined, { env: {}, isTTY: true })).toThrow(
      /--preserve only valid with --global/,
    );
  });

  it('X2: --preserve --global → accepted', () => {
    const flags = parseFlagsToPartial(['--global', '--preserve']);
    expect(() => resolveOptions(flags, undefined, { env: {}, isTTY: true })).not.toThrow();
  });

  it('X3: --wizard + non-TTY + no --preset → "--wizard requires a TTY or --preset"', () => {
    const flags = parseFlagsToPartial(['--wizard']);
    expect(() => resolveOptions(flags, undefined, { env: {}, isTTY: false })).toThrow(
      /--wizard requires a TTY or --preset <file>/,
    );
  });

  it('X3: --wizard + non-TTY + --preset → accepted', () => {
    const presetPath = join(TMP, 'p.json');
    writeFileSync(presetPath, JSON.stringify({ target: 'local' }), 'utf-8');
    const flags = parseFlagsToPartial(['--wizard', '--preset', presetPath]);
    const preset = loadPreset(presetPath);
    expect(() =>
      resolveOptions(flags, preset, { env: {}, isTTY: false }),
    ).not.toThrow();
  });

  it('X4: --interactive + non-TTY → "--interactive requires a TTY"', () => {
    const flags = parseFlagsToPartial(['--interactive']);
    expect(() => resolveOptions(flags, undefined, { env: {}, isTTY: false })).toThrow(
      /--interactive requires a TTY/,
    );
  });

  it('X5: --non-interactive + claude-md phase + missing target + no default → "missing field target"', () => {
    const flags = parseFlagsToPartial(['--non-interactive', '--claude-md-only']);
    expect(() => resolveOptions(flags, undefined, { env: {}, isTTY: true })).toThrow(
      /missing field target/,
    );
  });

  it('X5: --non-interactive + target provided → accepted', () => {
    const flags = parseFlagsToPartial(['--non-interactive', '--claude-md-only', '--local']);
    expect(() =>
      resolveOptions(flags, undefined, { env: {}, isTTY: true }),
    ).not.toThrow();
  });

  it('X6: --mcp-only without --preset and no --mcp-servers → "--mcp-only requires"', () => {
    const flags = parseFlagsToPartial(['--mcp-only']);
    expect(() => resolveOptions(flags, undefined, { env: {}, isTTY: true })).toThrow(
      /--mcp-only requires --preset <file> or --mcp-servers <list>/,
    );
  });

  it('X6: --mcp-only --mcp-servers context7 → accepted', () => {
    const flags = parseFlagsToPartial(['--mcp-only', '--mcp-servers', 'context7']);
    expect(() =>
      resolveOptions(flags, undefined, { env: {}, isTTY: true }),
    ).not.toThrow();
  });

  // X7 is documented as not reachable (skill × no plugin). No test.

  it('X8: loadPreset(nonexistent) → "preset file not found"', () => {
    expect(() => loadPreset(join(TMP, 'does-not-exist.json'))).toThrow(
      /preset file not found/,
    );
  });

  it('X9: loadPreset(invalid json) → "invalid preset"', () => {
    const presetPath = join(TMP, 'invalid.json');
    writeFileSync(presetPath, '{ not valid', 'utf-8');
    expect(() => loadPreset(presetPath)).toThrow(/invalid preset/);
  });

  it('X10: --exa-key-file nonexistent → "exa key file not found"', () => {
    expect(() =>
      parseFlagsToPartial(['--exa-key-file', '/does/not/exist']),
    ).toThrow(/exa key file not found/);
  });

  it('X11: --state-save with non-numeric step → "--state-save requires --step <n>"', () => {
    expect(() => parseFlagsToPartial(['--state-save', 'notanumber'])).toThrow(
      /--state-save requires --step <n>/,
    );
  });

  it('X12: --check-state + --wizard → "mutually exclusive with other phase flags"', () => {
    const flags = parseFlagsToPartial(['--check-state', '--wizard']);
    expect(() => resolveOptions(flags, undefined, { env: {}, isTTY: true })).toThrow(
      /--check-state is mutually exclusive with other phase flags/,
    );
  });

  it('X12: --check-state + --claude-md-only → throws', () => {
    const flags = parseFlagsToPartial(['--check-state', '--claude-md-only']);
    expect(() => resolveOptions(flags, undefined, { env: {}, isTTY: true })).toThrow(
      /--check-state is mutually exclusive/,
    );
  });

  it('X12: --check-state alone → accepted', () => {
    const flags = parseFlagsToPartial(['--check-state']);
    expect(() =>
      resolveOptions(flags, undefined, { env: {}, isTTY: true }),
    ).not.toThrow();
  });
});

describe('DEFAULTS sanity', () => {
  it('DEFAULTS.phases is Set<["infra"]>', () => {
    expect(Array.from(DEFAULTS.phases)).toEqual(['infra']);
  });
  it('DEFAULTS.mcp.onMissingCredentials=skip', () => {
    expect(DEFAULTS.mcp.onMissingCredentials).toBe('skip');
  });
  it('DEFAULTS.teams.enabled=false', () => {
    expect(DEFAULTS.teams.enabled).toBe(false);
  });
  it('DEFAULTS.installCli=false', () => {
    expect(DEFAULTS.installCli).toBe(false);
  });
});
