import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');

function readProjectFile(...segments: string[]): string {
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

  it('keeps ralplan documented as the /plan --consensus alias', () => {
    expect(claudeDoc).toContain('`ralplan` ("ralplan", "consensus plan"): alias for `/plan --consensus`');
  });

  it('keeps deprecated compatibility aliases documented for team and project session manager', () => {
    expect(referenceDoc).toContain('`swarm` | **Deprecated** compatibility facade over team orchestration');
    expect(referenceDoc).toContain('/oh-my-claudecode:swarm');
    expect(referenceDoc).toContain('project-session-manager');
    expect(referenceDoc).toContain('`psm` | **Deprecated** compatibility alias for `project-session-manager`');
  });
});
