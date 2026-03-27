import { describe, expect, it } from 'vitest';
import { detectMagicKeywords } from '../features/magic-keywords.js';

describe('magic-keywords informational intent context', () => {
  it('does not trigger ultrawork for Korean 알려줘 intent', () => {
    expect(detectMagicKeywords('ultrawork 알려줘')).toEqual([]);
  });

  it('does not trigger ultrawork for Korean 에 대해 intent', () => {
    expect(detectMagicKeywords('ralph 에 대해 설명해줘')).toEqual([]);
  });

  it('does not trigger ultrawork for Korean comparison intent', () => {
    expect(detectMagicKeywords('ralph와 ultrawork 차이 비교 알려주세요')).toEqual([]);
  });

  it('does not trigger ultrawork for Japanese 教えて intent', () => {
    expect(detectMagicKeywords('ultrawork について教えて')).toEqual([]);
  });

  it('does not trigger ultrawork for Japanese 知りたい and 違い intent', () => {
    expect(detectMagicKeywords('ralph と ultrawork の違いを知りたい')).toEqual([]);
  });

  it('does not trigger ultrawork for Chinese 告诉 and 关于 intent', () => {
    expect(detectMagicKeywords('请告诉我关于 ralph 的介绍')).toEqual([]);
  });

  it('does not trigger ultrawork for Chinese 区别/了解 intent', () => {
    expect(detectMagicKeywords('我想了解 ralph 和 ultrawork 的区别')).toEqual([]);
  });

  it('does not trigger ultrawork for English can you explain intent', () => {
    expect(detectMagicKeywords('can you explain ultrawork')).toEqual([]);
  });

  it('does not trigger ultrawork for English what does X do intent', () => {
    expect(detectMagicKeywords('what does ralph do')).toEqual([]);
  });

  it('does not trigger ultrawork for English difference between intent', () => {
    expect(detectMagicKeywords('difference between ralph and ultrawork')).toEqual([]);
  });

  it('does not trigger ultrawork for English help me understand intent', () => {
    expect(detectMagicKeywords('help me understand ultrawork')).toEqual([]);
  });

  it('still triggers ultrawork for actionable command', () => {
    expect(detectMagicKeywords('ultrawork fix failing tests now')).toEqual(['ultrawork']);
  });
});
