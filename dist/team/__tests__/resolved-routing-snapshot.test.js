import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildResolvedRoutingSnapshot } from '../stage-router.js';
import { CANONICAL_TEAM_ROLES } from '../../shared/types.js';
import { CLAUDE_FAMILY_DEFAULTS, BUILTIN_EXTERNAL_MODEL_DEFAULTS } from '../../config/models.js';
const ENV_KEYS = [
    'OMC_MODEL_HIGH',
    'OMC_MODEL_MEDIUM',
    'OMC_MODEL_LOW',
    'CLAUDE_CODE_BEDROCK_OPUS_MODEL',
    'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
    'CLAUDE_CODE_BEDROCK_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];
let savedEnv = {};
beforeAll(() => {
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
});
afterAll(() => {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] !== undefined) {
            process.env[key] = savedEnv[key];
        }
        else {
            delete process.env[key];
        }
    }
});
describe('buildResolvedRoutingSnapshot', () => {
    it('produces an entry for every canonical role', () => {
        const snap = buildResolvedRoutingSnapshot({});
        for (const role of CANONICAL_TEAM_ROLES) {
            expect(snap[role]).toBeDefined();
            expect(snap[role].primary).toBeDefined();
            expect(snap[role].fallback).toBeDefined();
        }
        expect(Object.keys(snap)).toHaveLength(CANONICAL_TEAM_ROLES.length);
    });
    it('stores an inactive Claude structural slot for every primary', () => {
        const cfg = {
            team: {
                roleRouting: {
                    critic: { provider: 'codex', model: 'gpt-5.3-codex' },
                    'code-reviewer': { provider: 'gemini' },
                    executor: { provider: 'claude' },
                },
            },
        };
        const snap = buildResolvedRoutingSnapshot(cfg);
        expect(snap.critic.primary.provider).toBe('codex');
        expect(snap.critic.fallback.provider).toBe('claude');
        expect(snap['code-reviewer'].primary.provider).toBe('gemini');
        expect(snap['code-reviewer'].fallback.provider).toBe('claude');
        expect(snap.executor.primary.provider).toBe('claude');
        expect(snap.executor.fallback.provider).toBe('claude');
    });
    it('stores the inactive structural slot with the primary agent', () => {
        const cfg = {
            team: { roleRouting: { critic: { provider: 'codex', agent: 'analyst' } } },
        };
        const snap = buildResolvedRoutingSnapshot(cfg);
        expect(snap.critic.primary.agent).toBe('analyst');
        expect(snap.critic.fallback.agent).toBe('analyst');
    });
    it('stores the inactive structural slot with a Claude tier model', () => {
        const cfg = {
            team: { roleRouting: { critic: { provider: 'codex', model: 'gpt-5.3-codex' } } },
        };
        const snap = buildResolvedRoutingSnapshot(cfg);
        // primary is the explicit codex model
        expect(snap.critic.primary.model).toBe('gpt-5.3-codex');
        // The inactive Claude slot does not echo an external model ID.
        expect(snap.critic.fallback.model).toBe(CLAUDE_FAMILY_DEFAULTS.OPUS);
    });
    it('stores the inactive structural slot with a Claude tier for tier input', () => {
        const cfg = {
            team: { roleRouting: { executor: { provider: 'codex', model: 'HIGH' } } },
        };
        const snap = buildResolvedRoutingSnapshot(cfg);
        // primary on codex: tier maps to codex builtin (tiers are claude-centric)
        expect(snap.executor.primary.model).toBe(BUILTIN_EXTERNAL_MODEL_DEFAULTS.codexModel);
        // The inactive Claude slot resolves tier input independently.
        expect(snap.executor.fallback.model).toBe(CLAUDE_FAMILY_DEFAULTS.OPUS);
    });
    it('stores Claude in both orchestrator primary and inactive slot', () => {
        const cfg = {
            team: { roleRouting: { orchestrator: { model: 'HIGH' } } },
        };
        const snap = buildResolvedRoutingSnapshot(cfg);
        expect(snap.orchestrator.primary.provider).toBe('claude');
        expect(snap.orchestrator.fallback.provider).toBe('claude');
        expect(snap.orchestrator.primary.agent).toBe('omc');
    });
    it('snapshot is a plain object — JSON-roundtrip-safe for TeamConfig persistence', () => {
        const cfg = {
            team: {
                roleRouting: {
                    critic: { provider: 'codex' },
                    executor: { provider: 'claude', model: 'MEDIUM' },
                },
            },
        };
        const snap = buildResolvedRoutingSnapshot(cfg);
        const roundtripped = JSON.parse(JSON.stringify(snap));
        expect(roundtripped).toEqual(snap);
    });
    it('snapshot is stable: two calls with same cfg produce equal results (immutability requirement)', () => {
        const cfg = {
            team: { roleRouting: { critic: { provider: 'codex' } } },
        };
        const a = buildResolvedRoutingSnapshot(cfg);
        const b = buildResolvedRoutingSnapshot(cfg);
        expect(a).toEqual(b);
    });
    it('applies accepted alias keys when building the persisted snapshot', () => {
        const cfg = {
            team: { roleRouting: { reviewer: { provider: 'gemini' } } },
        };
        const snap = buildResolvedRoutingSnapshot(cfg);
        expect(snap['code-reviewer'].primary.provider).toBe('gemini');
        expect(snap['code-reviewer'].fallback.provider).toBe('claude');
    });
});
//# sourceMappingURL=resolved-routing-snapshot.test.js.map