import { join } from 'path';
import { wrapUntrustedFileContent } from '../../agents/prompt-helpers.js';
import { getRulesForPath } from '../rules-injector/index.js';
import type { LazyCodexCompatDecision, LazyCodexCompatSideEffect } from './types.js';
import { safeWriteLazyCodexJson } from './safe-file.js';

export interface LoadedProjectRules {
  readonly decision: LazyCodexCompatDecision;
  readonly message?: string;
}

function lazycodexPath(cwd: string, ...parts: readonly string[]): string {
  return join(cwd, '.lazycodex', ...parts);
}

export function loadProjectRules(cwd: string): LoadedProjectRules {
  const rules = getRulesForPath(cwd, cwd);
  if (rules.length === 0) {
    return {
      decision: {
        behavior: 'project-rules',
        decision: 'none',
        artifactCount: 0,
      },
    };
  }

  const message = rules
    .map((rule) => wrapUntrustedFileContent(rule.relativePath, rule.content))
    .join('\n');

  return {
    decision: {
      behavior: 'project-rules',
      decision: 'loaded',
      artifactCount: rules.length,
    },
    message,
  };
}

export function recordUlwSteering(cwd: string, sessionId: string, prompt: string): LazyCodexCompatSideEffect {
  const path = lazycodexPath(cwd, 'ulw-loop', 'steering.json');
  safeWriteLazyCodexJson(cwd, path, {
    schema_version: 1,
    session_id: sessionId,
    active: true,
    trigger: 'ultrawork',
    original_prompt: prompt,
    updated_at: new Date().toISOString(),
  });
  return { name: 'write-ulw-steering', path };
}

export function recordCompactReset(cwd: string, sessionId: string): readonly LazyCodexCompatSideEffect[] {
  const path = lazycodexPath(cwd, 'hook-cache-resets.json');
  safeWriteLazyCodexJson(cwd, path, {
    schema_version: 1,
    session_id: sessionId,
    event: 'compact-before',
    reset_at: new Date().toISOString(),
    caches: ['project-rules', 'lsp-diagnostics', 'codegraph-guidance'],
  });
  return [
    { name: 'reset-project-rule-cache', path },
    { name: 'reset-lsp-diagnostics-cache', path },
    { name: 'reset-codegraph-guidance-cache', path },
  ];
}
