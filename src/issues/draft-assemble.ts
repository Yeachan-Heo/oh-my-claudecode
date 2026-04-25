import {
  IssueDraft,
  computeContentHash,
} from './draft-writer.js';

export type CreateMode = 'bug' | 'feature' | 'chore' | 'docs' | 'refactor';

export interface CreateIssueFlags {
  mode?: CreateMode;
  labels?: string[];
  milestone?: string;
  noInterview?: boolean;
  repo?: string;
  area?: string;
}

export interface InterviewSlot {
  name: 'mode' | 'problem' | 'solution' | 'criteria' | 'scope';
  question: string;
  options?: string[];
  default: string;
  value?: string;
}

export const INTERVIEW_SLOTS: InterviewSlot[] = [
  {
    name: 'mode',
    question: 'What type of issue is this?',
    options: ['bug', 'feature', 'chore', 'docs', 'refactor'],
    default: 'feature',
  },
  {
    name: 'problem',
    question: 'What problem does this solve or what need does it address?',
    default: '_TBD_',
  },
  {
    name: 'solution',
    question: 'What should the solution look like?',
    default: '_TBD_',
  },
  {
    name: 'criteria',
    question: 'What are the testable acceptance criteria? (list 2+)',
    default: '_TBD_',
  },
  {
    name: 'scope',
    question: 'What is explicitly out of scope?',
    default: '_TBD_',
  },
];

const AREA_KEYWORDS: Record<string, string[]> = {
  ui: ['ui', 'interface', 'page', 'screen', 'view', 'modal', 'sidebar', 'navigation', 'layout'],
  bases: ['base', 'record', 'field', 'table', 'database'],
  docs: ['doc', 'documentation', 'readme', 'guide'],
  auth: ['auth', 'login', 'session', 'credential', 'token'],
  api: ['api', 'endpoint', 'route', 'handler'],
  infra: ['ci', 'cd', 'build', 'deploy', 'infra', 'pipeline'],
  testing: ['test', 'spec', 'fixture', 'mock'],
};

export function detectAreaSlug(idea: string, existingLabels: string[] = []): string {
  const lower = idea.toLowerCase();
  for (const [slug, keywords] of Object.entries(AREA_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      const prefix = `area:${slug}`;
      const sublabels = existingLabels
        .filter((l) => {
          const ll = l.toLowerCase();
          return ll === prefix || ll.startsWith(`${prefix}/`);
        })
        .map((l) => l.replace(/^area:/i, ''));
      if (sublabels.length > 0) {
        sublabels.sort((a, b) => b.length - a.length);
        return sublabels[0];
      }
      return slug;
    }
  }
  for (const label of existingLabels) {
    const m = /^area:(.+)$/.exec(label);
    if (!m) continue;
    if (lower.includes(m[1].toLowerCase().replace(/[/-]/g, ' '))) return m[1];
  }
  return 'general';
}

function summarizeIdea(idea: string, max = 60): string {
  const trimmed = idea.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).replace(/\s+\S*$/, '')}...`;
}

export function formatTitle(mode: string, areaSlug: string, summary: string): string {
  const prefix = `[${mode}:${areaSlug}]`;
  const concise = summarizeIdea(summary, 80 - prefix.length - 1);
  const candidate = `${prefix} ${concise}`;
  if (candidate.length <= 80) return candidate;
  const room = 80 - prefix.length - 1 - 3;
  return `${prefix} ${concise.slice(0, Math.max(0, room))}...`;
}

function getSlotValue(slots: InterviewSlot[], name: InterviewSlot['name']): string {
  const slot = slots.find((s) => s.name === name);
  if (!slot) return '_TBD_';
  return slot.value && slot.value.length > 0 ? slot.value : slot.default;
}

function renderCriteriaSection(raw: string): string {
  if (raw === '_TBD_') return '- [ ] _TBD_';
  const lines = raw
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return '- [ ] _TBD_';
  return lines
    .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
    .filter(Boolean)
    .map((l) => `- [ ] ${l}`)
    .join('\n');
}

function renderScopeSection(raw: string): string {
  if (raw === '_TBD_') return '- _TBD_';
  const lines = raw
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return '- _TBD_';
  return lines
    .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
    .filter(Boolean)
    .map((l) => `- ${l}`)
    .join('\n');
}

export function assembleDraft(
  idea: string,
  slots: InterviewSlot[],
  flags: CreateIssueFlags,
  existingLabels: string[] = [],
): IssueDraft {
  const modeSlot = getSlotValue(slots, 'mode');
  const mode: CreateMode = (['bug', 'feature', 'chore', 'docs', 'refactor'] as CreateMode[]).includes(
    modeSlot as CreateMode,
  )
    ? (modeSlot as CreateMode)
    : flags.mode ?? 'feature';
  const area = flags.area ?? detectAreaSlug(idea, existingLabels);
  const summarySource = idea && idea.trim().length > 0 ? idea : getSlotValue(slots, 'problem');
  const title = formatTitle(mode, area, summarySource);
  const problem = getSlotValue(slots, 'problem');
  const solution = getSlotValue(slots, 'solution');
  const criteria = getSlotValue(slots, 'criteria');
  const scope = getSlotValue(slots, 'scope');
  const labelSet = new Set<string>(['omc-ready']);
  labelSet.add(`area:${area || 'general'}`);
  for (const l of flags.labels ?? []) {
    if (l.trim()) labelSet.add(l.trim());
  }
  const labels = [...labelSet];
  const createdAt = new Date().toISOString();
  const body = [
    '## Problem',
    '',
    problem,
    '',
    '## Proposed Solution',
    '',
    solution,
    '',
    '## Acceptance Criteria',
    '',
    renderCriteriaSection(criteria),
    '',
    '## Out of Scope',
    '',
    renderScopeSection(scope),
    '',
    '## Source',
    '',
    `Created via \`/omc-create-issue\` on ${createdAt.slice(0, 10)}.`,
    '',
    '## OMC',
    '',
    `Label \`omc-ready\` applied: ${labels.includes('omc-ready') ? 'Yes' : 'No'}. If yes, this issue is ready for execution via \`/omc-issue <N>\`.`,
  ].join('\n');
  const hashInput = `${title}\n${body}`;
  const contentHash = computeContentHash(hashInput);
  return {
    title,
    body,
    labels,
    milestone: flags.milestone,
    mode,
    source: 'idea',
    contentHash,
    frontmatter: {
      title,
      labels,
      milestone: flags.milestone ?? '',
      mode,
      source: 'idea',
      created_via: 'omc-create-issue',
      created_at: createdAt,
      content_hash: contentHash,
    },
  };
}

export function recomputeHashFromDraftFile(content: string): {
  hashSentinel: string;
  recomputed: string;
} | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let lastSentinelIdx = -1;
  let sentinelHash = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^<!--\s+(omc-create-hash|omc-seed-hash):([a-f0-9]{64})\s+-->\s*$/.exec(lines[i]);
    if (m) {
      lastSentinelIdx = i;
      sentinelHash = m[2];
      break;
    }
  }
  if (lastSentinelIdx < 0) return null;
  const fmEnd = findFrontmatterEnd(lines);
  const titleLine = lines.slice(0, fmEnd).find((l) => /^title:/.test(l));
  const title = titleLine ? titleLine.replace(/^title:\s*/, '').replace(/^"|"$/g, '') : '';
  const bodyLines = lines.slice(fmEnd + 1, lastSentinelIdx);
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
  while (bodyLines.length > 0 && bodyLines[0].trim() === '') bodyLines.shift();
  const body = bodyLines.join('\n');
  const recomputed = computeContentHash(`${title}\n${body}`);
  return { hashSentinel: sentinelHash, recomputed };
}

function findFrontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return i;
  }
  return -1;
}
