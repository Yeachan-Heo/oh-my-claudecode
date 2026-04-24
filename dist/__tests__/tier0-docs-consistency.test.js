import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
function readProjectFile(...segments) {
    return readFileSync(join(PROJECT_ROOT, ...segments), 'utf-8');
}
describe('Tier-0 contract docs consistency', () => {
    const referenceDoc = readProjectFile('docs', 'REFERENCE.md');
    const claudeDoc = readProjectFile('docs', 'CLAUDE.md');
    it('keeps REFERENCE ToC counts aligned with section headings', () => {
        const tocAgents = referenceDoc.match(/\[Agents \((\d+) Total\)\]\(#agents-\d+-total\)/);
        const headingAgents = referenceDoc.match(/^## Agents \((\d+) Total\)$/m);
        const tocSkills = referenceDoc.match(/\[Skills \((\d+) Total\)\]\(#skills-\d+-total\)/);
        const headingSkills = referenceDoc.match(/^## Skills \((\d+) Total\)$/m);
        expect(tocAgents?.[1]).toBe(headingAgents?.[1]);
        expect(tocSkills?.[1]).toBe(headingSkills?.[1]);
    });
    it('documents all Tier-0 slash commands in REFERENCE.md', () => {
        for (const skillName of ['autopilot', 'ultrawork', 'ralph', 'team', 'ralplan']) {
            expect(referenceDoc).toContain(`/oh-my-claudecode:${skillName}`);
        }
    });
    it('documents all Tier-0 keywords in CLAUDE.md', () => {
        for (const keyword of ['autopilot', 'ultrawork', 'ralph', 'team', 'ralplan']) {
            expect(claudeDoc).toContain(`\`${keyword}\``);
        }
    });
    it('does not contain blank placeholder rows in core skill/command docs', () => {
        expect(referenceDoc).not.toContain('| `` |');
        expect(referenceDoc).not.toContain('/oh-my-claudecode: <task>');
        expect(referenceDoc).not.toContain('incl. )');
    });
    it('keeps ralplan documented as a keyword trigger', () => {
        expect(claudeDoc).toContain('"ralplan"→ralplan');
    });
    it('keeps deprecated compatibility aliases documented for project session manager', () => {
        // swarm alias removed in #1131
        expect(referenceDoc).toContain('project-session-manager');
        expect(referenceDoc).toContain('`psm` | **Deprecated** compatibility alias for `project-session-manager`');
    });
    it('does not document removed wrapper slash commands as installed skills', () => {
        expect(referenceDoc).not.toContain('/oh-my-claudecode:analyze <target>');
        expect(referenceDoc).not.toContain('/oh-my-claudecode:tdd <feature>');
    });
    it('documents team as explicit-only rather than an auto-triggered keyword', () => {
        expect(claudeDoc).toContain('Team orchestration is explicit via `/team`.');
        expect(referenceDoc).not.toContain('| `team`, `coordinated team`');
    });
    it('keeps install and update guidance aligned on canonical setup entrypoints', () => {
        const localPluginDoc = readProjectFile('docs', 'LOCAL_PLUGIN_INSTALL.md');
        expect(claudeDoc).toContain('Say "setup omc" or run `/oh-my-claudecode:omc-setup`.');
        expect(referenceDoc).toContain('/oh-my-claudecode:setup');
        expect(localPluginDoc).toContain('/setup');
        expect(localPluginDoc).toContain('git worktrees');
    });
    it('uses the published /docs/ path instead of the removed docs.html path in README links', () => {
        const readmes = [
            'README.md',
            'README.de.md',
            'README.es.md',
            'README.fr.md',
            'README.it.md',
            'README.ja.md',
            'README.ko.md',
            'README.pt.md',
            'README.ru.md',
            'README.tr.md',
            'README.vi.md',
            'README.zh.md',
        ].map((file) => readProjectFile(file));
        for (const content of readmes) {
            expect(content).not.toContain('https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html');
            expect(content).toContain('https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#');
        }
    });
    it('keeps root AGENTS.md aligned with OMC branding and state paths', () => {
        const agentsDoc = readProjectFile('AGENTS.md');
        expect(agentsDoc).toContain('# oh-my-claudecode - Intelligent Multi-Agent Orchestration');
        expect(agentsDoc).toContain('You are running with oh-my-claudecode (OMC), a multi-agent orchestration layer for Claude Code.');
        expect(agentsDoc).toContain('`.omc/state/`');
        expect(agentsDoc).toContain('Run `omc setup` to install all components. Run `omc doctor` to verify installation.');
        expect(agentsDoc).not.toContain('oh-my-codex');
        expect(agentsDoc).not.toContain('OMX_TEAM_WORKER_LAUNCH_ARGS');
        expect(agentsDoc).not.toContain('gpt-5.3-codex-spark');
    });
    it('keeps benchmark default model references aligned across docs and scripts', () => {
        const benchmarkReadme = readProjectFile('benchmark', 'README.md');
        const benchmarkRunner = readProjectFile('benchmark', 'run_benchmark.py');
        const quickTest = readProjectFile('benchmark', 'quick_test.sh');
        const vanilla = readProjectFile('benchmark', 'run_vanilla.sh');
        const omc = readProjectFile('benchmark', 'run_omc.sh');
        const fullComparison = readProjectFile('benchmark', 'run_full_comparison.sh');
        const resultsReadme = readProjectFile('benchmark', 'results', 'README.md');
        const expectedModel = 'claude-sonnet-4-6-20260217';
        for (const content of [benchmarkReadme, benchmarkRunner, quickTest, vanilla, omc, fullComparison, resultsReadme]) {
            expect(content).toContain(expectedModel);
        }
        expect(benchmarkReadme).not.toContain('claude-sonnet-4.5-20250929');
        expect(benchmarkRunner).not.toContain('claude-sonnet-4-20250514');
        expect(resultsReadme).toContain('Claude Sonnet 4.6');
    });
    it('removes dead package build aliases and keeps seminar demo model guidance current', () => {
        const packageJson = JSON.parse(readProjectFile('package.json'));
        const seminarDemo = readProjectFile('seminar', 'demos', 'demo-0-live-audience.md');
        expect(packageJson.scripts).not.toHaveProperty('build:codex');
        expect(packageJson.scripts).not.toHaveProperty('build:gemini');
        expect(seminarDemo).toContain('# 빠른 모델 (Sonnet 4.6)');
        expect(seminarDemo).toContain('export OMC_MODEL=anthropic/claude-sonnet-4-6');
        expect(seminarDemo).not.toContain('anthropic/claude-sonnet-4-5');
    });
});
//# sourceMappingURL=tier0-docs-consistency.test.js.map