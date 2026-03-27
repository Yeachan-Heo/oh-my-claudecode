/**
 * @file tone-validator.test.ts — 비전문가 톤 검증 (성분명/의학용어 감지)
 *
 * 규칙: 성분명/의학용어가 포함된 콘텐츠는 출력 거부.
 * 비전문가 표현(예: "피부가 촉촉해요", "맑아져요")은 통과.
 */

import { describe, it, expect } from 'vitest';
import { validateTone } from '../safety/tone-validator.js';

describe('validateTone', () => {
  // ─── 통과 케이스 ─────────────────────────────────────────

  it('일반 비전문가 표현 — 통과', () => {
    const result = validateTone('이 크림 바르고 나서 피부가 진짜 촉촉해졌어요 ㅋㅋ');
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('실생활 공감형 콘텐츠 — 통과', () => {
    const result = validateTone('요즘 날씨 건조해서 립밤 없으면 못 살겠음... 이거 진짜 좋더라고요');
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('빈 문자열 — 통과', () => {
    const result = validateTone('');
    expect(result.passed).toBe(true);
  });

  it('영어 일반 단어 — 통과', () => {
    const result = validateTone('This sunscreen is so good and lightweight!');
    expect(result.passed).toBe(true);
  });

  // ─── 성분명 차단 케이스 ──────────────────────────────────

  it('나이아신아마이드 포함 — 차단', () => {
    const result = validateTone('이 세럼에 나이아신아마이드 10% 들어있어서 미백에 좋대요');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('나이아신아마이드');
  });

  it('레티놀 포함 — 차단', () => {
    const result = validateTone('레티놀 크림 처음 써봤는데 피부 당기더라고요');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('레티놀');
  });

  it('히알루론산 포함 — 차단', () => {
    const result = validateTone('히알루론산이 수분을 잡아줘서 좋아요');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('히알루론산');
  });

  it('세라마이드 포함 — 차단', () => {
    const result = validateTone('세라마이드 성분으로 피부장벽 강화된다고 해서 샀어요');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('세라마이드');
  });

  it('아데노신 포함 — 차단', () => {
    const result = validateTone('아데노신이 주름 개선에 효과적이라고 하던데');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('아데노신');
  });

  it('펩타이드 포함 — 차단', () => {
    const result = validateTone('펩타이드 성분이 콜라겐 합성을 도와준대요');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('펩타이드');
  });

  it('글루타치온 포함 — 차단', () => {
    const result = validateTone('글루타치온 먹으면 피부 밝아진다고 해서 주문했어요');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('글루타치온');
  });

  it('알부틴 포함 — 차단', () => {
    const result = validateTone('알부틴 성분이 멜라닌 억제한다던데');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('알부틴');
  });

  it('살리실산 포함 — 차단', () => {
    const result = validateTone('살리실산 들어간 클렌저로 모공 관리해요');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('살리실산');
  });

  it('마데카소사이드 포함 — 차단', () => {
    const result = validateTone('마데카소사이드 함량이 높아서 진정 효과 있어요');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('마데카소사이드');
  });

  // ─── 영문 성분명 차단 케이스 ─────────────────────────────

  it('retinol (영문) — 차단', () => {
    const result = validateTone('I use retinol every night for anti-aging');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('retinol');
  });

  it('niacinamide (영문) — 차단', () => {
    const result = validateTone('Niacinamide serum helped with my dark spots');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('niacinamide');
  });

  it('hyaluronic acid (영문) — 차단', () => {
    const result = validateTone('hyaluronic acid is great for hydration');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('hyaluronic acid');
  });

  it('ceramide (영문) — 차단', () => {
    const result = validateTone('ceramide helps strengthen the skin barrier');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('ceramide');
  });

  it('salicylic acid (영문) — 차단', () => {
    const result = validateTone('salicylic acid clears up acne fast');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('salicylic acid');
  });

  // ─── 의학용어 차단 케이스 ────────────────────────────────

  it('색소침착 — 차단', () => {
    const result = validateTone('색소침착 완화에 효과적이에요');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('색소침착');
  });

  it('각질세포 — 차단', () => {
    const result = validateTone('각질세포 재생을 촉진해준대요');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('각질세포');
  });

  it('멜라닌 — 차단', () => {
    const result = validateTone('멜라닌 생성을 억제해서 미백 효과');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('멜라닌');
  });

  it('항산화 — 차단', () => {
    const result = validateTone('항산화 효과로 피부 노화를 방지해요');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('항산화');
  });

  it('피부장벽 — 차단', () => {
    const result = validateTone('피부장벽 강화에 도움이 된대요');
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('피부장벽');
  });

  // ─── 복수 위반 케이스 ────────────────────────────────────

  it('다중 성분명 — 모두 violations에 포함', () => {
    const result = validateTone(
      '나이아신아마이드랑 히알루론산이 같이 들어있어서 좋아요. 레티놀도 있어요.'
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('나이아신아마이드');
    expect(result.violations).toContain('히알루론산');
    expect(result.violations).toContain('레티놀');
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('violations 중복 없음', () => {
    const result = validateTone('나이아신아마이드 10% + 나이아신아마이드 성분');
    expect(result.passed).toBe(false);
    const count = result.violations.filter(v => v === '나이아신아마이드').length;
    expect(count).toBe(1);
  });

  // ─── 리턴 타입 검증 ──────────────────────────────────────

  it('통과 시 reason 없음', () => {
    const result = validateTone('피부 진짜 좋아졌어요~');
    expect(result.reason).toBeUndefined();
  });

  it('차단 시 reason 문자열 포함', () => {
    const result = validateTone('레티놀이 들어있어요');
    expect(typeof result.reason).toBe('string');
    expect(result.reason!.length).toBeGreaterThan(0);
  });
});
