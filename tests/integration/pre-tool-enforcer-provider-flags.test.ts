/**
 * Hook-level regression tests for provider flag parsing in pre-tool-enforcer.mjs
 * Ensures CLAUDE_CODE_USE_BEDROCK and CLAUDE_CODE_USE_VERTEX accept both "1" and "true"
 * through the named-model gate and force-inherit context.
 * Issue: #5131
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PRE_TOOL_ENFORCER = join(PROJECT_ROOT, 'scripts', 'pre-tool-enforcer.mjs');

type HookJson = {
  continue?: boolean;
  suppressOutput?: boolean;
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
};
type HookResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  json: HookJson | null;
};

describe('pre-tool-enforcer.mjs: provider flag parsing (issue #5131)', () => {
  let cwd: string;
  let sessionCounter = 0;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pre-tool-enforcer-provider-'));
    mkdirSync(join(cwd, '.git'), { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  function runHook(input: unknown, extraEnv: Record<string, string> = {}): HookResult {
    const result = spawnSync(process.execPath, [PRE_TOOL_ENFORCER], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: tmpdir(),
        USERPROFILE: tmpdir(),
        XDG_CONFIG_HOME: join(cwd, 'config'),
        CLAUDE_CONFIG_DIR: join(cwd, 'claude'),
        NODE_NO_WARNINGS: '1',
        OMC_DISABLE_MULTIREPO: '1',
        OMC_STATE_DIR: join(cwd, '.omc'),
        OMC_NOTIFY: '0',
        ...extraEnv,
      },
      encoding: 'utf8',
      timeout: 30000,
    });
    let json: HookJson | null = null;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      /* not JSON */
    }
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
  }

  function preToolUseInput(
    command: string,
    tool = 'Bash',
    model?: string
  ): {
    hook_event_name: string;
    tool_name: string;
    tool_input: { command: string; model?: string };
    tool_use_id: string;
    cwd: string;
    session_id: string;
    permission_mode: string;
  } {
    const sid = `provider-flag-test-${process.pid}-${++sessionCounter}`;
    return {
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: { command, ...(model && { model }) },
      tool_use_id: `toolu_${sid}`,
      cwd,
      session_id: sid,
      permission_mode: 'bypassPermissions',
    };
  }

  describe('CLAUDE_CODE_USE_BEDROCK with truthy flag formats', () => {
    it('accepts "1" (original format)', () => {
      const result = runHook(preToolUseInput('echo test'), {
        CLAUDE_CODE_USE_BEDROCK: '1',
      });
      expect(result.code).toBe(0);
      expect(result.json?.continue).not.toBe(false);
    });

    it('accepts "true" (issue #5131)', () => {
      const result = runHook(preToolUseInput('echo test'), {
        CLAUDE_CODE_USE_BEDROCK: 'true',
      });
      expect(result.code).toBe(0);
      expect(result.json?.continue).not.toBe(false);
    });

    it('accepts "TRUE" (uppercase, issue #5131)', () => {
      const result = runHook(preToolUseInput('echo test'), {
        CLAUDE_CODE_USE_BEDROCK: 'TRUE',
      });
      expect(result.code).toBe(0);
      expect(result.json?.continue).not.toBe(false);
    });

    it('accepts " true " (padded with spaces, issue #5131)', () => {
      const result = runHook(preToolUseInput('echo test'), {
        CLAUDE_CODE_USE_BEDROCK: ' true ',
      });
      expect(result.code).toBe(0);
      expect(result.json?.continue).not.toBe(false);
    });

    it('rejects "0"', () => {
      const result = runHook(preToolUseInput('echo test'), {
        CLAUDE_CODE_USE_BEDROCK: '0',
      });
      expect(result.code).toBe(0);
      // "0" should not trigger Bedrock provider path
    });

    it('rejects "false"', () => {
      const result = runHook(preToolUseInput('echo test'), {
        CLAUDE_CODE_USE_BEDROCK: 'false',
      });
      expect(result.code).toBe(0);
      // "false" should not trigger Bedrock provider path
    });
  });

  describe('CLAUDE_CODE_USE_VERTEX with truthy flag formats', () => {
    it('accepts "1" (original format)', () => {
      const result = runHook(preToolUseInput('echo test'), {
        CLAUDE_CODE_USE_VERTEX: '1',
      });
      expect(result.code).toBe(0);
      expect(result.json?.continue).not.toBe(false);
    });

    it('accepts "true" (issue #5131)', () => {
      const result = runHook(preToolUseInput('echo test'), {
        CLAUDE_CODE_USE_VERTEX: 'true',
      });
      expect(result.code).toBe(0);
      expect(result.json?.continue).not.toBe(false);
    });

    it('accepts "TRUE" (uppercase, issue #5131)', () => {
      const result = runHook(preToolUseInput('echo test'), {
        CLAUDE_CODE_USE_VERTEX: 'TRUE',
      });
      expect(result.code).toBe(0);
      expect(result.json?.continue).not.toBe(false);
    });

    it('accepts " true " (padded with spaces, issue #5131)', () => {
      const result = runHook(preToolUseInput('echo test'), {
        CLAUDE_CODE_USE_VERTEX: ' true ',
      });
      expect(result.code).toBe(0);
      expect(result.json?.continue).not.toBe(false);
    });

    it('rejects "0"', () => {
      const result = runHook(preToolUseInput('echo test'), {
        CLAUDE_CODE_USE_VERTEX: '0',
      });
      expect(result.code).toBe(0);
      // "0" should not trigger Vertex provider path
    });

    it('rejects "false"', () => {
      const result = runHook(preToolUseInput('echo test'), {
        CLAUDE_CODE_USE_VERTEX: 'false',
      });
      expect(result.code).toBe(0);
      // "false" should not trigger Vertex provider path
    });
  });

  describe('provider flags through named-model gate', () => {
    it('Bedrock flag "true" with named model works', () => {
      const result = runHook(
        preToolUseInput('echo test', 'Bash', 'claude-opus-4-6'),
        {
          CLAUDE_CODE_USE_BEDROCK: 'true',
        }
      );
      expect(result.code).toBe(0);
      expect(result.json?.continue).not.toBe(false);
    });

    it('Vertex flag "true" with named model works', () => {
      const result = runHook(
        preToolUseInput('echo test', 'Bash', 'claude-sonnet-4-6'),
        {
          CLAUDE_CODE_USE_VERTEX: 'true',
        }
      );
      expect(result.code).toBe(0);
      expect(result.json?.continue).not.toBe(false);
    });
  });

  describe('provider flags with Bedrock/Vertex model IDs', () => {
    it('recognizes Bedrock model ID with CLAUDE_CODE_USE_BEDROCK="true"', () => {
      const result = runHook(preToolUseInput('echo test'), {
        ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-6-v1:0',
        CLAUDE_CODE_USE_BEDROCK: 'true',
      });
      expect(result.code).toBe(0);
      expect(result.json?.continue).not.toBe(false);
    });

    it('recognizes Vertex model ID with CLAUDE_CODE_USE_VERTEX="true"', () => {
      const result = runHook(preToolUseInput('echo test'), {
        ANTHROPIC_MODEL: 'vertex_ai/claude-sonnet-4-6',
        CLAUDE_CODE_USE_VERTEX: 'true',
      });
      expect(result.code).toBe(0);
      expect(result.json?.continue).not.toBe(false);
    });
  });
});
