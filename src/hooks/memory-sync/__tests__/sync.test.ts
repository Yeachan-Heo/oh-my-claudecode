import { describe, it, expect } from 'vitest';
import { extractProjectName } from '../sync.js';

describe('extractProjectName', () => {
  it('extracts name from standard workspace path', () => {
    expect(extractProjectName('-Users-bob-workspace-speakeasy')).toBe('speakeasy');
  });

  it('extracts hyphenated project names', () => {
    expect(extractProjectName('-Users-bob-workspace-ai-job-matcher')).toBe('ai-job-matcher');
  });

  it('extracts deeply nested workspace paths', () => {
    expect(extractProjectName('-Users-bob-workspace-rag-customer-service')).toBe('rag-customer-service');
  });

  it('handles non-workspace paths under home', () => {
    expect(extractProjectName('-Users-bob-auto-video')).toBe('auto-video');
  });

  it('handles iCloud/Documents paths', () => {
    expect(extractProjectName('-Users-bob-Library-Mobile-Documents-iCloud-md-obsidian-Documents-daily'))
      .toBe('obsidian-daily');
  });

  it('handles root user path', () => {
    expect(extractProjectName('-Users-bob')).toBe('global-user');
  });

  it('handles worktree paths', () => {
    expect(extractProjectName('-Users-bob-workspace--worktrees-rag-paddleocr'))
      .toBe('-worktrees-rag-paddleocr');
  });
});
