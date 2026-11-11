/**
 * lookout feature tests: rule engine over briefing text and workspace
 * state on real temporary git repositories.
 *
 * The false-positive expectations are as important as the detection ones:
 * lookout died once before as `risk-assess` (#3164) because routine work
 * tripped the gate. Rules must fire on the dangerous operation itself and
 * stay silent on adjacent but harmless wording.
 */
export {};
//# sourceMappingURL=lookout.test.d.ts.map