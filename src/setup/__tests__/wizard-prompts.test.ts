/**
 * Tests for `runInteractiveWizard()` — the pre-phase readline wizard used
 * by bare `omc setup` on a TTY.
 *
 * Strategy: drive the wizard with a scripted fake Prompter whose
 * `askSelect/askConfirm/askText/askSecret` methods return pre-programmed
 * answers. Assert on the returned `AnswersFile` shape and on which
 * questions were actually asked (to verify conditional gating).
 */

import { describe, it, expect, vi } from 'vitest';
import { runInteractiveWizard } from '../wizard-prompts.js';
import { buildPreset } from '../preset-builder.js';
import type { Prompter, PrompterSelectOption } from '../prompts.js';

// ---------------------------------------------------------------------------
// Fake prompter
// ---------------------------------------------------------------------------

interface ScriptedAnswers {
  /** Map of question-text-fragment → label to return */
  select?: Array<{ match: string; label: string }>;
  /** Secret answers, in order */
  secrets?: string[];
}

interface RecordedCall {
  kind: 'select' | 'secret';
  question: string;
  returned: string;
}

function makeFakePrompter(script: ScriptedAnswers): {
  prompter: Prompter;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const secrets = [...(script.secrets ?? [])];

  const prompter: Prompter = {
    async askSelect<T extends string>(
      question: string,
      options: PrompterSelectOption<T>[],
      defaultValue: T,
    ): Promise<T> {
      const rule = script.select?.find((r) => question.includes(r.match));
      const label = rule?.label ?? defaultValue;
      // Ensure the label actually exists in `options` so we mimic real askSelect.
      const hit = options.find((o) => o.label === label);
      const returned = (hit?.label ?? defaultValue) as T;
      calls.push({ kind: 'select', question, returned });
      return returned;
    },
    async askConfirm(question: string, defaultValue: boolean): Promise<boolean> {
      calls.push({ kind: 'select', question, returned: String(defaultValue) });
      return defaultValue;
    },
    async askText(question: string, defaultValue = ''): Promise<string> {
      calls.push({ kind: 'select', question, returned: defaultValue });
      return defaultValue;
    },
    async askSecret(question: string): Promise<string> {
      const value = secrets.shift() ?? '';
      calls.push({ kind: 'secret', question, returned: value });
      return value;
    },
    close(): void {
      // no-op
    },
  };

  return { prompter, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runInteractiveWizard', () => {
  it('happy path: all 11 questions asked when everything is enabled', async () => {
    const { prompter, calls } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Global (all projects)' },
        // installStyle asked because detectInstallStyleNeeded returns true
        { match: 'will change your base Claude config', label: 'Overwrite base CLAUDE.md (Recommended)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'Yes, configure MCP servers' },
        { match: 'enable agent teams', label: 'Yes, enable teams (Recommended)' },
        { match: 'How should teammates be displayed', label: 'Auto (Recommended)' },
        { match: 'How many agents should teams spawn', label: '3 agents (Recommended)' },
        { match: 'Which agent type should teammates', label: 'executor (Recommended)' },
        { match: 'support the project by starring it', label: 'Yes, star it!' },
      ],
      secrets: ['exa-key-value', 'gh-token-value'],
    });

    const answers = await runInteractiveWizard(prompter, {
      detectInstallStyleNeeded: () => true,
    });

    expect(answers.target).toBe('global');
    expect(answers.installStyle).toBe('overwrite');
    expect(answers.executionMode).toBe('ultrawork');
    expect(answers.installCli).toBe(true);
    expect(answers.taskTool).toBe('builtin');
    expect(answers.mcp?.enabled).toBe(true);
    expect(answers.mcp?.servers).toEqual(['context7', 'exa', 'filesystem', 'github']);
    expect(answers.mcp?.credentials?.exa).toBe('exa-key-value');
    expect(answers.mcp?.credentials?.github).toBe('gh-token-value');
    expect(answers.mcp?.onMissingCredentials).toBe('install-without-auth');
    expect(answers.teams?.enabled).toBe(true);
    expect(answers.teams?.displayMode).toBe('auto');
    expect(answers.teams?.agentCount).toBe(3);
    expect(answers.teams?.agentType).toBe('executor');
    expect(answers.starRepo).toBe(true);

    // 11 select calls + 2 secret calls
    const selects = calls.filter((c) => c.kind === 'select');
    const secrets = calls.filter((c) => c.kind === 'secret');
    expect(selects.length).toBe(11);
    expect(secrets.length).toBe(2);
  });

  it('returned AnswersFile is valid for buildPreset', async () => {
    const { prompter } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Local (this project)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'install the OMC CLI globally', label: 'No - Skip' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'No, skip' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'No thanks' },
      ],
    });

    const answers = await runInteractiveWizard(prompter, {
      detectInstallStyleNeeded: () => false,
    });

    // Must not throw — exercises the full buildPreset validation pipeline.
    const options = buildPreset(answers);
    expect(options.target).toBe('local');
    expect(options.installStyle).toBe('overwrite');
    expect(options.mcp.enabled).toBe(false);
    expect(options.teams.enabled).toBe(false);
    expect(options.starRepo).toBe(false);
  });

  it('installStyle: skipped when detectInstallStyleNeeded returns false', async () => {
    const { prompter, calls } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Global (all projects)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'No, skip' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'No thanks' },
      ],
    });

    const answers = await runInteractiveWizard(prompter, {
      detectInstallStyleNeeded: () => false,
    });

    expect(answers.target).toBe('global');
    expect(answers.installStyle).toBe('overwrite');

    // installStyle question NOT asked
    const hit = calls.find((c) => c.question.includes('will change your base Claude config'));
    expect(hit).toBeUndefined();
  });

  it('installStyle: skipped when target is local (even if detect returns true)', async () => {
    const { prompter, calls } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Local (this project)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'No, skip' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'No thanks' },
      ],
    });

    const detect = vi.fn(() => true);
    await runInteractiveWizard(prompter, { detectInstallStyleNeeded: detect });

    // installStyle should NOT have been asked because target=local.
    // The wizard may still call `detect` to check for global-only; but
    // mainly we assert the question wasn't asked.
    const hit = calls.find((c) => c.question.includes('will change your base Claude config'));
    expect(hit).toBeUndefined();
  });

  it('teams display/count/type: skipped when teamsEnabled=false', async () => {
    const { prompter, calls } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Local (this project)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'No, skip' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'Yes, star it!' },
      ],
    });

    const answers = await runInteractiveWizard(prompter);
    expect(answers.teams?.enabled).toBe(false);

    // The three conditional team questions must NOT appear in calls.
    const displayAsked = calls.some((c) => c.question.includes('How should teammates be displayed'));
    const countAsked = calls.some((c) => c.question.includes('How many agents should teams'));
    const typeAsked = calls.some((c) => c.question.includes('Which agent type should teammates'));
    expect(displayAsked).toBe(false);
    expect(countAsked).toBe(false);
    expect(typeAsked).toBe(false);
  });

  it('credential prompts blank → servers installed but credentials omitted', async () => {
    const { prompter } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Local (this project)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'Yes, configure MCP servers' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'No thanks' },
      ],
      secrets: ['', ''], // blank exa + blank github
    });

    const answers = await runInteractiveWizard(prompter);
    expect(answers.mcp?.enabled).toBe(true);
    expect(answers.mcp?.servers).toEqual(['context7', 'exa', 'filesystem', 'github']);
    expect(answers.mcp?.credentials?.exa).toBeUndefined();
    expect(answers.mcp?.credentials?.github).toBeUndefined();
    // Install-without-auth preserved so blank-credential servers still install.
    expect(answers.mcp?.onMissingCredentials).toBe('install-without-auth');
  });

  it('MCP credentials: secret prompts skipped entirely when mcpEnabled=false', async () => {
    const { prompter, calls } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Local (this project)' },
        { match: 'parallel execution mode', label: 'ultrawork (maximum capability) (Recommended)' },
        { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'No, skip' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'No thanks' },
      ],
    });

    const answers = await runInteractiveWizard(prompter);
    expect(answers.mcp?.enabled).toBe(false);
    expect(answers.mcp?.servers).toEqual([]);

    const secretCalls = calls.filter((c) => c.kind === 'secret');
    expect(secretCalls.length).toBe(0);
  });

  it('executionMode "No default" → undefined so buildPreset leaves it unset', async () => {
    const { prompter } = makeFakePrompter({
      select: [
        { match: 'Where should I configure', label: 'Local (this project)' },
        { match: 'parallel execution mode', label: 'No default' },
        { match: 'install the OMC CLI globally', label: 'Yes (Recommended)' },
        { match: 'task management tool', label: 'Built-in Tasks (default)' },
        { match: 'configure MCP servers', label: 'No, skip' },
        { match: 'enable agent teams', label: 'No, skip' },
        { match: 'support the project', label: 'No thanks' },
      ],
    });

    const answers = await runInteractiveWizard(prompter);
    expect(answers.executionMode).toBeUndefined();

    const options = buildPreset(answers);
    expect(options.executionMode).toBeUndefined();
  });
});
