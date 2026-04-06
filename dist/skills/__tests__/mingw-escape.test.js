/**
 * Tests for issue #729: node -e inline scripts in SKILL.md files must not
 * contain '!' characters, which MINGW64/Git Bash (Windows) escapes to '\!'
 * causing SyntaxError in the generated JavaScript.
 *
 * Affected files: skills/omc-setup/SKILL.md, skills/hud/SKILL.md
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
const REPO_ROOT = join(__dirname, '..', '..', '..');
/**
 * Extract all node -e inline script bodies from a markdown file.
 * Handles both single-line and multi-line node -e "..." forms.
 */
function extractNodeEScripts(content) {
    const scripts = [];
    // Single-line: node -e "..."
    const singleLine = /^node -e "(.+)"$/gm;
    let m;
    while ((m = singleLine.exec(content)) !== null) {
        scripts.push(m[1]);
    }
    // Multi-line: node -e "\n...\n"
    const multiLine = /^node -e "\n([\s\S]*?)\n"$/gm;
    while ((m = multiLine.exec(content)) !== null) {
        scripts.push(m[1]);
    }
    return scripts;
}
/**
 * Return violation descriptions for any '!' found in a script body.
 */
function findBangViolations(scripts, fileName) {
    const violations = [];
    for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];
        const lines = script.split('\n');
        for (let li = 0; li < lines.length; li++) {
            const line = lines[li];
            for (let ci = 0; ci < line.length; ci++) {
                if (line[ci] === '!') {
                    violations.push(`${fileName} script #${i + 1}, line ${li + 1}:${ci + 1} — "${line.trim().slice(0, 80)}"`);
                }
            }
        }
    }
    return violations;
}
describe('MINGW64 escape safety: no "!" in node -e inline scripts (issue #729)', () => {
    describe('skills/hud/SKILL.md', () => {
        const filePath = join(REPO_ROOT, 'skills', 'hud', 'SKILL.md');
        const content = readFileSync(filePath, 'utf-8');
        const scripts = extractNodeEScripts(content);
        it('has at least one node -e script', () => {
            expect(scripts.length).toBeGreaterThan(0);
        });
        it('has no "!" in any node -e script body (MINGW64 safe)', () => {
            const violations = findBangViolations(scripts, 'hud/SKILL.md');
            if (violations.length > 0) {
                expect.fail('Found "!" in node -e scripts (breaks MINGW64/Git Bash):\n' +
                    violations.map(v => `  • ${v}`).join('\n'));
            }
            expect(violations.length).toBe(0);
        });
    });
    describe('skills/omc-setup (SKILL.md + phases)', () => {
        const setupDir = join(REPO_ROOT, 'skills', 'omc-setup');
        const filesToScan = [
            join(setupDir, 'SKILL.md'),
            ...readdirSync(join(setupDir, 'phases')).map(f => join(setupDir, 'phases', f)),
        ].filter(f => f.endsWith('.md'));
        const allScripts = [];
        const allContent = [];
        for (const f of filesToScan) {
            const c = readFileSync(f, 'utf-8');
            allContent.push(c);
            allScripts.push(...extractNodeEScripts(c));
        }
        it('has at least one node -e script across setup files', () => {
            expect(allScripts.length).toBeGreaterThan(0);
        });
        it('has no "!" in any node -e script body (MINGW64 safe)', () => {
            const violations = findBangViolations(allScripts, 'omc-setup/*');
            if (violations.length > 0) {
                expect.fail('Found "!" in node -e scripts (breaks MINGW64/Git Bash):\n' +
                    violations.map(v => `  • ${v}`).join('\n'));
            }
            expect(violations.length).toBe(0);
        });
    });
    describe('specific regressions (issue #729)', () => {
        it('hud SKILL.md plugin-verify script uses v.length===0 not !v.length', () => {
            const content = readFileSync(join(REPO_ROOT, 'skills', 'hud', 'SKILL.md'), 'utf-8');
            expect(content).toContain('v.length===0');
            expect(content).not.toContain('!v.length');
        });
        it('hud SKILL.md chmod script uses platform==="win32" not !=="win32"', () => {
            const content = readFileSync(join(REPO_ROOT, 'skills', 'hud', 'SKILL.md'), 'utf-8');
            const chmodLine = content
                .split('\n')
                .find(l => l.includes('chmodSync') && l.startsWith('node -e'));
            expect(chmodLine).toBeDefined();
            expect(chmodLine).not.toContain("!=='win32'");
            expect(chmodLine).toContain("==='win32'");
        });
        it('hud SKILL.md keeps Unix statusLine guidance portable while preserving Windows-safe paths', () => {
            const content = readFileSync(join(REPO_ROOT, 'skills', 'hud', 'SKILL.md'), 'utf-8');
            expect(content).toContain('"command": "node ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hud/omc-hud.mjs"');
            expect(content).toContain('"command": "node C:/Users/username/.claude/hud/omc-hud.mjs"');
            expect(content).not.toContain('"command": "node /home/username/.claude/hud/omc-hud.mjs"');
            expect(content).not.toContain('The command must use an absolute path, not `~`');
        });
        it("omc-setup version-detect script uses v==='' not !v", () => {
            const setupDir = join(REPO_ROOT, 'skills', 'omc-setup');
            const files = [
                join(setupDir, 'SKILL.md'),
                ...readdirSync(join(setupDir, 'phases')).map(f => join(setupDir, 'phases', f)),
            ].filter(f => f.endsWith('.md'));
            const combined = files.map(f => readFileSync(f, 'utf-8')).join('\n');
            expect(combined).toContain("if(v==='')");
            expect(combined).not.toContain('if(!v)');
        });
        it('omc-setup extracts CLAUDE.md version from OMC marker', () => {
            const setupDir = join(REPO_ROOT, 'skills', 'omc-setup');
            const files = [
                join(setupDir, 'SKILL.md'),
                ...readdirSync(join(setupDir, 'phases')).map(f => join(setupDir, 'phases', f)),
                join(REPO_ROOT, 'scripts', 'setup-claude-md.sh'),
            ].filter(f => f.endsWith('.md') || f.endsWith('.sh'));
            const combined = files.map(f => readFileSync(f, 'utf-8')).join('\n');
            expect(combined).toContain("grep -m1 'OMC:VERSION:'");
            expect(combined).not.toContain('grep -m1 "^# oh-my-claudecode"');
        });
        it('omc-setup SKILL.md explicitly tells the agent to execute immediately', () => {
            const content = readFileSync(join(REPO_ROOT, 'skills', 'omc-setup', 'SKILL.md'), 'utf-8');
            expect(content).toContain('immediately execute the workflow below');
            expect(content).toContain('Do not only restate or summarize');
        });
        it('omc-setup phase 2 delegates HUD setup instead of inlining statusLine formatting', () => {
            const content = readFileSync(join(REPO_ROOT, 'skills', 'omc-setup', 'phases', '02-configure.md'), 'utf-8');
            expect(content).toContain('Use the Skill tool to invoke: `hud` with args: `setup`');
            expect(content).toContain('Configure `statusLine` in `~/.claude/settings.json`');
            expect(content).not.toContain('Read `~/.claude/settings.json`, then update/add the `statusLine` field.');
            expect(content).not.toContain('"statusLine": {');
            expect(content).not.toContain('C:\\Users');
        });
    });
});
//# sourceMappingURL=mingw-escape.test.js.map