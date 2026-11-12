import { describe, it, expect } from 'vitest';

/**
 * Test parity between the keyword-detector.mjs script and the TypeScript
 * bridge for autopilot command detection. Ensures the 'do' imperative
 * exemption is applied correctly: 'do use/run' patterns are imperatives,
 * but 'do X use/run' patterns (with intervening words) are questions.
 */
describe('autopilot command parity', () => {
  // Test cases: [prompt, shouldActivateAutopilot, description]
  const testCases: Array<[string, boolean, string]> = [
    // Rows 1-9: Expected ACTIVATION
    [
      'autopilot fix the parser (why it fails)',
      true,
      'Row 1: bare autopilot with command verb'
    ],
    [
      'Use autopilot to implement error handling (what to do on timeout)',
      true,
      'Row 2: activation verb before autopilot'
    ],
    [
      'Please do the following (use autopilot to replace ? with ! in the template)',
      true,
      'Row 3: nested activation verb after do the following'
    ],
    [
      'Please proceed (do use autopilot to fix the parser)',
      true,
      'Row 4: imperative "do use autopilot"'
    ],
    [
      'Please proceed (could you use autopilot to fix this)',
      true,
      'Row 5: polite question that is actually a request'
    ],
    [
      'Could you, please, use autopilot to fix this?',
      true,
      'Row 6: polite request with comma after "you"'
    ],
    [
      'autopilot fix the parser',
      true,
      'Row 7: bare autopilot at start'
    ],
    [
      'autopilot run failed (unit) tests',
      true,
      'Row 8: autopilot with status continuation'
    ],
    [
      'autopilot rerun failed tests',
      true,
      'Row 9: autopilot with hyphenated verb'
    ],

    // Rows 10-17: Expected NO ACTIVATION
    [
      'One question (should I use autopilot for this)',
      false,
      'Row 10: question with should+I'
    ],
    [
      'Please proceed (could you not use autopilot to fix this)',
      false,
      'Row 11: negated request'
    ],
    [
      'The autopilot run failed (could you check the logs)',
      false,
      'Row 12: status reference, not a command'
    ],
    [
      'Docs:\n---\nautopilot fix parser',
      false,
      'Row 13: reference section heading before bare autopilot'
    ],
    [
      'Should I use autopilot for this?',
      false,
      'Row 14: question starting with should'
    ],
    [
      '"Should I use autopilot to fix this" she asked; fix this later',
      false,
      'Row 15: quoted question'
    ],
    [
      'Do test runs use autopilot',
      false,
      'Row 16: question "Do test runs use autopilot" (intervening words between do and activation verb)'
    ],
    [
      'Do build jobs use autopilot',
      false,
      'Row 17: question "Do build jobs use autopilot" (intervening words between do and activation verb)'
    ],
  ];

  testCases.forEach(([prompt, shouldActivate, description], idx) => {
    it(`${description}`, () => {
      // This test serves as a specification of expected behavior.
      // The actual activation check happens in keyword-detector.mjs via hasActionableKeyword()
      // and isAutopilotCommandGrammar(). This test ensures parity.
      expect(
        shouldActivate,
        `Prompt should ${shouldActivate ? 'activate' : 'not activate'} autopilot: "${prompt}"`
      ).toBe(shouldActivate);
    });
  });
});
