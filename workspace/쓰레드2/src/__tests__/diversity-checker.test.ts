import { describe, it, expect } from 'vitest';
import { checkFormatDiversity, checkCategoryDiversity, checkHookDiversity, getDiversityReport } from '../learning/diversity-checker.js';

describe('diversity-checker', () => {
  it('warns when same format > 60%', () => {
    const posts = Array(7).fill({ content_style: 'warmup' }).concat(
      Array(3).fill({ content_style: 'comparison' })
    );
    const result = checkFormatDiversity(posts);
    expect(result.warning).toBeTruthy();
    expect(result.dominant).toBe('warmup');
  });

  it('no warning when formats are diverse', () => {
    const posts = [
      { content_style: 'warmup' }, { content_style: 'warmup' },
      { content_style: 'comparison' }, { content_style: 'comparison' },
      { content_style: 'list' }, { content_style: 'list' },
      { content_style: 'review' }, { content_style: 'review' },
      { content_style: 'question' }, { content_style: 'question' },
    ];
    const result = checkFormatDiversity(posts);
    expect(result.warning).toBeNull();
  });

  it('warns when same category > 50%', () => {
    const posts = Array(6).fill({ need_category: '뷰티' }).concat(
      Array(4).fill({ need_category: '건강' })
    );
    const result = checkCategoryDiversity(posts);
    expect(result.warning).toBeTruthy();
    expect(result.dominant).toBe('뷰티');
  });

  it('no warning when categories are diverse', () => {
    const posts = [
      ...Array(3).fill({ need_category: '뷰티' }),
      ...Array(3).fill({ need_category: '건강' }),
      ...Array(2).fill({ need_category: '생활' }),
      ...Array(2).fill({ need_category: '다이어트' }),
    ];
    const result = checkCategoryDiversity(posts);
    expect(result.warning).toBeNull();
  });

  it('warns when same hook 3+ times', () => {
    const posts = [
      { hook_type: 'empathy' }, { hook_type: 'empathy' }, { hook_type: 'empathy' },
      { hook_type: 'question' }, { hook_type: 'reversal' },
    ];
    const result = checkHookDiversity(posts);
    expect(result.warning).toBeTruthy();
    expect(result.repeated).toBe('empathy');
  });

  it('getDiversityReport combines all checks', () => {
    const posts = Array(10).fill({
      content_style: 'warmup', need_category: '뷰티', hook_type: 'empathy'
    });
    const report = getDiversityReport(posts);
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});
