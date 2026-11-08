import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getOmcSystemPrompt } from '../index.js';
import { getAgentDefinitions } from '../agents/definitions.js';
import { resolveSystemPrompt } from '../agents/prompt-helpers.js';

describe('skininthegamebros guidance', () => {
  const originalUserType = process.env.USER_TYPE;

  beforeEach(() => {
    if (originalUserType === undefined) {
      delete process.env.USER_TYPE;
    } else {
      process.env.USER_TYPE = originalUserType;
    }
  });

  afterEach(() => {
    if (originalUserType === undefined) {
      delete process.env.USER_TYPE;
    } else {
      process.env.USER_TYPE = originalUserType;
    }
  });

  it('does not append skininthegamebros guidance by default', () => {
    const prompt = getOmcSystemPrompt();
    expect(prompt).not.toContain('Skininthegamebros Execution Guidance');
  });

  it('appends skininthegamebros guidance to the orchestrator prompt for USER_TYPE=ant', () => {
    process.env.USER_TYPE = 'ant';
    const prompt = getOmcSystemPrompt();
    expect(prompt).toContain('Skininthegamebros Execution Guidance');
    expect(prompt).toContain('Report outcomes faithfully');
  });

  it('appends skininthegamebros guidance to agent prompts for USER_TYPE=ant', () => {
    process.env.USER_TYPE = 'ant';
    const agents = getAgentDefinitions();
    expect(agents.architect.prompt).toContain('## Skininthegamebros Guidance');
    expect(agents.architect.prompt).toContain('Default to writing no comments');
  });

  it('appends skininthegamebros guidance when resolving agent-role prompts for USER_TYPE=ant', () => {
    process.env.USER_TYPE = 'ant';
    const prompt = resolveSystemPrompt(undefined, 'architect');
    expect(prompt).toContain('## Skininthegamebros Guidance');
    expect(prompt).toContain('verify the result with tests');
  });
});
