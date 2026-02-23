import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { execSync } from 'child_process';

// Mock isTeamEnabled so team/ultrapilot/swarm keywords are detected in CI
vi.mock('../features/auto-update.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isTeamEnabled: () => true,
  };
});

import {
  extractPromptText,
  removeCodeBlocks,
  detectKeywordsWithType,
  hasKeyword,
  getPrimaryKeyword,
  type DetectedKeyword
} from '../hooks/keyword-detector/index.js';
import {
  formatTodoStatus,
  getNextPendingTodo,
  type Todo,
  type IncompleteTodosResult
} from '../hooks/todo-continuation/index.js';
import {
  resetTodoContinuationAttempts
} from '../hooks/persistent-mode/index.js';
import {
  startUltraQA,
  clearUltraQAState,
  isRalphLoopActive
} from '../hooks/ultraqa/index.js';
import {
  createRalphLoopHook,
  clearRalphState,
  isUltraQAActive
} from '../hooks/ralph/index.js';
import { processHook } from '../hooks/bridge.js';

describe('Keyword Detector', () => {
  describe('extractPromptText', () => {
    it('should extract text from text parts', () => {
      const parts = [
        { type: 'text', text: 'Hello world' },
        { type: 'text', text: 'How are you?' }
      ];
      expect(extractPromptText(parts)).toBe('Hello world How are you?');
    });

    it('should filter out non-text parts', () => {
      const parts = [
        { type: 'text', text: 'Hello' },
        { type: 'image', url: 'test.jpg' },
        { type: 'text', text: 'world' }
      ];
      expect(extractPromptText(parts)).toBe('Hello world');
    });

    it('should handle empty parts array', () => {
      expect(extractPromptText([])).toBe('');
    });

    it('should handle parts without text', () => {
      const parts = [
        { type: 'text' },
        { type: 'text', text: undefined }
      ];
      expect(extractPromptText(parts)).toBe('');
    });

    it('should join multiple text parts with space', () => {
      const parts = [
        { type: 'text', text: 'analyze' },
        { type: 'text', text: 'this' },
        { type: 'text', text: 'code' }
      ];
      expect(extractPromptText(parts)).toBe('analyze this code');
    });
  });

  describe('removeCodeBlocks', () => {
    it('should remove triple backtick fenced code blocks', () => {
      const text = 'Some text\n```javascript\nconst x = 1;\n```\nMore text';
      const result = removeCodeBlocks(text);
      expect(result).not.toContain('const x = 1');
      expect(result).toContain('Some text');
      expect(result).toContain('More text');
    });

    it('should remove tilde fenced code blocks', () => {
      const text = 'Before\n~~~python\nprint("hello")\n~~~\nAfter';
      const result = removeCodeBlocks(text);
      expect(result).not.toContain('print("hello")');
      expect(result).toContain('Before');
      expect(result).toContain('After');
    });

    it('should remove inline code with single backticks', () => {
      const text = 'Use `analyze` command here';
      const result = removeCodeBlocks(text);
      expect(result).not.toContain('`analyze`');
      expect(result).toContain('Use');
      expect(result).toContain('command here');
    });

    it('should handle multiple code blocks', () => {
      const text = '```js\ncode1\n```\ntext\n```ts\ncode2\n```';
      const result = removeCodeBlocks(text);
      expect(result).not.toContain('code1');
      expect(result).not.toContain('code2');
      expect(result).toContain('text');
    });

    it('should handle text without code blocks', () => {
      const text = 'Just plain text here';
      expect(removeCodeBlocks(text)).toBe(text);
    });

    it('should handle empty string', () => {
      expect(removeCodeBlocks('')).toBe('');
    });

    it('should handle nested inline code', () => {
      const text = 'Text with `inline` and `another` code';
      const result = removeCodeBlocks(text);
      expect(result).not.toContain('`');
      expect(result).toContain('Text with');
      expect(result).toContain('and');
      expect(result).toContain('code');
    });
  });

  describe('detectKeywordsWithType', () => {
    it('should detect ultrawork keyword', () => {
      const detected = detectKeywordsWithType('I need ultrawork mode');
      expect(detected).toHaveLength(1);
      expect(detected[0].type).toBe('ultrawork');
      expect(detected[0].keyword).toBe('ultrawork');
    });

    it('should detect ulw abbreviation', () => {
      const detected = detectKeywordsWithType('Use ulw for this task');
      expect(detected).toHaveLength(1);
      expect(detected[0].type).toBe('ultrawork');
      expect(detected[0].keyword).toBe('ulw');
    });

    it('should detect ultrathink keyword', () => {
      const detected = detectKeywordsWithType('I need to ultrathink this');
      expect(detected).toHaveLength(1);
      expect(detected[0].type).toBe('ultrathink');
      expect(detected[0].keyword).toBe('ultrathink');
    });

    it('should detect ultrathink keyword directly', () => {
      const detected = detectKeywordsWithType('Let me ultrathink about it');
      expect(detected).toHaveLength(1);
      expect(detected[0].type).toBe('ultrathink');
      expect(detected[0].keyword).toBe('ultrathink');
    });

    it('should detect deepsearch keywords for codebase search', () => {
      const patterns = [
        'search the codebase',
        'find in codebase',
        'deepsearch for pattern'
      ];
      for (const pattern of patterns) {
        const detected = detectKeywordsWithType(pattern);
        expect(detected.length).toBeGreaterThan(0);
        expect(detected[0].type).toBe('deepsearch');
      }
    });

    it('should detect analyze keywords with restricted patterns', () => {
      const patterns = [
        'deep analyze this code',
        'deepanalyze this code',
        'deep-analyze the issue'
      ];
      for (const pattern of patterns) {
        const detected = detectKeywordsWithType(pattern);
        expect(detected.length).toBeGreaterThan(0);
        expect(detected[0].type).toBe('analyze');
      }
    });

    it('should be case insensitive', () => {
      const variants = ['ULTRAWORK', 'UltraWork', 'uLtRaWoRk'];
      for (const variant of variants) {
        const detected = detectKeywordsWithType(variant);
        expect(detected).toHaveLength(1);
        expect(detected[0].type).toBe('ultrawork');
      }
    });

    it('should respect word boundaries', () => {
      // Should not match partial words
      const text = 'multiwork is not ultrawork';
      const detected = detectKeywordsWithType(text);
      expect(detected).toHaveLength(1);
      expect(detected[0].keyword).toBe('ultrawork');
    });

    it('should include position information', () => {
      const detected = detectKeywordsWithType('Start search the codebase here');
      expect(detected[0].position).toBeGreaterThanOrEqual(0);
    });

    it('should return empty array for no matches', () => {
      const detected = detectKeywordsWithType('Just plain text');
      expect(detected).toEqual([]);
    });

    it('should detect multiple different keyword types', () => {
      const text = 'search the codebase and deep analyze the bug';
      const detected = detectKeywordsWithType(text);
      expect(detected.length).toBeGreaterThanOrEqual(2);
      const types = detected.map(d => d.type);
      expect(types).toContain('deepsearch');
      expect(types).toContain('analyze');
    });

    // New keyword types tests
    it('should detect cancel keyword', () => {
      const detected = detectKeywordsWithType('cancelomc this task');
      expect(detected).toHaveLength(1);
      expect(detected[0].type).toBe('cancel');
      expect(detected[0].keyword).toBe('cancelomc');
    });

    it('should detect cancel keyword variations', () => {
      const cancelTerms = ['cancelomc', 'stopomc'];
      for (const term of cancelTerms) {
        const detected = detectKeywordsWithType(`Please ${term} the process`);
        expect(detected).toHaveLength(1);
        expect(detected[0].type).toBe('cancel');
        expect(detected[0].keyword).toBe(term);
      }
    });

    it('should route legacy ultrapilot keyword to team (with dual-emission)', () => {
      const detected = detectKeywordsWithType('use ultrapilot for this');
      expect(detected).toHaveLength(2);
      expect(detected[0].type).toBe('ultrapilot');
      expect(detected[1].type).toBe('team');
      expect(detected[0].keyword).toBe('ultrapilot');
    });

    it('should route legacy ultrapilot patterns to team', () => {
      const patterns = [
        'ultrapilot this project',
        'parallel build the app',
        'swarm build the system'
      ];
      for (const pattern of patterns) {
        const detected = detectKeywordsWithType(pattern);
        expect(detected.length).toBeGreaterThan(0);
        const hasTeam = detected.some(d => d.type === 'team');
        expect(hasTeam).toBe(true);
      }
    });

    it('should route legacy swarm keyword to team (with dual-emission)', () => {
      const detected = detectKeywordsWithType('swarm 5 agents to fix this');
      expect(detected).toHaveLength(2);
      expect(detected[0].type).toBe('swarm');
      expect(detected[1].type).toBe('team');
      expect(detected[0].keyword).toBe('swarm 5 agents');
    });

    it('should route coordinated agents pattern to team (with dual-emission)', () => {
      const detected = detectKeywordsWithType('use coordinated agents');
      expect(detected).toHaveLength(2);
      expect(detected[0].type).toBe('swarm');
      expect(detected[1].type).toBe('team');
      expect(detected[0].keyword).toBe('coordinated agents');
    });

    it('should detect pipeline keyword', () => {
      const detected = detectKeywordsWithType('use agent pipeline for this');
      expect(detected).toHaveLength(1);
      expect(detected[0].type).toBe('pipeline');
      expect(detected[0].keyword).toBe('agent pipeline');
    });

    it('should detect chain agents pattern', () => {
      const detected = detectKeywordsWithType('chain agents together');
      expect(detected).toHaveLength(1);
      expect(detected[0].type).toBe('pipeline');
      expect(detected[0].keyword).toBe('chain agents');
    });

    it('should detect ralplan keyword', () => {
      const detected = detectKeywordsWithType('ralplan this feature');
      expect(detected).toHaveLength(1);
      expect(detected[0].type).toBe('ralplan');
      expect(detected[0].keyword).toBe('ralplan');
    });

    it('should NOT detect "plan this" / "plan the" patterns (FP-prone, removed in #824)', () => {
      const patterns = [
        'plan this feature',
        'plan the refactoring'
      ];
      for (const pattern of patterns) {
        const detected = detectKeywordsWithType(pattern);
        expect(detected).toHaveLength(0);
      }
    });

    it('should detect tdd keyword', () => {
      const detected = detectKeywordsWithType('use tdd for this');
      expect(detected).toHaveLength(1);
      expect(detected[0].type).toBe('tdd');
      expect(detected[0].keyword).toBe('tdd');
    });

    it('should detect tdd patterns', () => {
      const patterns = [
        'test first development',
        'use tdd approach'
      ];
      for (const pattern of patterns) {
        const detected = detectKeywordsWithType(pattern);
        expect(detected.length).toBeGreaterThan(0);
        const hasTDD = detected.some(d => d.type === 'tdd');
        expect(hasTDD).toBe(true);
      }
    });

    it('should not detect research keyword', () => {
      const detected = detectKeywordsWithType('research this topic');
      expect(detected).toHaveLength(0);
    });

    it('should detect deepsearch keyword', () => {
      const detected = detectKeywordsWithType('deepsearch for the pattern');
      expect(detected).toHaveLength(1);
      expect(detected[0].type).toBe('deepsearch');
      expect(detected[0].keyword).toBe('deepsearch');
    });

    it('should detect deepsearch patterns', () => {
      const patterns = [
        'search the codebase for errors',
        'find in codebase',
        'find in the codebase'
      ];
      for (const pattern of patterns) {
        const detected = detectKeywordsWithType(pattern);
        expect(detected.length).toBeGreaterThan(0);
        const hasDeepsearch = detected.some(d => d.type === 'deepsearch');
        expect(hasDeepsearch).toBe(true);
      }
    });

    it('should NOT detect deepsearch for generic find', () => {
      const patterns = [
        'find the file',
        'find this function',
        'search for help'
      ];
      for (const pattern of patterns) {
        const detected = detectKeywordsWithType(pattern);
        const hasDeepsearch = detected.some(d => d.type === 'deepsearch');
        expect(hasDeepsearch).toBe(false);
      }
    });

    it('should detect analyze patterns with restrictions', () => {
      const patterns = [
        'deep analyze this code',
        'deepanalyze this issue',
        'deep-analyze the problem'
      ];
      for (const pattern of patterns) {
        const detected = detectKeywordsWithType(pattern);
        expect(detected.length).toBeGreaterThan(0);
        const hasAnalyze = detected.some(d => d.type === 'analyze');
        expect(hasAnalyze).toBe(true);
      }
    });

    it('should NOT detect analyze for generic patterns', () => {
      const patterns = [
        'how to do this',
        'understand this code',
        'review this code',
        'analyze without context',
        'investigate the bug',
        'debug the issue'
      ];
      for (const pattern of patterns) {
        const detected = detectKeywordsWithType(pattern);
        const hasAnalyze = detected.some(d => d.type === 'analyze');
        expect(hasAnalyze).toBe(false);
      }
    });
  });

  describe('hasKeyword', () => {
    it('should return true when keyword exists', () => {
      expect(hasKeyword('use ultrawork mode')).toBe(true);
      expect(hasKeyword('search the codebase')).toBe(true);
      expect(hasKeyword('deep analyze the bug')).toBe(true);
    });

    it('should return false when no keyword exists', () => {
      expect(hasKeyword('just normal text')).toBe(false);
      expect(hasKeyword('hello world')).toBe(false);
    });

    it('should ignore keywords in code blocks', () => {
      const text = 'Normal text\n```\nsearch in code\n```\nMore text';
      expect(hasKeyword(text)).toBe(false);
    });

    it('should detect keywords outside code blocks', () => {
      const text = 'Please search the codebase\n```\nsome code\n```\nfor this';
      expect(hasKeyword(text)).toBe(true);
    });

    it('should handle empty string', () => {
      expect(hasKeyword('')).toBe(false);
    });
  });

  describe('getPrimaryKeyword', () => {
    it('should return highest priority keyword', () => {
      // ultrawork has highest priority
      const text = 'search and analyze with ultrawork';
      const primary = getPrimaryKeyword(text);
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('ultrawork');
    });

    it('should return ultrathink when present', () => {
      const text = 'ultrathink about this problem';
      const primary = getPrimaryKeyword(text);
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('ultrathink');
    });

    it('should return deepsearch for codebase search', () => {
      const text = 'find in codebase';
      const primary = getPrimaryKeyword(text);
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('deepsearch');
    });

    it('should return analyze when only analyze keyword', () => {
      const text = 'deep analyze the issue';
      const primary = getPrimaryKeyword(text);
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('analyze');
    });

    it('should return null when no keywords', () => {
      const primary = getPrimaryKeyword('just normal text');
      expect(primary).toBeNull();
    });

    it('should ignore code blocks', () => {
      const text = '```\nultrawork code\n```\nsearch the codebase';
      const primary = getPrimaryKeyword(text);
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('deepsearch');
    });

    it('should return first detected when same priority', () => {
      // deepsearch has higher priority than analyze in the priority list
      const text = 'search the codebase and deep analyze the bug';
      const primary = getPrimaryKeyword(text);
      expect(primary).not.toBeNull();
      // Should return deepsearch as it comes first in priority list
      expect(primary!.type).toBe('deepsearch');
    });

    // New priority tests for new keywords
    it('should give cancel highest priority', () => {
      const primary = getPrimaryKeyword('stopomc searching for files');
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('cancel');
    });

    it('should give cancel priority over analyze', () => {
      const primary = getPrimaryKeyword('cancelomc this investigation');
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('cancel');
    });

    it('should prioritize cancel over all other keywords', () => {
      const primary = getPrimaryKeyword('stopomc ultrawork and search');
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('cancel');
    });

    it('should prioritize ralph after cancel', () => {
      const primary = getPrimaryKeyword('ralph mode for the task');
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('ralph');
    });

    it('should not detect ralph in ralph-init compound name', () => {
      const detected = detectKeywordsWithType('ralph-init "create a PRD"');
      const ralphMatch = detected.find(d => d.type === 'ralph');
      expect(ralphMatch).toBeUndefined();
    });

    it('should not detect ralph in /oh-my-claudecode:ralph-init', () => {
      const primary = getPrimaryKeyword('/oh-my-claudecode:ralph-init "my project"');
      expect(primary?.type).not.toBe('ralph');
    });

    it('should still detect ralph when standalone', () => {
      const detected = detectKeywordsWithType('use ralph for this task');
      const ralphMatch = detected.find(d => d.type === 'ralph');
      expect(ralphMatch).toBeDefined();
      expect(ralphMatch!.keyword).toBe('ralph');
    });

    it('should prioritize ultrapilot for legacy ultrapilot trigger', () => {
      const primary = getPrimaryKeyword('ultrapilot this task');
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('ultrapilot');
    });

    it('should prioritize team for legacy swarm trigger', () => {
      const primary = getPrimaryKeyword('swarm 5 agents for this');
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('team');
    });

    it('should prioritize pipeline correctly', () => {
      const primary = getPrimaryKeyword('agent pipeline the task');
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('pipeline');
    });

    it('should prioritize ralplan over plan', () => {
      const primary = getPrimaryKeyword('ralplan this project');
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('ralplan');
    });

    it('should NOT detect plan for "plan this feature" (FP-prone pattern removed in #824)', () => {
      const primary = getPrimaryKeyword('plan this feature');
      expect(primary).toBeNull();
    });

    it('should prioritize tdd correctly', () => {
      const primary = getPrimaryKeyword('tdd for this feature');
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('tdd');
    });

    it('should return null for removed research keyword', () => {
      const primary = getPrimaryKeyword('research this topic');
      expect(primary).toBeNull();
    });

    it('should prioritize deepsearch over generic search', () => {
      const primary = getPrimaryKeyword('search the codebase');
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('deepsearch');
    });

    it('should prioritize analyze with restricted pattern', () => {
      const primary = getPrimaryKeyword('deep analyze the bug');
      expect(primary).not.toBeNull();
      expect(primary!.type).toBe('analyze');
    });
  });
});

describe('Team staged workflow integration', () => {
  let testDir: string;
  const sessionId = 'team-session-test';

  beforeEach(() => {
    testDir = join(tmpdir(), `omc-team-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, '.omc', 'state', 'sessions', sessionId), { recursive: true });
    execSync('git init', { cwd: testDir });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('restores active Team stage on session-start', async () => {
    writeFileSync(
      join(testDir, '.omc', 'state', 'sessions', sessionId, 'team-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        stage: 'team-exec',
        team_name: 'delivery-team'
      })
    );

    const result = await processHook('session-start', {
      sessionId,
      directory: testDir,
    });

    expect(result.continue).toBe(true);
    expect(result.message || '').toContain('[TEAM MODE RESTORED]');
    expect(result.message || '').toContain('delivery-team');
    expect(result.message || '').toContain('team-exec');
  });

  it('emits terminal Team restore guidance on cancelled stage', async () => {
    writeFileSync(
      join(testDir, '.omc', 'state', 'sessions', sessionId, 'team-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        stage: 'team-fix',
        status: 'cancelled',
        team_name: 'delivery-team'
      })
    );

    const result = await processHook('session-start', {
      sessionId,
      directory: testDir,
    });

    expect(result.continue).toBe(true);
    expect(result.message || '').toContain('[TEAM MODE TERMINAL STATE DETECTED]');
    expect(result.message || '').toContain('cancel');
  });

  it('enforces verify stage continuation while active and non-terminal', async () => {
    writeFileSync(
      join(testDir, '.omc', 'state', 'sessions', sessionId, 'team-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        stage: 'team-verify',
        team_name: 'delivery-team'
      })
    );

    const result = await processHook('persistent-mode', {
      sessionId,
      directory: testDir,
    });

    expect(result.continue).toBe(true);
    expect(result.message).toContain('[TEAM MODE CONTINUATION]');
    expect(result.message).toContain('team-verify');
    expect(result.message).toContain('Continue verification');
  });

  it('enforces fix stage continuation while active and non-terminal', async () => {
    writeFileSync(
      join(testDir, '.omc', 'state', 'sessions', sessionId, 'team-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        stage: 'team-fix',
        team_name: 'delivery-team'
      })
    );

    const result = await processHook('persistent-mode', {
      sessionId,
      directory: testDir,
    });

    expect(result.continue).toBe(true);
    expect(result.message).toContain('[TEAM MODE CONTINUATION]');
    expect(result.message).toContain('team-fix');
    expect(result.message).toContain('fix loop');
  });

  it('allows terminal cleanup when Team stage is cancelled', async () => {
    writeFileSync(
      join(testDir, '.omc', 'state', 'sessions', sessionId, 'team-state.json'),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        stage: 'team-verify',
        status: 'cancelled',
        team_name: 'delivery-team'
      })
    );

    const result = await processHook('persistent-mode', {
      sessionId,
      directory: testDir,
    });

    expect(result.continue).toBe(true);
    expect(result.message || '').not.toContain('[TEAM MODE CONTINUATION]');
  });
});

describe('Persistent-mode reply cleanup behavior', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let testDir: string;
  let tempHome: string;
  const sessionId = 'reply-cleanup-session';

  beforeEach(() => {
    testDir = join(tmpdir(), `omc-reply-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempHome = join(tmpdir(), `omc-reply-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(tempHome, { recursive: true });
    execSync('git init', { cwd: testDir });

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    rmSync(testDir, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('does not remove reply-session registry on idle Stop/persistent-mode', async () => {
    const registryPath = join(homedir(), '.omc', 'state', 'reply-session-registry.jsonl');
    mkdirSync(join(homedir(), '.omc', 'state'), { recursive: true });
    writeFileSync(
      registryPath,
      `${JSON.stringify({
        platform: 'telegram',
        messageId: '123',
        sessionId,
        tmuxPaneId: '%1',
        tmuxSessionName: 'main',
        event: 'session-start',
        createdAt: new Date().toISOString(),
      })}\n`,
    );

    const before = readFileSync(registryPath, 'utf-8');
    const result = await processHook('persistent-mode', {
      sessionId,
      directory: testDir,
    });
    const after = readFileSync(registryPath, 'utf-8');

    expect(result.continue).toBe(true);
    expect(existsSync(registryPath)).toBe(true);
    expect(after).toBe(before);
    expect(after).toContain(sessionId);
  });
});

describe('Todo Continuation', () => {
  describe('formatTodoStatus', () => {
    it('should format when all tasks complete', () => {
      const result: IncompleteTodosResult = {
        count: 0,
        todos: [],
        total: 5,
        source: 'todo'
      };
      expect(formatTodoStatus(result)).toBe('All tasks complete (5 total)');
    });

    it('should format with incomplete tasks', () => {
      const result: IncompleteTodosResult = {
        count: 3,
        todos: [],
        total: 10,
        source: 'todo'
      };
      expect(formatTodoStatus(result)).toBe('7/10 completed, 3 remaining');
    });

    it('should handle zero total tasks', () => {
      const result: IncompleteTodosResult = {
        count: 0,
        todos: [],
        total: 0,
        source: 'none'
      };
      expect(formatTodoStatus(result)).toBe('All tasks complete (0 total)');
    });

    it('should handle all tasks incomplete', () => {
      const result: IncompleteTodosResult = {
        count: 5,
        todos: [],
        total: 5,
        source: 'todo'
      };
      expect(formatTodoStatus(result)).toBe('0/5 completed, 5 remaining');
    });

    it('should handle single task remaining', () => {
      const result: IncompleteTodosResult = {
        count: 1,
        todos: [],
        total: 10,
        source: 'todo'
      };
      expect(formatTodoStatus(result)).toBe('9/10 completed, 1 remaining');
    });
  });

  describe('getNextPendingTodo', () => {
    it('should return in_progress todo first', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending' },
        { content: 'Task 2', status: 'in_progress' },
        { content: 'Task 3', status: 'pending' }
      ];
      const result: IncompleteTodosResult = {
        count: 3,
        todos,
        total: 3,
        source: 'todo'
      };
      const next = getNextPendingTodo(result);
      expect(next).not.toBeNull();
      expect(next!.content).toBe('Task 2');
      expect(next!.status).toBe('in_progress');
    });

    it('should return first pending when no in_progress', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending' },
        { content: 'Task 2', status: 'pending' },
        { content: 'Task 3', status: 'completed' }
      ];
      const result: IncompleteTodosResult = {
        count: 2,
        todos: todos.filter(t => t.status !== 'completed'),
        total: 3,
        source: 'todo'
      };
      const next = getNextPendingTodo(result);
      expect(next).not.toBeNull();
      expect(next!.content).toBe('Task 1');
      expect(next!.status).toBe('pending');
    });

    it('should return null when no todos', () => {
      const result: IncompleteTodosResult = {
        count: 0,
        todos: [],
        total: 0,
        source: 'none'
      };
      const next = getNextPendingTodo(result);
      expect(next).toBeNull();
    });

    it('should return null when all completed', () => {
      const result: IncompleteTodosResult = {
        count: 0,
        todos: [],
        total: 3,
        source: 'todo'
      };
      const next = getNextPendingTodo(result);
      expect(next).toBeNull();
    });

    it('should handle todos with priority field', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', priority: 'low' },
        { content: 'Task 2', status: 'in_progress', priority: 'high' }
      ];
      const result: IncompleteTodosResult = {
        count: 2,
        todos,
        total: 2,
        source: 'todo'
      };
      const next = getNextPendingTodo(result);
      expect(next).not.toBeNull();
      expect(next!.content).toBe('Task 2');
    });

    it('should handle todos with id field', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', id: 'todo-1' },
        { content: 'Task 2', status: 'pending', id: 'todo-2' }
      ];
      const result: IncompleteTodosResult = {
        count: 2,
        todos,
        total: 2,
        source: 'todo'
      };
      const next = getNextPendingTodo(result);
      expect(next).not.toBeNull();
      expect(next!.id).toBe('todo-1');
    });

    it('should ignore cancelled todos', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'cancelled' },
        { content: 'Task 2', status: 'pending' }
      ];
      const result: IncompleteTodosResult = {
        count: 1,
        todos: [todos[1]],
        total: 2,
        source: 'todo'
      };
      const next = getNextPendingTodo(result);
      expect(next).not.toBeNull();
      expect(next!.content).toBe('Task 2');
    });

    it('should prefer in_progress over multiple pending', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending' },
        { content: 'Task 2', status: 'pending' },
        { content: 'Task 3', status: 'pending' },
        { content: 'Task 4', status: 'in_progress' }
      ];
      const result: IncompleteTodosResult = {
        count: 4,
        todos,
        total: 4,
        source: 'todo'
      };
      const next = getNextPendingTodo(result);
      expect(next).not.toBeNull();
      expect(next!.content).toBe('Task 4');
      expect(next!.status).toBe('in_progress');
    });
  });

  describe('Todo type validation', () => {
    it('should handle all valid status values', () => {
      const statuses: Array<Todo['status']> = ['pending', 'in_progress', 'completed', 'cancelled'];
      const todos: Todo[] = statuses.map((status, i) => ({
        content: `Task ${i + 1}`,
        status
      }));

      expect(todos).toHaveLength(4);
      todos.forEach(todo => {
        expect(todo.content).toBeTruthy();
        expect(statuses).toContain(todo.status);
      });
    });

    it('should handle optional fields', () => {
      const todo: Todo = {
        content: 'Test task',
        status: 'pending',
        priority: 'high',
        id: 'test-123'
      };

      expect(todo.content).toBe('Test task');
      expect(todo.status).toBe('pending');
      expect(todo.priority).toBe('high');
      expect(todo.id).toBe('test-123');
    });

    it('should handle minimal todo object', () => {
      const todo: Todo = {
        content: 'Minimal task',
        status: 'pending'
      };

      expect(todo.content).toBe('Minimal task');
      expect(todo.status).toBe('pending');
      expect(todo.priority).toBeUndefined();
      expect(todo.id).toBeUndefined();
    });
  });

  describe('IncompleteTodosResult validation', () => {
    it('should maintain consistency between count and todos length', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending' },
        { content: 'Task 2', status: 'in_progress' }
      ];
      const result: IncompleteTodosResult = {
        count: todos.length,
        todos,
        total: 5,
        source: 'todo'
      };

      expect(result.count).toBe(result.todos.length);
      expect(result.total).toBeGreaterThanOrEqual(result.count);
    });

    it('should handle edge case of more completed than total', () => {
      // This shouldn't happen in practice, but test the type structure
      const result: IncompleteTodosResult = {
        count: 0,
        todos: [],
        total: 3,
        source: 'todo'
      };

      expect(result.count).toBeLessThanOrEqual(result.total);
    });
  });
});

describe('Hook Output Structure', () => {
  describe('JSON output format', () => {
    it('should create valid hook output with continue flag', () => {
      const output = {
        continue: true,
        message: 'Test message'
      };

      expect(output).toHaveProperty('continue');
      expect(output).toHaveProperty('message');
      expect(typeof output.continue).toBe('boolean');
      expect(typeof output.message).toBe('string');
    });

    it('should create valid hook output without message', () => {
      const output = {
        continue: false
      };

      expect(output).toHaveProperty('continue');
      expect(output.continue).toBe(false);
    });

    it('should serialize to valid JSON', () => {
      const output = {
        continue: true,
        message: 'ULTRAWORK MODE ACTIVATED'
      };

      const json = JSON.stringify(output);
      const parsed = JSON.parse(json);

      expect(parsed.continue).toBe(true);
      expect(parsed.message).toBe('ULTRAWORK MODE ACTIVATED');
    });

    it('should handle multiline messages', () => {
      const output = {
        continue: true,
        message: 'Line 1\nLine 2\nLine 3'
      };

      const json = JSON.stringify(output);
      const parsed = JSON.parse(json);

      expect(parsed.message).toContain('\n');
      expect(parsed.message.split('\n')).toHaveLength(3);
    });

    it('should handle empty message', () => {
      const output = {
        continue: true,
        message: ''
      };

      expect(output.message).toBe('');
    });

    it('should handle special characters in message', () => {
      const output = {
        continue: true,
        message: 'Message with "quotes" and \'apostrophes\' and \\ backslashes'
      };

      const json = JSON.stringify(output);
      const parsed = JSON.parse(json);

      expect(parsed.message).toBe(output.message);
    });
  });

  describe('Hook message formatting', () => {
    it('should format continuation message', () => {
      const message = '[SYSTEM REMINDER - TODO CONTINUATION] Incomplete tasks remain. Continue working.';
      expect(message).toContain('[SYSTEM REMINDER');
      expect(message).toContain('TODO CONTINUATION');
      expect(message).toContain('Continue working');
    });

    it('should format keyword detection message', () => {
      const keyword: DetectedKeyword = {
        type: 'ultrawork',
        keyword: 'ultrawork',
        position: 0
      };
      const message = `ULTRAWORK MODE ACTIVATED - Detected keyword: ${keyword.keyword}`;
      expect(message).toContain('ULTRAWORK MODE');
      expect(message).toContain(keyword.keyword);
    });

    it('should format todo status message', () => {
      const result: IncompleteTodosResult = {
        count: 2,
        todos: [],
        total: 5,
        source: 'todo'
      };
      const status = formatTodoStatus(result);
      const message = `Todo Status: ${status}`;
      expect(message).toContain('3/5 completed');
      expect(message).toContain('2 remaining');
    });
  });
});

describe('Integration: Keyword Detection with Code Blocks', () => {
  it('should detect keywords outside code and ignore inside', () => {
    const text = `
Please search the codebase

\`\`\`javascript
// This search should be ignored
function search() {
  return analyze();
}
\`\`\`

Now deep analyze the bug
    `;

    const detected = detectKeywordsWithType(removeCodeBlocks(text));
    const types = detected.map(d => d.type);

    expect(types).toContain('deepsearch');
    expect(types).toContain('analyze');
    // Should only detect the ones outside code blocks
    expect(detected.filter(d => d.type === 'deepsearch')).toHaveLength(1);
    expect(detected.filter(d => d.type === 'analyze')).toHaveLength(1);
  });

  it('should handle inline code with keywords', () => {
    const text = 'Use the `deepsearch` command to find in codebase';
    const cleanText = removeCodeBlocks(text);
    const detected = detectKeywordsWithType(cleanText);

    // The phrase 'find in codebase' should still be detected
    expect(detected.some(d => d.type === 'deepsearch')).toBe(true);
  });

  it('should prioritize ultrawork even with other keywords', () => {
    const text = 'search the codebase, deep analyze the bug, and use ultrawork mode';
    const primary = getPrimaryKeyword(text);

    expect(primary).not.toBeNull();
    expect(primary!.type).toBe('ultrawork');
    expect(primary!.keyword).toBe('ultrawork');
  });
});

describe('Edge Cases', () => {
  describe('Empty and null inputs', () => {
    it('should handle empty prompt parts', () => {
      expect(extractPromptText([])).toBe('');
    });

    it('should handle empty text in removeCodeBlocks', () => {
      expect(removeCodeBlocks('')).toBe('');
    });

    it('should handle empty text in detectKeywordsWithType', () => {
      expect(detectKeywordsWithType('')).toEqual([]);
    });

    it('should handle empty text in hasKeyword', () => {
      expect(hasKeyword('')).toBe(false);
    });

    it('should handle empty text in getPrimaryKeyword', () => {
      expect(getPrimaryKeyword('')).toBeNull();
    });
  });

  describe('Whitespace handling', () => {
    it('should detect keywords with extra whitespace', () => {
      const text = '   search    the   codebase   ';
      expect(hasKeyword(text)).toBe(true);
    });

    it('should handle newlines and tabs', () => {
      const text = 'search\n\tthe\r\ncodebase';
      const detected = detectKeywordsWithType(text);
      expect(detected.some(d => d.type === 'deepsearch')).toBe(true);
    });
  });

  describe('Unicode and special characters', () => {
    it('should handle unicode characters', () => {
      const text = 'search the codebase with émojis 🔍';
      expect(hasKeyword(text)).toBe(true);
    });

    it('should handle mixed scripts', () => {
      const text = 'Please search the codebase 搜索 искать';
      const detected = detectKeywordsWithType(text);
      expect(detected.some(d => d.type === 'deepsearch')).toBe(true);
    });
  });

  describe('Very long inputs', () => {
    it('should handle long text efficiently', () => {
      const longText = 'plain text '.repeat(1000) + ' search the codebase';
      expect(hasKeyword(longText)).toBe(true);
    });

    it('should handle many code blocks', () => {
      const manyBlocks = '```code```\n'.repeat(100) + 'search the codebase';
      const cleaned = removeCodeBlocks(manyBlocks);
      expect(hasKeyword(cleaned)).toBe(true);
    });
  });
});

describe('UltraQA Loop', () => {
  describe('State Management', () => {
    it('should define valid UltraQA goal types', () => {
      const validGoalTypes = ['tests', 'build', 'lint', 'typecheck', 'custom'];
      validGoalTypes.forEach(goalType => {
        expect(typeof goalType).toBe('string');
      });
    });

    it('should have valid state structure', () => {
      const state = {
        active: true,
        goal_type: 'tests',
        goal_pattern: null,
        cycle: 1,
        max_cycles: 5,
        failures: [],
        started_at: new Date().toISOString(),
        session_id: 'test-session'
      };

      expect(state.active).toBe(true);
      expect(state.goal_type).toBe('tests');
      expect(state.cycle).toBe(1);
      expect(state.max_cycles).toBe(5);
      expect(Array.isArray(state.failures)).toBe(true);
    });

    it('should track failure history', () => {
      const failures = ['Error 1', 'Error 2', 'Error 1'];
      expect(failures).toHaveLength(3);
      expect(failures.filter(f => f === 'Error 1')).toHaveLength(2);
    });
  });

  describe('Cycle Limits', () => {
    it('should respect max cycles limit', () => {
      const state = {
        cycle: 5,
        max_cycles: 5
      };
      expect(state.cycle).toBe(state.max_cycles);
      expect(state.cycle <= state.max_cycles).toBe(true);
    });

    it('should allow incrementing cycles within limit', () => {
      let cycle = 1;
      const maxCycles = 5;
      while (cycle < maxCycles) {
        cycle++;
        expect(cycle <= maxCycles).toBe(true);
      }
      expect(cycle).toBe(maxCycles);
    });
  });

  describe('Result Types', () => {
    it('should have valid success result', () => {
      const result = {
        success: true,
        cycles: 3,
        reason: 'goal_met' as const
      };
      expect(result.success).toBe(true);
      expect(result.reason).toBe('goal_met');
    });

    it('should have valid failure result', () => {
      const result = {
        success: false,
        cycles: 5,
        reason: 'max_cycles' as const,
        diagnosis: 'Unable to fix recurring issue'
      };
      expect(result.success).toBe(false);
      expect(result.reason).toBe('max_cycles');
      expect(result.diagnosis).toBeDefined();
    });

    it('should detect same failure pattern', () => {
      const failures = ['Error A', 'Error A', 'Error A'];
      const allSame = failures.every(f => f === failures[0]);
      expect(allSame).toBe(true);
    });
  });

  describe('Goal Commands', () => {
    it('should map goal types to commands', () => {
      const goalCommands: Record<string, string> = {
        tests: 'npm test',
        build: 'npm run build',
        lint: 'npm run lint',
        typecheck: 'npm run typecheck || tsc --noEmit'
      };

      expect(goalCommands.tests).toBe('npm test');
      expect(goalCommands.build).toBe('npm run build');
      expect(goalCommands.lint).toBe('npm run lint');
    });
  });

  describe('Progress Formatting', () => {
    it('should format progress message', () => {
      const cycle = 2;
      const maxCycles = 5;
      const status = 'Running tests...';
      const message = `[ULTRAQA Cycle ${cycle}/${maxCycles}] ${status}`;

      expect(message).toBe('[ULTRAQA Cycle 2/5] Running tests...');
      expect(message).toContain('ULTRAQA');
      expect(message).toContain(`${cycle}/${maxCycles}`);
    });
  });
});

describe('Persistent Mode - Max Attempts Counter', () => {
  const testSessionId = 'test-session-123';

  beforeEach(() => {
    // Reset the counter before each test
    resetTodoContinuationAttempts(testSessionId);
  });

  afterEach(() => {
    // Clean up after each test
    resetTodoContinuationAttempts(testSessionId);
  });

  it('should export resetTodoContinuationAttempts function', () => {
    expect(typeof resetTodoContinuationAttempts).toBe('function');
  });

  it('should not throw when resetting non-existent session', () => {
    expect(() => resetTodoContinuationAttempts('non-existent')).not.toThrow();
  });

  it('should allow resetting attempts multiple times', () => {
    resetTodoContinuationAttempts(testSessionId);
    resetTodoContinuationAttempts(testSessionId);
    resetTodoContinuationAttempts(testSessionId);
    // Should not throw
    expect(true).toBe(true);
  });
});

describe('Mutual Exclusion - UltraQA and Ralph', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a unique temp directory for each test
    testDir = join(tmpdir(), `omc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, '.omc'), { recursive: true });
    mkdirSync(join(testDir, '.omc', 'state'), { recursive: true });
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('isUltraQAActive', () => {
    it('should return false when no ultraqa state exists', () => {
      expect(isUltraQAActive(testDir)).toBe(false);
    });

    it('should return true when ultraqa is active', () => {
      const stateFile = join(testDir, '.omc', 'state', 'ultraqa-state.json');
      writeFileSync(stateFile, JSON.stringify({ active: true }));
      expect(isUltraQAActive(testDir)).toBe(true);
    });

    it('should return false when ultraqa is not active', () => {
      const stateFile = join(testDir, '.omc', 'state', 'ultraqa-state.json');
      writeFileSync(stateFile, JSON.stringify({ active: false }));
      expect(isUltraQAActive(testDir)).toBe(false);
    });

    it('should return false for invalid JSON', () => {
      const stateFile = join(testDir, '.omc', 'state', 'ultraqa-state.json');
      writeFileSync(stateFile, 'invalid json');
      expect(isUltraQAActive(testDir)).toBe(false);
    });
  });

  describe('isRalphLoopActive', () => {
    it('should return false when no ralph state exists', () => {
      expect(isRalphLoopActive(testDir)).toBe(false);
    });

    it('should return true when ralph is active', () => {
      const stateFile = join(testDir, '.omc', 'state', 'ralph-state.json');
      writeFileSync(stateFile, JSON.stringify({ active: true }));
      expect(isRalphLoopActive(testDir)).toBe(true);
    });

    it('should return false when ralph is not active', () => {
      const stateFile = join(testDir, '.omc', 'state', 'ralph-state.json');
      writeFileSync(stateFile, JSON.stringify({ active: false }));
      expect(isRalphLoopActive(testDir)).toBe(false);
    });
  });

  describe('UltraQA mutual exclusion', () => {
    it('should fail to start UltraQA when Ralph is active', () => {
      // Activate Ralph first - write to session-scoped path since startUltraQA
      // passes sessionId which makes readRalphState check session path only
      const sessionDir = join(testDir, '.omc', 'state', 'sessions', 'test-session');
      mkdirSync(sessionDir, { recursive: true });
      const ralphStateFile = join(sessionDir, 'ralph-state.json');
      writeFileSync(ralphStateFile, JSON.stringify({ active: true }));

      // Try to start UltraQA
      const result = startUltraQA(testDir, 'tests', 'test-session');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot start UltraQA while Ralph Loop is active');
    });

    it('should succeed starting UltraQA when Ralph is not active', () => {
      const result = startUltraQA(testDir, 'tests', 'test-session');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      // Clean up
      clearUltraQAState(testDir);
    });

    it('should succeed starting UltraQA when ralph state exists but inactive', () => {
      const ralphStateFile = join(testDir, '.omc', 'state', 'ralph-state.json');
      writeFileSync(ralphStateFile, JSON.stringify({ active: false }));

      const result = startUltraQA(testDir, 'tests', 'test-session');

      expect(result.success).toBe(true);

      // Clean up
      clearUltraQAState(testDir);
    });
  });

  describe('Ralph mutual exclusion', () => {
    it('should fail to start Ralph when UltraQA is active', () => {
      // Activate UltraQA first - write to session-scoped path since startLoop
      // passes sessionId which makes isUltraQAActive check session path only
      const sessionDir = join(testDir, '.omc', 'state', 'sessions', 'test-session');
      mkdirSync(sessionDir, { recursive: true });
      const ultraqaStateFile = join(sessionDir, 'ultraqa-state.json');
      writeFileSync(ultraqaStateFile, JSON.stringify({ active: true }));

      // Try to start Ralph
      const hook = createRalphLoopHook(testDir);
      const result = hook.startLoop('test-session', 'test prompt');

      expect(result).toBe(false);
    });

    it('should succeed starting Ralph when UltraQA is not active', () => {
      const hook = createRalphLoopHook(testDir);
      const result = hook.startLoop('test-session', 'test prompt');

      expect(result).toBe(true);

      // Clean up
      clearRalphState(testDir);
    });

    it('should succeed starting Ralph when ultraqa state exists but inactive', () => {
      const ultraqaStateFile = join(testDir, '.omc', 'state', 'ultraqa-state.json');
      writeFileSync(ultraqaStateFile, JSON.stringify({ active: false }));

      const hook = createRalphLoopHook(testDir);
      const result = hook.startLoop('test-session', 'test prompt');

      expect(result).toBe(true);

      // Clean up
      clearRalphState(testDir);
    });
  });

  describe('State cleanup', () => {
    it('should clear UltraQA state properly', () => {
      const result = startUltraQA(testDir, 'tests', 'test-session');
      expect(result.success).toBe(true);

      const cleared = clearUltraQAState(testDir);
      expect(cleared).toBe(true);

      expect(isRalphLoopActive(testDir)).toBe(false);
    });

    it('should clear Ralph state properly', () => {
      const hook = createRalphLoopHook(testDir);
      hook.startLoop('test-session', 'test prompt');

      const cleared = clearRalphState(testDir);
      expect(cleared).toBe(true);

      expect(isUltraQAActive(testDir)).toBe(false);
    });
  });
});
