import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getAgentDefinitions } from '../agents/definitions.js';

const advisoryAgents = [
  'architect',
  'critic',
  'code-reviewer',
  'security-reviewer',
  'verifier',
  'analyst',
  'tracer',
  'debugger',
] as const;

const forbiddenSignoffPattern = /(?:done|complete|nothing further|looks good|no further comments)/i;

const requiredMarkers: Record<(typeof advisoryAgents)[number], string[]> = {
  architect: ['<Final_Response_Contract>', '## Summary', '## Analysis', '## Recommendations', '## References'],
  critic: ['<Final_Response_Contract>', '**VERDICT:', '**Critical Findings**', '**Major Findings**', '**Verdict Justification**'],
  'code-reviewer': ['<Final_Response_Contract>', '## Code Review Summary', '### Issues', '### Recommendation'],
  'security-reviewer': ['<Final_Response_Contract>', '# Security Review Report', '**Risk Level:**', '## Security Checklist'],
  verifier: ['<Final_Response_Contract>', '## Verification Report', '### Verdict', '### Evidence', '### Recommendation'],
  analyst: ['<Final_Response_Contract>', '## Analyst Review', '### Scope Risks', '### Recommendations'],
  tracer: ['<Final_Response_Contract>', '## Trace Report', '### Hypothesis Table', '### Discriminating Probe'],
  debugger: ['<Final_Response_Contract>', '## Bug Report', '## References', '## Build Error Resolution'],
};

function agentPrompt(name: string): string {
  return readFileSync(join(process.cwd(), 'agents', `${name}.md`), 'utf-8');
}

describe('advisory agent final output contract', () => {
  test.each(advisoryAgents)('%s prompt requires substantive final response', (agentName) => {
    const prompt = agentPrompt(agentName);

    for (const marker of requiredMarkers[agentName]) {
      expect(prompt, `${agentName} prompt should include ${marker}`).toContain(marker);
    }

    expect(prompt, `${agentName} must explain final message is the Task deliverable`).toMatch(
      /LAST assistant message is the deliverable surfaced to callers/i,
    );
    expect(prompt, `${agentName} must forbid content-free sign-offs`).toMatch(forbiddenSignoffPattern);
    expect(prompt, `${agentName} must require repeating earlier findings in final response`).toMatch(
      /repeat the final verdict\/findings structure in the LAST message/i,
    );
  });

  test.each(advisoryAgents)('%s registry prompt includes final response contract', (agentName) => {
    const agents = getAgentDefinitions();
    const prompt = agents[agentName]?.prompt ?? '';

    expect(prompt).toContain('<Final_Response_Contract>');
    expect(prompt).toMatch(/LAST assistant message is the deliverable surfaced to callers/i);
    expect(prompt).toMatch(forbiddenSignoffPattern);
  });
});
