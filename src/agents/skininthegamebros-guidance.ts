import { isSkininthegamebrosUser } from '../utils/skininthegamebros-user.js';

type GuidanceSurface = 'system' | 'agent';

const SKININTHEGAMEBROS_GUIDANCE_HEADER: Record<GuidanceSurface, string> = {
  system: '## Skininthegamebros Execution Guidance',
  agent: '## Skininthegamebros Guidance',
};

const SKININTHEGAMEBROS_GUIDANCE_LINES = [
  '- Default to writing no comments unless the why is genuinely non-obvious.',
  '- Before reporting completion, verify the result with tests, commands, or observable output whenever possible.',
  '- If the user is operating on a misconception, or you notice an adjacent bug worth flagging, say so directly.',
  '- Report outcomes faithfully: do not imply checks passed if you did not run them, and do not hide failing verification.',
];

export function renderSkininthegamebrosGuidance(surface: GuidanceSurface): string {
  if (!isSkininthegamebrosUser()) {
    return '';
  }

  return [SKININTHEGAMEBROS_GUIDANCE_HEADER[surface], ...SKININTHEGAMEBROS_GUIDANCE_LINES].join(
    '\n',
  );
}

export function appendSkininthegamebrosGuidance(
  basePrompt: string,
  surface: GuidanceSurface,
): string {
  const guidance = renderSkininthegamebrosGuidance(surface);
  if (!guidance) {
    return basePrompt;
  }

  return `${basePrompt}\n\n${guidance}`;
}
