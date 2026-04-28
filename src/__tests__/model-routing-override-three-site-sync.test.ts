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

    const scriptUrl = pathToFileURL(
      resolve(__dirname, '../../scripts/session-start.mjs'),
    ).href;
    const scriptMod = await import(scriptUrl);
    const scriptSlice = extractOverrideBlock(scriptMod.MODEL_ROUTING_OVERRIDE_MESSAGE);

    const templateUrl = pathToFileURL(
      resolve(__dirname, '../../templates/hooks/session-start.mjs'),
    ).href;
    const templateMod = await import(templateUrl);
    const templateSlice = extractOverrideBlock(templateMod.MODEL_ROUTING_OVERRIDE_MESSAGE);

    const bridge = await import('../hooks/bridge.js');
    const result = await bridge.processHook('session-start', {
      sessionId: 'three-site-sync-test',
      directory: process.cwd(),
    });
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    const bridgeBlock = extractOverrideBlock(parsed.message ?? '');

    expect(scriptSlice).not.toBe('');
    expect(templateSlice).not.toBe('');
    expect(bridgeBlock).not.toBe('');

    // 3-way byte-equal (unconditional — no guard).
    expect(scriptSlice).toBe(templateSlice);
    expect(bridgeBlock).toBe(scriptSlice);

    // Prescriptive shape applied to all three.
    for (const block of [scriptSlice, templateSlice, bridgeBlock]) {
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
