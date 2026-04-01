import { isCliAvailable, type CliAgentType } from '../../team/model-contract.js';

export interface SkillRuntimeAvailability {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  qwen: boolean;
}

export function detectSkillRuntimeAvailability(
  detector: (agentType: CliAgentType) => boolean = isCliAvailable,
): SkillRuntimeAvailability {
  return {
    claude: detector('claude'),
    codex: detector('codex'),
    gemini: detector('gemini'),
    qwen: detector('qwen'),
  };
}

function normalizeSkillName(skillName: string): string {
  return skillName.trim().toLowerCase();
}

function renderDeepInterviewRuntimeGuidance(availability: SkillRuntimeAvailability): string {
  if (!availability.codex && !availability.gemini) {
    return '';
  }

  const sections: string[] = [
    '## Provider-Aware Execution Recommendations',
    'When Phase 5 presents post-interview execution choices, keep the Claude-only defaults above and add these multi-provider variants:',
  ];

  if (availability.codex) {
    sections.push(
      '',
      '### Codex Variants',
      '- `/ralplan --architect codex "<spec or task>"` — Codex handles the architect pass; best for implementation-heavy design review; higher cost than Claude-only ralplan.',
      '- `/ralplan --critic codex "<spec or task>"` — Codex handles the critic pass; cheaper than moving the full loop off Claude; strong second-opinion review.',
      '- `/ralph --critic codex "<spec or task>"` — Ralph still executes normally, but final verification goes through the Codex critic; smallest multi-provider upgrade.',
    );
  }

  if (availability.gemini) {
    sections.push(
      '',
      '### Gemini Variants',
      '- `/ralplan --architect gemini "<spec or task>"` — Gemini handles the architect pass; strong for broad design exploration with large context windows.',
      '- `/ralplan --critic gemini "<spec or task>"` — Gemini handles the critic pass; useful for a different-model perspective on correctness and coverage.',
      '- `/ralph --critic gemini "<spec or task>"` — Ralph executes normally, Gemini provides the final verification critic pass.',
    );
  }

  sections.push(
    '',
    'If an external provider becomes unavailable, briefly note that and fall back to the Claude-only recommendations already listed in Phase 5.',
  );

  return sections.join('\n');
}

export function renderSkillRuntimeGuidance(
  skillName: string,
  availability?: SkillRuntimeAvailability,
): string {
  switch (normalizeSkillName(skillName)) {
    case 'deep-interview':
      return renderDeepInterviewRuntimeGuidance(availability ?? detectSkillRuntimeAvailability());
    default:
      return '';
  }
}
