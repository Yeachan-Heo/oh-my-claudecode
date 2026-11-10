/**
 * jevNoulOf(): the active Noul answer of a recordJevShadow() result as a
 * probability of "yes", or undefined whenever the caller must keep its heuristic.
 */
import { describe, expect, it } from 'vitest';
import { jevNoulOf } from '../../scripts/lib/jev-shadow.mjs';

const active = (extra) => ({ mode: 'active', ...extra });

describe('jevNoulOf', () => {
  it('reads the single answer of a one-question point', () => {
    expect(jevNoulOf(active({ answer: { type: 'noul', noul: 0.8 } }), 'slop_advisory')).toBe(0.8);
    expect(jevNoulOf(active({ answer: { type: 'noul', noul: 0 } }), 'slop_advisory')).toBe(0);
    expect(jevNoulOf(active({ answer: { type: 'noul', noul: 1 } }), 'slop_advisory')).toBe(1);
  });

  it('reads the answer by question name when the result carries an answers map', () => {
    const result = active({
      answer: { type: 'noul', noul: 0.1 },
      answers: { other: { type: 'noul', noul: 0.1 }, wanted: { type: 'noul', noul: 0.9 } },
    });
    expect(jevNoulOf(result, 'wanted')).toBe(0.9);
  });

  it('never reads the answer of another question when the answers map lacks the name', () => {
    const result = active({
      answer: { type: 'noul', noul: 0.1 },
      answers: { other: { type: 'noul', noul: 0.1 } },
    });
    expect(jevNoulOf(result, 'missing')).toBeUndefined();
    expect(jevNoulOf(active({ answer: { type: 'noul', noul: 0.7 }, answers: {} }), 'q')).toBeUndefined();
  });

  it('reads the single answer when there is no answers map', () => {
    expect(jevNoulOf(active({ answer: { type: 'noul', noul: 0.4 }, answers: null }), 'q')).toBe(0.4);
  });

  it('maps a boolean answer to 1 or 0', () => {
    expect(jevNoulOf(active({ answer: { type: 'noul', noul: true } }), 'q')).toBe(1);
    expect(jevNoulOf(active({ answer: { type: 'noul', noul: false } }), 'q')).toBe(0);
  });

  it.each([
    ['no result', undefined],
    ['a shadow result', { mode: 'shadow', answer: { noul: 0.9 } }],
    ['a degraded result', { mode: 'degraded', answer: null, answers: null }],
    ['an active result without an answer', active({})],
    ['an answer without noul', active({ answer: { type: 'choice', choice: 'opus' } })],
    ['a string noul', active({ answer: { type: 'noul', noul: '0.9' } })],
    ['a non-finite noul', active({ answer: { type: 'noul', noul: Number.NaN } })],
    ['an infinite noul', active({ answer: { type: 'noul', noul: Number.POSITIVE_INFINITY } })],
    ['a negative noul', active({ answer: { type: 'noul', noul: -1 } })],
    ['a noul just below 0', active({ answer: { type: 'noul', noul: -0.01 } })],
    ['a noul above 1', active({ answer: { type: 'noul', noul: 2 } })],
    ['a noul just above 1', active({ answer: { type: 'noul', noul: 1.01 } })],
    ['a non-noul answer that carries a noul field', active({ answer: { type: 'choice', choice: 'a', noul: 0.9 } })],
    ['a noul answer without a type', active({ answer: { noul: 0.9 } })],
    ['an answers-map entry of another type', active({ answers: { q: { type: 'score', score: 2, noul: 0.9 } } })],
  ])('returns undefined for %s', (_label, result) => {
    expect(jevNoulOf(result, 'q')).toBeUndefined();
  });
});
