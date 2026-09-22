import { describe, expect, it } from 'vitest';

import { serializeQuestions } from '../client.js';
import { parseJevConfig } from '../config.js';
import { JUDGMENT_POINTS } from '../points.js';
import type { JevQuestions } from '../types.js';

/**
 * Regression cover for #4091: with a valid key every judgment point degraded
 * because the request shape was rejected by the API — capitalized question
 * types (400), Score criteria sent as a map (422), and a default timeout below
 * the observed round-trip.
 */

function allQuestionSets(): Array<[string, JevQuestions]> {
  const out: Array<[string, JevQuestions]> = [];
  for (const [name, point] of Object.entries(JUDGMENT_POINTS)) {
    point.questions.forEach((set, index) => {
      out.push([`${name}#${index}`, typeof set === 'function' ? set() : set]);
    });
  }
  return out;
}

describe('judgment point wire shape (#4091)', () => {
  it('declares every question type in the lower-case form the API accepts', () => {
    const offenders: string[] = [];
    for (const [label, questions] of allQuestionSets()) {
      for (const [questionName, question] of Object.entries(questions)) {
        if (!['choice', 'score', 'noul'].includes(question.type)) {
          offenders.push(`${label}.${questionName}=${question.type}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('serializes every declared score question to an ordered criteria list', () => {
    let scoreQuestions = 0;
    for (const [, questions] of allQuestionSets()) {
      const wire = serializeQuestions(questions);
      for (const [questionName, question] of Object.entries(questions)) {
        if (question.type !== 'score') continue;
        scoreQuestions += 1;
        expect(wire[questionName]?.criteria).toEqual(Object.values(question.criteria));
      }
    }
    expect(scoreQuestions).toBeGreaterThan(0);
  });

  it('defaults the timeout above the observed single-question round-trip', () => {
    expect(parseJevConfig({}).timeoutMs).toBeGreaterThanOrEqual(1000);
    expect(parseJevConfig({ OMC_JEV_TIMEOUT_MS: '8000' }).timeoutMs).toBe(8000);
  });
});
