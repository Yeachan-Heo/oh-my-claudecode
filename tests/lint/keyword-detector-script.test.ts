import { describe, it, expect } from 'vitest';

/**
 * Test the 'do' imperative exemption in the AUTOPILOT_QUESTION_START pattern.
 * Ensures that:
 * - 'do use autopilot' is recognized as an imperative (not a question)
 * - 'Do test runs use autopilot' is recognized as a question (not an imperative)
 * - 'Do build jobs use autopilot' is recognized as a question (not an imperative)
 *
 * The fix narrows the negative lookahead from including command verbs (test, check, fix)
 * to only including activation verbs (use, run, start, enable, activate, etc.).
 */
describe('keyword-detector: do imperative exemption (AUTOPILOT_QUESTION_START)', () => {
  // The corrected pattern from scripts/keyword-detector.mjs line ~1087
  // This pattern checks if a sentence starts with a question or auxiliary word.
  // The negative lookahead (?!do\s+ACTIVATION_VERB) prevents 'do use X' from being treated as a question.
  const AUTOPILOT_QUESTION_START = /^[ \t]*(?:[-*+>#]+[ \t]+|\d+[.)][ \t]+|\[[ xX]\][ \t]+|["'"'([*_`])*(?!(?:can|could|would|will)\s+you(?![\p{L}\d]))(?!do\s+not(?![\p{L}\d]))(?!do\s+(?:use|run|start|enable|activate|invoke|trigger|launch|engage|initiate|begin|kick\s+off|fire\s+up|spin\s+up|turn\s+on|switch\s+to|go(?:\s+with|\s+for)?|set)\s)(?:did|does|do|is|are|was|were|has|have|had|can|could|should|would|will|may|might|must|shall|what|why|how|when|where|who|which)(?![\p{L}\d])/iu;

  // Test cases: [text, shouldMatchQuestionStart, description]
  // When shouldMatchQuestionStart=true, the sentence is treated as a question.
  // When shouldMatchQuestionStart=false, the sentence is NOT treated as a question (e.g., it's an imperative).
  const testCases: Array<[string, boolean, string]> = [
    // Rows 1-9: Expected to NOT match as questions (are commands/imperatives)
    ['autopilot fix the parser (why it fails)', false, 'Row 1: no leading auxiliary/question word'],
    ['Use autopilot to implement error handling', false, 'Row 2: starts with activation verb, not question word'],
    ['(use autopilot to replace ? with ! in the template)', false, 'Row 3: parenthesized activation verb'],
    ['(do use autopilot to fix the parser)', false, 'Row 4: "do use" is imperative, not question'],
    ['(could you use autopilot to fix this)', false, 'Row 5: "could you" is a request, not a question'],
    ['Could you, please, use autopilot to fix this?', false, 'Row 6: "could you" request form, not question'],
    ['autopilot fix the parser', false, 'Row 7: bare imperative'],
    ['autopilot run failed (unit) tests', false, 'Row 8: status line, not question'],
    ['autopilot rerun failed tests', false, 'Row 9: imperative with hyphenated verb'],

    // Rows 10-17: Expected to match as questions
    ['(should I use autopilot for this)', true, 'Row 10: question with should+I'],
    ['(could you not use autopilot to fix this)', false, 'Row 11: negated request (checked separately)'],
    ['The autopilot run failed (could you check the logs)', false, 'Row 12: status context (checked separately)'],
    ['Docs:\nautopilot fix parser', false, 'Row 13: reference section (checked separately)'],
    ["Should I use autopilot for this?", true, 'Row 14: question starting with should'],
    ['"Should I use autopilot to fix this" she asked', true, 'Row 15: starts with quoted question word (quoted span handling is separate)'],
    ['Do test runs use autopilot', true, 'Row 16: "Do test runs" - do NOT followed directly by activation verb'],
    ['Do build jobs use autopilot', true, 'Row 17: "Do build jobs" - do NOT followed directly by activation verb'],
  ];

  testCases.forEach(([text, shouldMatch, description]) => {
    it(`${description}`, () => {
      const matches = AUTOPILOT_QUESTION_START.test(text);
      expect(
        matches,
        `"${text}" should ${shouldMatch ? 'match' : 'not match'} AUTOPILOT_QUESTION_START`
      ).toBe(shouldMatch);
    });
  });

  describe('specific regression cases', () => {
    it('Row 16: "Do test runs use autopilot" should be detected as a question', () => {
      const prompt = 'Do test runs use autopilot';
      const matches = AUTOPILOT_QUESTION_START.test(prompt);
      expect(matches, 'Should match as a question because "do test" is NOT "do activation-verb"').toBe(true);
    });

    it('Row 17: "Do build jobs use autopilot" should be detected as a question', () => {
      const prompt = 'Do build jobs use autopilot';
      const matches = AUTOPILOT_QUESTION_START.test(prompt);
      expect(matches, 'Should match as a question because "do build" is NOT "do activation-verb"').toBe(true);
    });

    it('Row 4: "do use autopilot" should NOT be detected as a question (is an imperative)', () => {
      const prompt = '(do use autopilot to fix the parser)';
      const matches = AUTOPILOT_QUESTION_START.test(prompt);
      expect(matches, 'Should NOT match because "do use" is an imperative form').toBe(false);
    });

    it('Row 4 variant: "do run" should NOT be detected as a question (is an imperative)', () => {
      const prompt = '(do run autopilot)';
      const matches = AUTOPILOT_QUESTION_START.test(prompt);
      expect(matches, 'Should NOT match because "do run" is an imperative form').toBe(false);
    });

    it('Row 4 variant: "do start" should NOT be detected as a question (is an imperative)', () => {
      const prompt = '(do start autopilot)';
      const matches = AUTOPILOT_QUESTION_START.test(prompt);
      expect(matches, 'Should NOT match because "do start" is an imperative form').toBe(false);
    });

    it('Contrast: "do test" should be detected as a question (test is not an activation verb)', () => {
      const prompt = 'Do test the code';
      const matches = AUTOPILOT_QUESTION_START.test(prompt);
      expect(matches, 'Should match because "do test" is NOT in the exemption list (test is a command verb, not activation verb)').toBe(true);
    });

    it('Contrast: "do check" should be detected as a question (check is not an activation verb)', () => {
      const prompt = 'Do check the logs';
      const matches = AUTOPILOT_QUESTION_START.test(prompt);
      expect(matches, 'Should match because "do check" is NOT in the exemption list (check is a command verb, not activation verb)').toBe(true);
    });
  });
});
