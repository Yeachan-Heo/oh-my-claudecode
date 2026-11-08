/**
 * Tests for issue #830: "Skill compact is not a prompt-based skill"
 *
 * When Claude Code triggers context compaction (/compact) or /clear,
 * the auto-slash-command hook must not attempt to load those as OMC skills.
 * Both commands belong to EXCLUDED_COMMANDS to prevent the error.
 */
export {};
//# sourceMappingURL=compact-denylist.test.d.ts.map