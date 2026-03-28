import { describe, it, expect } from 'vitest';
import { parseSkillPipelineMetadata, renderSkillPipelineGuidance } from '../skill-pipeline.js';

describe('parseSkillPipelineMetadata', () => {
  it('returns undefined when no pipeline fields are present', () => {
    expect(parseSkillPipelineMetadata({})).toBeUndefined();
  });

  it('returns undefined for empty string values', () => {
    expect(parseSkillPipelineMetadata({ pipeline: '', 'next-skill': '' })).toBeUndefined();
  });

  it('parses a simple pipeline list', () => {
    const result = parseSkillPipelineMetadata({ pipeline: '[plan, implement, review]' });
    expect(result).toBeDefined();
    expect(result!.steps).toEqual(['plan', 'implement', 'review']);
  });

  it('deduplicates pipeline steps (case-insensitive)', () => {
    const result = parseSkillPipelineMetadata({ pipeline: '[plan, Plan, PLAN]' });
    expect(result!.steps).toEqual(['plan']);
  });

  it('parses next-skill field', () => {
    const result = parseSkillPipelineMetadata({ 'next-skill': 'review' });
    expect(result).toBeDefined();
    expect(result!.nextSkill).toBe('review');
  });

  it('normalizes oh-my-claudecode: prefix from next-skill', () => {
    const result = parseSkillPipelineMetadata({ 'next-skill': 'oh-my-claudecode:review' });
    expect(result!.nextSkill).toBe('review');
  });

  it('normalizes /oh-my-claudecode: prefix from next-skill', () => {
    const result = parseSkillPipelineMetadata({ 'next-skill': '/oh-my-claudecode:review' });
    expect(result!.nextSkill).toBe('review');
  });

  it('normalizes leading slash from next-skill', () => {
    const result = parseSkillPipelineMetadata({ 'next-skill': '/review' });
    expect(result!.nextSkill).toBe('review');
  });

  it('parses next-skill-args field', () => {
    const result = parseSkillPipelineMetadata({
      'next-skill': 'review',
      'next-skill-args': '--strict',
    });
    expect(result!.nextSkillArgs).toBe('--strict');
  });

  it('strips quotes from next-skill-args', () => {
    const result = parseSkillPipelineMetadata({
      'next-skill': 'review',
      'next-skill-args': '"--strict"',
    });
    expect(result!.nextSkillArgs).toBe('--strict');
  });

  it('parses handoff field', () => {
    const result = parseSkillPipelineMetadata({ handoff: '.omc/handoff.md' });
    expect(result).toBeDefined();
    expect(result!.handoff).toBe('.omc/handoff.md');
  });

  it('parses all fields together', () => {
    const result = parseSkillPipelineMetadata({
      pipeline: '[plan, implement]',
      'next-skill': 'review',
      'next-skill-args': '--verbose',
      handoff: '.omc/handoff.md',
    });
    expect(result).toEqual({
      steps: ['plan', 'implement'],
      nextSkill: 'review',
      nextSkillArgs: '--verbose',
      handoff: '.omc/handoff.md',
    });
  });
});

describe('renderSkillPipelineGuidance', () => {
  it('returns empty string when pipeline is undefined', () => {
    expect(renderSkillPipelineGuidance('test', undefined)).toBe('');
  });

  it('renders current stage info', () => {
    const pipeline = { steps: ['plan', 'implement'], nextSkill: undefined, handoff: undefined, nextSkillArgs: undefined };
    const result = renderSkillPipelineGuidance('plan', pipeline);
    expect(result).toContain('Current stage: `plan`');
    expect(result).toContain('## Skill Pipeline');
  });

  it('renders terminal stage message when no next-skill', () => {
    const pipeline = { steps: ['plan'], nextSkill: undefined, handoff: undefined, nextSkillArgs: undefined };
    const result = renderSkillPipelineGuidance('plan', pipeline);
    expect(result).toContain('terminal stage');
  });

  it('renders next skill invocation when next-skill is set', () => {
    const pipeline = { steps: ['plan'], nextSkill: 'review', handoff: undefined, nextSkillArgs: undefined };
    const result = renderSkillPipelineGuidance('plan', pipeline);
    expect(result).toContain('Next skill: `review`');
    expect(result).toContain('oh-my-claudecode:review');
    expect(result).toContain('When this stage completes');
  });

  it('renders handoff artifact instruction', () => {
    const pipeline = { steps: [], nextSkill: 'review', handoff: '.omc/handoff.md', nextSkillArgs: undefined };
    const result = renderSkillPipelineGuidance('plan', pipeline);
    expect(result).toContain('Handoff artifact: `.omc/handoff.md`');
    expect(result).toContain('Write or update the handoff artifact');
  });

  it('renders pipeline step sequence', () => {
    const pipeline = { steps: ['plan', 'implement'], nextSkill: 'review', handoff: undefined, nextSkillArgs: undefined };
    const result = renderSkillPipelineGuidance('plan', pipeline);
    // Should show steps connected with arrows
    expect(result).toContain('\u2192');
  });

  it('normalizes skill name prefix in current stage', () => {
    const pipeline = { steps: [], nextSkill: 'review', handoff: undefined, nextSkillArgs: undefined };
    const result = renderSkillPipelineGuidance('oh-my-claudecode:plan', pipeline);
    expect(result).toContain('Current stage: `plan`');
  });
});
