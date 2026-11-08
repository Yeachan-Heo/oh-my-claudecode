import { describe, it, expect } from 'vitest';
import { inferPhase, type PhaseableTask } from '../phase-controller.js';

function task(status: string, metadata?: PhaseableTask['metadata']): PhaseableTask {
  return { status, metadata };
}

describe('inferPhase', () => {
  it('empty task list → initializing', () => {
    expect(inferPhase([])).toBe('initializing');
  });

  it('all pending → planning', () => {
    expect(inferPhase([task('pending'), task('pending')])).toBe('planning');
  });

  it('any in_progress → executing', () => {
    expect(inferPhase([task('in_progress'), task('pending')])).toBe('executing');
  });

  it('mixed completed + pending (no in_progress) → executing', () => {
    expect(inferPhase([task('completed'), task('pending')])).toBe('executing');
  });

  it('permanentlyFailed tasks counted as failed not completed', () => {
    const tasks = [
      task('completed', { permanentlyFailed: true }),
      task('completed', { permanentlyFailed: true }),
    ];
    // All are permanentlyFailed with default maxRetries=3, retryCount=0 → has retries → fixing
    expect(inferPhase(tasks)).toBe('fixing');
  });

  it('all genuinely completed → completed', () => {
    expect(inferPhase([task('completed'), task('completed')])).toBe('completed');
  });

  it('failed with retries remaining → fixing', () => {
    expect(inferPhase([
      task('completed'),
      task('failed', { retryCount: 0, maxRetries: 3 }),
    ])).toBe('fixing');
  });

  it('all failed with retries exhausted → failed', () => {
    expect(inferPhase([
      task('failed', { retryCount: 3, maxRetries: 3 }),
    ])).toBe('failed');
  });

  it('single in_progress → executing', () => {
    expect(inferPhase([task('in_progress')])).toBe('executing');
  });
});
