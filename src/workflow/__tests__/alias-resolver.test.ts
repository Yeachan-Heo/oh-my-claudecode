import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveWorkflowAlias,
  resolveWorkflowAliasViaRegistry,
  normalizeWorkflowInput,
  formatAliasWarning,
  isResolverEnabled,
  isWarningOptedOut,
  shouldEmitWarning,
  markWarningEmitted,
  maybeGetAliasWarning,
  getAliasMapping,
  getDiagnostics,
  recordAliasTelemetry,
  readUsageReceipts,
  readTelemetryTail,
  clearAliasTelemetryForTests,
  clearAliasWarningsForTests,
  ALIAS_REGISTRY,
  TIER0_WORKFLOWS,
  type AliasEntry,
} from '../alias-resolver.js';
// alias-resolver tests use worktreeRoot override; no direct worktree import needed

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = process.env[k];
    const v = overrides[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(prev)) {
      const v = prev[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('alias-resolver — Tier-0 routing', () => {
  const origQuiet = process.env.OMC_QUIET;
  const origResolver = process.env.OMC_ALIAS_RESOLVER_ENABLED;
  const origDisable = process.env.OMC_DISABLE_ALIAS_RESOLVER;
  beforeEach(() => {
    delete process.env.OMC_QUIET;
    delete process.env.OMC_ALIAS_WARNINGS;
    delete process.env.OMC_ALIAS_WARNING_OPT_OUT;
    delete process.env.OMC_ALIAS_NO_WARNING;
    delete process.env.OMC_ALIAS_WARNINGS_DISABLED;
    delete process.env.OMC_ALIAS_RESOLVER_ENABLED;
    delete process.env.OMC_DISABLE_ALIAS_RESOLVER;
  });
  afterEach(() => {
    if (origQuiet === undefined) delete process.env.OMC_QUIET; else process.env.OMC_QUIET = origQuiet;
    if (origResolver === undefined) delete process.env.OMC_ALIAS_RESOLVER_ENABLED; else process.env.OMC_ALIAS_RESOLVER_ENABLED = origResolver;
    if (origDisable === undefined) delete process.env.OMC_DISABLE_ALIAS_RESOLVER; else process.env.OMC_DISABLE_ALIAS_RESOLVER = origDisable;
  });

  it('routes autopilot -> execute', () => {
    const r = resolveWorkflowAlias('autopilot');
    expect(r.canonical).toBe('execute');
    expect(r.tier0).toBe('execute');
    expect(r.isAlias).toBe(true);
    expect(r.warning).toContain('execute');
  });

  it('routes ralph -> execute', () => {
    expect(resolveWorkflowAlias('ralph').canonical).toBe('execute');
  });

  it('routes ultrawork -> execute', () => {
    expect(resolveWorkflowAlias('ultrawork').canonical).toBe('execute');
  });

  it('routes ultrapilot -> execute', () => {
    expect(resolveWorkflowAlias('ultrapilot').canonical).toBe('execute');
  });

  it('routes swarm -> execute', () => {
    expect(resolveWorkflowAlias('swarm').canonical).toBe('execute');
  });

  it('routes pipeline -> execute', () => {
    expect(resolveWorkflowAlias('pipeline').canonical).toBe('execute');
  });

  it('routes ultraqa -> verify', () => {
    expect(resolveWorkflowAlias('ultraqa').canonical).toBe('verify');
    expect(resolveWorkflowAlias('ultraqa').tier0).toBe('verify');
  });

  it('routes ai-slop-cleaner -> review', () => {
    expect(resolveWorkflowAlias('ai-slop-cleaner').canonical).toBe('review');
  });

  it('ralplan is now Tier-0 (owner direction #3708)', () => {
    const r = resolveWorkflowAlias('ralplan');
    expect(r.canonical).toBe('ralplan');
    expect(r.tier0).toBe('ralplan');
    expect(r.isAlias).toBe(false);
  });

  it('deep-interview is now Tier-0 (owner direction #3708)', () => {
    const r = resolveWorkflowAlias('deep-interview');
    expect(r.canonical).toBe('deep-interview');
    expect(r.tier0).toBe('deep-interview');
    expect(r.isAlias).toBe(false);
  });


  it('routes ccg -> execute', () => {
    expect(resolveWorkflowAlias('ccg').canonical).toBe('execute');
  });

  it('routes release -> omc-release (maintainer-only)', () => {
    const r = resolveWorkflowAlias('release');
    expect(r.canonical).toBe('omc-release');
    expect(r.isRelease).toBe(true);
    expect(r.warning).toContain('omc release');
    expect(r.tier0).toBe(null);
  });

  it('canonical Tier-0 workflows are not aliases', () => {
    for (const c of TIER0_WORKFLOWS) {
      const r = resolveWorkflowAlias(c);
      expect(r.isAlias).toBe(false);
      expect(r.isCanonical).toBe(true);
      expect(r.warning).toBe(null);
      expect(r.canonical).toBe(c);
    }
  });

  it('is case-insensitive and handles slash prefixes', () => {
    expect(resolveWorkflowAlias('Ralph').canonical).toBe('execute');
    expect(resolveWorkflowAlias('/ralph').canonical).toBe('execute');
    expect(resolveWorkflowAlias('/omc:autopilot').canonical).toBe('execute');
    expect(resolveWorkflowAlias('/oh-my-claudecode:ultrawork').canonical).toBe('execute');
    expect(resolveWorkflowAlias('OMC:RALPLAN').canonical).toBe('ralplan');
  });


  it('unknown tokens pass through without alias flag', () => {
    const r = resolveWorkflowAlias('unknown-workflow-xyz');
    expect(r.isAlias).toBe(false);
    expect(r.warning).toBe(null);
  });

  it('resolver flag disables alias routing', () => {
    withEnv({ OMC_ALIAS_RESOLVER_ENABLED: '0' }, () => {
      expect(isResolverEnabled()).toBe(false);
      const r = resolveWorkflowAlias('ralph');
      expect(r.isAlias).toBe(false);
      expect(r.warning).toBe(null);
      expect(r.enabled).toBe(false);
    });
    expect(isResolverEnabled()).toBe(true);
  });

  it('resolver flag via OMC_DISABLE_ALIAS_RESOLVER', () => {
    withEnv({ OMC_DISABLE_ALIAS_RESOLVER: '1' }, () => {
      expect(isResolverEnabled()).toBe(false);
    });
  });

  it('adapter seam resolveWorkflowAliasViaRegistry honors injected registry', () => {
    const fake: AliasEntry = { alias: 'my-alias', canonical: 'plan', tier0: 'plan', owner: 'test', description: 'x', removalMilestone: 'test', isWorkflowAlias: true };
    const lookup = (k: string) => (k === 'my-alias' ? fake : undefined);
    expect(resolveWorkflowAliasViaRegistry('my-alias', lookup).canonical).toBe('plan');
    expect(resolveWorkflowAliasViaRegistry('unknown', lookup).isAlias).toBe(false);
  });
});

describe('alias-resolver — warnings once/session + diagnostics', () => {
  it('warning is concise and actionable', () => {
    const w = formatAliasWarning('ralph', 'execute');
    expect(w.length).toBeLessThan(160);
    expect(w).toContain('ralph');
    expect(w).toContain('execute');
    const rw = formatAliasWarning('release', 'omc-release');
    expect(rw).toContain('omc release');
  });

  it('getAliasMapping retains full mapping/telemetry even when warnings suppressed', () => {
    const mapping = getAliasMapping();
    expect(mapping.length).toBeGreaterThan(10);
    expect(mapping.find((m) => m.alias === 'ralph')?.canonical).toBe('execute');
    expect(mapping.find((m) => m.alias === 'release')?.canonical).toBe('omc-release');
    // diagnostics
    const d = getDiagnostics();
    expect(d.tier0).toEqual(expect.arrayContaining(['plan', 'execute', 'review', 'verify']));
    expect(d.aliases.length).toBe(mapping.length);
    expect(d.planHead).toBe('0a91273e61dbbd47eb0af4c02844409251e08398');
  });

  it('normalization strips prefixes and punctuation', () => {
    expect(normalizeWorkflowInput('/ralph ')).toBe('ralph');
    expect(normalizeWorkflowInput(' /omc:autopilot!')).toBe('autopilot');
    expect(normalizeWorkflowInput('Release.')).toBe('release');
  });
});

describe('alias-resolver — automation opt-out', () => {
  const keys = ['OMC_ALIAS_WARNINGS', 'OMC_ALIAS_WARNING_OPT_OUT', 'OMC_ALIAS_NO_WARNING', 'OMC_ALIAS_WARNINGS_DISABLED', 'OMC_QUIET'];

  function cleanup() {
    for (const k of keys) delete process.env[k];
  }

  beforeEach(cleanup);
  afterEach(cleanup);

  it('OMC_ALIAS_WARNINGS=0 opts out', () => {
    process.env.OMC_ALIAS_WARNINGS = '0';
    expect(isWarningOptedOut()).toBe(true);
  });

  it('OMC_ALIAS_WARNINGS=1 does not opt out', () => {
    process.env.OMC_ALIAS_WARNINGS = '1';
    expect(isWarningOptedOut()).toBe(false);
  });

  it('OMC_ALIAS_WARNING_OPT_OUT=1 opts out', () => {
    process.env.OMC_ALIAS_WARNING_OPT_OUT = '1';
    expect(isWarningOptedOut()).toBe(true);
  });

  it('OMC_QUIET=1 opts out warnings (bounded)', () => {
    process.env.OMC_QUIET = '1';
    expect(isWarningOptedOut()).toBe(true);
  });

  it('OMC_QUIET=0 does not opt out', () => {
    process.env.OMC_QUIET = '0';
    expect(isWarningOptedOut()).toBe(false);
  });

  it('no env -> not opted out', () => {
    expect(isWarningOptedOut()).toBe(false);
  });

  it('maybeGetAliasWarning respects opt-out and dedupes via file', () => {
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'alias-optout-'));
    const sessionId = '00000000-0000-4000-a000-000000000000';
    const sidSafe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    // ensure worktree root looks git-like so getOmcRoot resolves under it, but alias-resolver uses worktreeRoot param
    // We just exercise the file path directly via worktreeRoot override
    try {
      // without opt-out, first call emits
      delete process.env.OMC_QUIET;
      const res = resolveWorkflowAlias('ralph');
      const w1 = maybeGetAliasWarning(res, sidSafe, worktreeRoot);
      expect(w1).not.toBe(null);
      // second call for same alias/session is suppressed
      const w2 = maybeGetAliasWarning(res, sidSafe, worktreeRoot);
      expect(w2).toBe(null);
      // but a different alias still emits
      const res2 = resolveWorkflowAlias('autopilot');
      const w3 = maybeGetAliasWarning(res2, sidSafe, worktreeRoot);
      expect(w3).not.toBe(null);
      // opt-out suppresses even first warning for a fresh alias
      process.env.OMC_QUIET = '1';
      const res3 = resolveWorkflowAlias('ultrawork');
      const w4 = maybeGetAliasWarning(res3, sidSafe, worktreeRoot);
      expect(w4).toBe(null);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
      delete process.env.OMC_QUIET;
    }
  });
});

describe('alias-resolver — once/session warning via file state', () => {
  it('shouldEmitWarning / markWarningEmitted file cycle', () => {
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'alias-warn-'));
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    try {
      clearAliasWarningsForTests(sid, worktreeRoot);
      expect(shouldEmitWarning('ralph', sid, worktreeRoot)).toBe(true);
      markWarningEmitted('ralph', sid, worktreeRoot);
      expect(shouldEmitWarning('ralph', sid, worktreeRoot)).toBe(false);
      expect(shouldEmitWarning('autopilot', sid, worktreeRoot)).toBe(true);
      // case-insensitive normalized key
      expect(shouldEmitWarning('RALPH', sid, worktreeRoot)).toBe(false);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });
});

describe('alias-resolver — telemetry and usage receipts', () => {
  it('records alias uses to receipts and telemetry', () => {
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'alias-receipt-'));
    try {
      clearAliasTelemetryForTests(worktreeRoot);
      // alias use
      recordAliasTelemetry({ alias: 'ralph', normalized: 'ralph', canonical: 'execute', tier0: 'execute', sessionId: 's1', warned: true, release: false }, worktreeRoot);
      recordAliasTelemetry({ alias: 'ralph', normalized: 'ralph', canonical: 'execute', tier0: 'execute', sessionId: 's1', warned: false, release: false }, worktreeRoot);
      recordAliasTelemetry({ alias: 'release', normalized: 'release', canonical: 'omc-release', tier0: null, sessionId: 's1', warned: true, release: true }, worktreeRoot);
      const receipts = readUsageReceipts(worktreeRoot);
      expect(receipts.byAlias['ralph'].count).toBe(2);
      expect(receipts.byAlias['release'].count).toBe(1);
      expect(receipts.totals.aliasUses).toBe(3);
      expect(receipts.releaseUses).toBe(1);
      const tail = readTelemetryTail(10, worktreeRoot);
      expect(tail.length).toBe(3);
      expect(tail[0].canonical).toBe('execute');
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it('registry covers expected aliases and excludes self-canonical entries', () => {
    // verify registry sanity: each alias (except canonical self-entries) routes to Tier-0 or omc-release
    for (const e of ALIAS_REGISTRY) {
      const isSelfCanonical = e.alias.toLowerCase() === e.canonical.toLowerCase();
      if (isSelfCanonical) {
        expect(TIER0_WORKFLOWS).toContain(e.canonical as any);
      } else {
        expect(['plan', 'execute', 'review', 'verify', 'omc-release']).toContain(e.canonical);
      }
    }
  });
});
