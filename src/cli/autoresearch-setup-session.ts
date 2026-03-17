import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  parseAutoresearchSetupHandoffJson,
  type AutoresearchSetupHandoff,
} from '../autoresearch/setup-contract.js';

const AUTORESEARCH_SETUP_ENTRYPOINT = 'autoresearch-setup';

export interface AutoresearchRepoSignalSummary {
  lines: string[];
}

export interface AutoresearchSetupSessionInput {
  repoRoot: string;
  missionText: string;
  explicitEvaluatorCommand?: string;
  clarificationAnswers?: string[];
  repoSignals?: AutoresearchRepoSignalSummary;
}

function safeReadFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function collectPackageJsonSignals(repoRoot: string): string[] {
  const packageJsonPath = join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    const scriptEntries = Object.entries(parsed.scripts ?? {})
      .slice(0, 8)
      .map(([name, command]) => `package.json script ${name}: ${command}`);
    return scriptEntries;
  } catch {
    return ['package.json present'];
  }
}

function collectFilePresenceSignals(repoRoot: string): string[] {
  const candidates = [
    'Makefile',
    'Justfile',
    'pytest.ini',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'package.json',
    'vitest.config.ts',
    'jest.config.js',
  ];
  return candidates
    .filter((candidate) => existsSync(join(repoRoot, candidate)))
    .map((candidate) => `repo file: ${candidate}`);
}

function collectMissionExampleSignals(repoRoot: string): string[] {
  const missionsRoot = join(repoRoot, 'missions');
  if (!existsSync(missionsRoot)) {
    return [];
  }

  const missionDirs = readdirSync(missionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .slice(0, 5)
    .map((entry) => entry.name);

  const signals: string[] = missionDirs.map((dir) => `existing mission example: missions/${dir}`);
  for (const dir of missionDirs) {
    const sandbox = safeReadFile(join(missionsRoot, dir, 'sandbox.md'));
    const commandMatch = sandbox?.match(/command:\s*(.+)/);
    if (commandMatch?.[1]) {
      signals.push(`existing mission evaluator: ${commandMatch[1].trim()}`);
    }
  }
  return signals;
}

export function collectAutoresearchRepoSignals(repoRoot: string): AutoresearchRepoSignalSummary {
  const lines = [
    ...collectPackageJsonSignals(repoRoot),
    ...collectFilePresenceSignals(repoRoot),
    ...collectMissionExampleSignals(repoRoot),
  ];

  return {
    lines: lines.length > 0 ? lines : ['No strong repo signals detected.'],
  };
}

export function buildAutoresearchSetupPrompt(input: AutoresearchSetupSessionInput): string {
  const repoSignals = input.repoSignals ?? collectAutoresearchRepoSignals(input.repoRoot);
  const clarificationLines = (input.clarificationAnswers ?? [])
    .map((answer, index) => `Clarification ${index + 1}: ${answer}`);

  return [
    'You are a short-lived Claude Code setup assistant for OMC autoresearch.',
    'Your job is to prepare a launch handoff for a detached autoresearch runtime.',
    'Stay domain-generic. Prefer repository evidence and explicit user input over assumptions.',
    'If the evaluator is explicit and valid, keep using it.',
    'If the evaluator is inferred with low confidence or conflicting evidence, DO NOT launch; ask one clarification question.',
    'Output JSON only with these fields:',
    '{',
    '  "missionText": string,',
    '  "evaluatorCommand": string,',
    '  "evaluatorSource": "user" | "inferred",',
    '  "confidence": number,',
    '  "keepPolicy": "score_improvement" | "pass_only" | null,',
    '  "slug": string,',
    '  "readyToLaunch": boolean,',
    '  "clarificationQuestion": string | null,',
    '  "repoSignals": string[]',
    '}',
    '',
    `Repo root: ${input.repoRoot}`,
    `Mission request: ${input.missionText}`,
    `Explicit evaluator: ${input.explicitEvaluatorCommand ?? '(none provided)'}`,
    '',
    'Repository signals:',
    ...repoSignals.lines.map((line) => `- ${line}`),
    '',
    clarificationLines.length > 0 ? 'Clarifications so far:' : 'Clarifications so far: none',
    ...clarificationLines.map((line) => `- ${line}`),
    '',
    'Rules:',
    '- Confidence must be between 0 and 1.',
    '- Low-confidence inferred evaluators must set readyToLaunch=false.',
    '- When readyToLaunch=false, clarificationQuestion must be a single concise question.',
    '- Prefer evaluators already implied by repo scripts/tests/build tooling.',
  ].join('\n');
}

export function runAutoresearchSetupSession(input: AutoresearchSetupSessionInput): AutoresearchSetupHandoff {
  const prompt = buildAutoresearchSetupPrompt(input);
  const result = spawnSync('claude', ['-p', prompt], {
    cwd: input.repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      CLAUDE_CODE_ENTRYPOINT: AUTORESEARCH_SETUP_ENTRYPOINT,
    },
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`claude_autoresearch_setup_failed:${result.status ?? 'unknown'}`);
  }

  return parseAutoresearchSetupHandoffJson(result.stdout || '');
}
