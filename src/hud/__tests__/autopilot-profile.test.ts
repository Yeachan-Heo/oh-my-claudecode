import { createHash } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { readAutopilotStateForHud } from '../omc-state.js';
import { renderAutopilot } from '../elements/autopilot.js';
import { redactAutopilotPublicState } from '../../tools/state-tools.js';
import { formatAutopilotRuntimeInsight } from '../../hooks/autopilot/runtime-insight.js';
import { writeHudState } from '../state.js';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const workflowName = 'release-train';
const stages = ['ralplan', 'execution', 'ralph', 'qa'];
const profileHash = createHash('sha256').update(canonicalJson({
  descriptorVersion: 1,
  workflowName,
  profileVersion: 1,
  stages,
})).digest('hex');

function workflowState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const transcriptRoot = '/tmp/omc-autopilot-profile-transcripts';
  const initialIdentity = {
    device: 0,
    inode: 0,
    size: 0,
    mtimeNs: '0',
    ctimeNs: '0',
    contentSha256: '0'.repeat(64),
  };
  const stableIdentity = { ...initialIdentity, size: 1, contentSha256: '1'.repeat(64) };
  const activationBoundary = {
    transcriptPath: `${transcriptRoot}/${sessionId}.jsonl`,
    transcriptRoot,
    transcriptBasename: `${sessionId}.jsonl`,
    sessionId,
    byteOffset: 1,
    fileIdentity: stableIdentity,
  };
  const observedAt = '2026-01-01T00:00:00.000Z';
  return {
    active: true,
    session_id: sessionId,
    prompt: 'private user task',
    phase: 'execution',
    iteration: 1,
    max_iterations: 10,
    workflowRunId: '22222222-2222-4222-8222-222222222222',
    workflow: {
      descriptorVersion: 1,
      workflowName,
      profileVersion: 1,
      stages,
      profileHash,
    },
    pipelineTracking: {
      currentStageIndex: 1,
      trackingRevision: 1,
      activationBoundary,
      completionObservations: [{
        stageId: 'ralplan',
        sessionId,
        signalId: 'PIPELINE_RALPLAN_COMPLETE',
        lineNumber: 0,
        byteOffset: 0,
        recordContentSha256: '0'.repeat(64),
        stableFile: stableIdentity,
        activationBoundary: { ...activationBoundary, byteOffset: 0, fileIdentity: initialIdentity },
        observedAt,
      }],
      stages: [
        { id: 'ralplan', status: 'complete', iterations: 0, startedAt: observedAt, completedAt: observedAt },
        { id: 'execution', status: 'active', iterations: 0, startedAt: observedAt },
        { id: 'ralph', status: 'pending', iterations: 0 },
        { id: 'qa', status: 'pending', iterations: 0 },
      ],
    },
    originalIdea: 'private user task',
    expansion: { spec_path: '/private/spec.md' },
    planning: { plan_path: '/private/plan.md' },
    transcript_path: '/private/transcript.jsonl',
    completionObservations: ['private completion observation'],
    futureModel: 'private future value',
    ...overrides,
  };
}

describe('autopilot workflow profile observability', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('renders a verified profile with bounded name, selected stage, and progress', () => {
    const longNameHash = createHash('sha256').update(canonicalJson({
      descriptorVersion: 1,
      workflowName: 'x'.repeat(40),
      profileVersion: 1,
      stages,
    })).digest('hex');

    const directory = mkdtempSync(join(tmpdir(), 'omc-autopilot-profile-'));
    directories.push(directory);
    const statePath = join(directory, '.omc', 'state', 'autopilot-state.json');
    mkdirSync(join(statePath, '..'), { recursive: true });
    writeFileSync(statePath, JSON.stringify(workflowState({
      workflow: {
        descriptorVersion: 1,
        workflowName: 'x'.repeat(40),
        profileVersion: 1,
        stages,
        profileHash: longNameHash,
      },
    })), 'utf-8');
    const output = renderAutopilot(readAutopilotStateForHud(directory));

    expect(output).toContain(`workflow:${'x'.repeat(32)}`);
    expect(output).not.toContain('x'.repeat(33));
    expect(output).toContain('execution 2/4');
    expect(output).toContain(`#${longNameHash.slice(0, 12)}`);
  });

  it('marks a malformed workflow descriptor invalid when reading HUD state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-autopilot-profile-'));
    directories.push(directory);
    const statePath = join(directory, '.omc', 'state', 'autopilot-state.json');
    mkdirSync(join(statePath, '..'), { recursive: true });
    writeFileSync(statePath, JSON.stringify(workflowState({
      workflow: { descriptorVersion: 1, workflowName, profileVersion: 1, stages, profileHash: 'bad' },
    })), 'utf-8');

    const hudState = readAutopilotStateForHud(directory);
    expect(hudState?.workflow).toEqual({ invalid: true });
    expect(renderAutopilot(hudState)).toContain('workflow:invalid');
  });

  it('marks a falsy named-workflow marker invalid instead of rendering legacy autopilot state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-autopilot-profile-'));
    directories.push(directory);
    const statePath = join(directory, '.omc', 'state', 'autopilot-state.json');
    mkdirSync(join(statePath, '..'), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      active: true,
      phase: 'execution',
      iteration: 1,
      max_iterations: 10,
      workflow: false,
    }), 'utf-8');

    const hudState = readAutopilotStateForHud(directory);
    expect(hudState?.workflow).toEqual({ invalid: true });
    expect(renderAutopilot(hudState)).toContain('workflow:invalid');
  });

  it('redacts profile-run private fields while preserving the public projection', () => {
    const publicState = redactAutopilotPublicState(workflowState());

    expect(publicState).toEqual({
      name: workflowName,
      workflowRunId: '22222222-2222-4222-8222-222222222222',
      version: 1,
      shortHash: profileHash.slice(0, 12),
      stages,
      currentStage: 'execution',
      status: 'active',
      progress: '2/4',
    });
    expect(JSON.stringify(publicState)).not.toMatch(/private|originalIdea|spec_path|plan_path|transcript|futureModel/);
  });

  it('keeps legacy autopilot rendering unchanged', () => {
    expect(renderAutopilot({
      active: true,
      phase: 'execution',
      iteration: 2,
      maxIterations: 5,
      tasksCompleted: 3,
      tasksTotal: 7,
      filesCreated: 1,
    })).toContain('Phase');
  });

  it('bounds and redacts Stop-facing runtime insight fields', () => {
    const directory = mkdtempSync(join(process.cwd(), '.tmp-omc-runtime-insight-profile-'));
    directories.push(directory);
    writeHudState({
      timestamp: new Date().toISOString(),
      backgroundTasks: [{
        id: 'background-1',
        description: `${'x'.repeat(200)} /private/transcript.jsonl`,
        status: 'running',
        startedAt: new Date().toISOString(),
      }],
    }, directory);

    const insight = formatAutopilotRuntimeInsight(directory);
    expect(insight).not.toContain('/private/transcript.jsonl');
    expect(insight.length).toBeLessThanOrEqual(2_000);
  });
});
