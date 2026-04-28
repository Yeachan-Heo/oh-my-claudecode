import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// extractOverrideBlock assumes no nested <system-reminder> blocks inside the
// override text; if nested reminders are ever introduced, this helper must
// become depth-aware.
function extractOverrideBlock(source: string): string {
  const start = source.indexOf('[MODEL ROUTING OVERRIDE');
  if (start < 0) return '';
  const end = source.indexOf('</system-reminder>', start);
  if (end < 0) return '';
  return source.slice(start, end);
}

describe('MODEL ROUTING OVERRIDE message — three-site sync', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // REQUIRED canary — guarantees bridge emission path is exercisable from
  // Vitest. Harness pattern from src/__tests__/bedrock-model-routing.test.ts:445-477.
  it('bridge emits MODEL ROUTING OVERRIDE block under forced Bedrock env', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    const bridge = await import('../hooks/bridge.js');
    const result = await bridge.processHook('session-start', {
      sessionId: 'three-site-sync-test',
      directory: process.cwd(),
    });
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    const bridgeBlock = extractOverrideBlock(parsed.message ?? '');
    expect(bridgeBlock).not.toBe('');
    expect(bridgeBlock).toContain('MODEL ROUTING OVERRIDE');
  });

  it('all three emission sites produce byte-equal override text', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';

    // Import the shared constant from the side-effect-free lib modules instead
    // of the hook entrypoints (which call main() at load time). Both lib copies
    // (scripts/lib/ and templates/hooks/lib/) are checked for mutual equality.
    const scriptsLibUrl = pathToFileURL(
      resolve(__dirname, '../../scripts/lib/model-routing-override-message.mjs'),
    ).href;
    const scriptsLibMod = await import(scriptsLibUrl);
    const scriptsSlice = extractOverrideBlock(scriptsLibMod.MODEL_ROUTING_OVERRIDE_MESSAGE);

    const templateLibUrl = pathToFileURL(
      resolve(__dirname, '../../templates/hooks/lib/model-routing-override-message.mjs'),
    ).href;
    const templateLibMod = await import(templateLibUrl);
    const templateSlice = extractOverrideBlock(templateLibMod.MODEL_ROUTING_OVERRIDE_MESSAGE);

    const bridge = await import('../hooks/bridge.js');
    const result = await bridge.processHook('session-start', {
      sessionId: 'three-site-sync-test',
      directory: process.cwd(),
    });
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    const bridgeBlock = extractOverrideBlock(parsed.message ?? '');

    expect(scriptsSlice).not.toBe('');
    expect(templateSlice).not.toBe('');
    expect(bridgeBlock).not.toBe('');

    // 3-way byte-equal (unconditional — no guard).
    expect(templateSlice).toBe(scriptsSlice);
    expect(bridgeBlock).toBe(scriptsSlice);

    // Prescriptive shape applied to all three.
    for (const block of [scriptsSlice, templateSlice, bridgeBlock]) {
      expect(block).toMatch(
        /ANTHROPIC_DEFAULT_SONNET_MODEL|CLAUDE_CODE_BEDROCK_SONNET_MODEL|OMC_SUBAGENT_MODEL/,
      );
      expect(block).toMatch(/\[1m\][\s\S]{0,200}REQUIRED/);
      expect(block).toContain('MODEL ROUTING OVERRIDE');
      expect(block).toContain('NON-STANDARD PROVIDER DETECTED');
      expect(block).toContain('tier alias');
      expect(block).not.toContain('Do NOT pass the `model` parameter');
      expect(block).not.toContain('always omit');
    }
  });
});
