/**
 * Hooks async flag configuration verification.
 *
 * Issue #4204: Mark state-only hooks async
 * - project-memory-posttool (PostToolUse): MUST be async (state-only, no context return)
 * - SubagentStart: MUST be sync (returns additionalContext for hook system)
 * - SubagentStop: MUST be sync (ordering guarantees per issue #3663 for state writes/replay)
 * - pre-tool-enforcer, post-tool-verifier, rules-injector, directory-context-injector,
 *   post-tool-use-failure: MUST be sync (return context/decisions)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HOOKS_MANIFEST = join(REPO_ROOT, 'hooks', 'hooks.json');

interface Hook {
  type: string;
  command?: string;
  async?: boolean;
  timeout?: number;
}

interface HookGroup {
  matcher: string;
  hooks: Hook[];
}

interface HooksManifest {
  hooks: Record<string, HookGroup[]>;
}

function readHooksManifest(): HooksManifest {
  const content = readFileSync(HOOKS_MANIFEST, 'utf8');
  return JSON.parse(content) as HooksManifest;
}

function findHook(manifest: HooksManifest, eventName: string, scriptName: string): Hook | null {
  const groups = manifest.hooks[eventName];
  if (!groups) return null;
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.command && hook.command.includes(scriptName)) {
        return hook;
      }
    }
  }
  return null;
}

describe('hooks async configuration (issue #4204)', () => {
  const manifest = readHooksManifest();

  it('project-memory-posttool in PostToolUse MUST be async (state-only, no context return)', () => {
    const hook = findHook(manifest, 'PostToolUse', 'project-memory-posttool.mjs');
    expect(hook).toBeDefined();
    expect(hook?.async).toBe(true);
  });

  it('SubagentStart MUST be sync (returns additionalContext)', () => {
    const hook = findHook(manifest, 'SubagentStart', 'subagent-tracker.mjs start');
    expect(hook).toBeDefined();
    expect(hook?.async).not.toBe(true); // undefined or false
  });

  it('SubagentStop MUST be sync (ordering guarantees per issue #3663)', () => {
    const hook = findHook(manifest, 'SubagentStop', 'subagent-tracker.mjs stop');
    expect(hook).toBeDefined();
    expect(hook?.async).not.toBe(true); // undefined or false
  });

  it('pre-tool-enforcer MUST be sync (returns context/decisions)', () => {
    const hook = findHook(manifest, 'PreToolUse', 'pre-tool-enforcer.mjs');
    expect(hook).toBeDefined();
    expect(hook?.async).not.toBe(true);
  });

  it('post-tool-verifier MUST be sync (returns context/decisions)', () => {
    const hook = findHook(manifest, 'PostToolUse', 'post-tool-verifier.mjs');
    expect(hook).toBeDefined();
    expect(hook?.async).not.toBe(true);
  });

  it('post-tool-rules-injector MUST be sync (returns context/decisions)', () => {
    const hook = findHook(manifest, 'PostToolUse', 'post-tool-rules-injector.mjs');
    expect(hook).toBeDefined();
    expect(hook?.async).not.toBe(true);
  });

  it('post-tool-directory-context-injector MUST be sync (returns context/decisions)', () => {
    const hook = findHook(manifest, 'PostToolUse', 'post-tool-directory-context-injector.mjs');
    expect(hook).toBeDefined();
    expect(hook?.async).not.toBe(true);
  });

  it('post-tool-use-failure MUST be sync (returns context/decisions)', () => {
    const hook = findHook(manifest, 'PostToolUseFailure', 'post-tool-use-failure.mjs');
    expect(hook).toBeDefined();
    expect(hook?.async).not.toBe(true);
  });
});
