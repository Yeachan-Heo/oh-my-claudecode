/**
 * Tests for issue #729: node -e inline scripts in SKILL.md files must not
 * contain '!' characters, which MINGW64/Git Bash (Windows) escapes to '\!'
 * causing SyntaxError in the generated JavaScript.
 *
 * Affected files: skills/omc-setup/SKILL.md, skills/hud/SKILL.md
 */
export {};
//# sourceMappingURL=mingw-escape.test.d.ts.map