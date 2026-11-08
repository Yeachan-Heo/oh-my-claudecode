import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';

type ArtifactModule = Record<string, unknown>;

const ARTIFACT_DESCRIPTOR_SOURCE_PATH = join(process.cwd(), 'src', 'shared', 'artifact-descriptor.ts');
const ARTIFACT_DESCRIPTOR_IMPORT_PATH = '../shared/artifact-descriptor.js';

function getExistingArtifactSource(): string {
  expect(existsSync(ARTIFACT_DESCRIPTOR_SOURCE_PATH)).toBe(true);
  return readFileSync(ARTIFACT_DESCRIPTOR_SOURCE_PATH, 'utf-8');
}

async function loadArtifactModule(): Promise<ArtifactModule> {
  return (await import(ARTIFACT_DESCRIPTOR_IMPORT_PATH)) as ArtifactModule;
}

function getCreateArtifactHandoff(mod: ArtifactModule): (input: Record<string, unknown>) => Record<string, unknown> {
  const createHandoff = mod.createArtifactHandoff;
  expect(typeof createHandoff).toBe('function');
  return createHandoff as (input: Record<string, unknown>) => Record<string, unknown>;
}

function getCreateArtifactDescriptorFromPath(
  mod: ArtifactModule,
): (path: string, input: Record<string, unknown>) => Record<string, unknown> {
  const createDescriptor = mod.createArtifactDescriptorFromPath;
  expect(typeof createDescriptor).toBe('function');
  return createDescriptor as (path: string, input: Record<string, unknown>) => Record<string, unknown>;
}

function getWriteTextArtifact(mod: ArtifactModule): (input: Record<string, unknown>) => Record<string, unknown> {
  const writeArtifact = mod.writeTextArtifact;
  expect(typeof writeArtifact).toBe('function');
  return writeArtifact as (input: Record<string, unknown>) => Record<string, unknown>;
}

function readMode(result: Record<string, unknown>): string | undefined {
  const mode = result.mode ?? result.strategy ?? result.kind;
  return typeof mode === 'string' ? mode : undefined;
}

function readInlineContent(result: Record<string, unknown>): string | undefined {
  return typeof result.body === 'string' ? result.body : undefined;
}

function readDescriptor(result: Record<string, unknown>): Record<string, unknown> | undefined {
  return result.descriptor && typeof result.descriptor === 'object'
    ? result.descriptor as Record<string, unknown>
    : undefined;
}

describe('artifact descriptor contract', () => {
  it('defines the canonical descriptor fields in the shared artifact module', () => {
    const source = getExistingArtifactSource();

    expect(ARTIFACT_DESCRIPTOR_SOURCE_PATH).toMatch(/src\/shared\//);
    expect(source).toMatch(/ArtifactDescriptor/);

    for (const field of ['kind', 'path', 'createdAt', 'producer', 'retention']) {
      expect(source).toContain(field);
    }

    for (const optionalField of ['contentHash', 'sizeBytes', 'expiresAt']) {
      expect(source).toContain(optionalField);
    }

    expect(source).toMatch(/threshold/i);
    expect(source).toMatch(/inline/i);
    expect(source).toMatch(/descriptor/i);
  });

  it('creates stable descriptors for the same durable artifact input', async () => {
    const mod = await loadArtifactModule();
    const createArtifactDescriptorFromPath = getCreateArtifactDescriptorFromPath(mod);
    const dir = mkdtempSync(join(tmpdir(), 'artifact-descriptor-contract-'));

    try {
      const path = join(dir, 'plan.md');
      const content = 'phase-1 plan artifact';
      writeFileSync(path, content, 'utf-8');

      const input = {
        kind: 'prompt',
        createdAt: '2026-04-07T00:00:00.000Z',
        producer: { system: 'omc', component: 'worker-1' },
        retention: 'session',
        expiresAt: '2026-04-08T00:00:00.000Z',
      };

      const first = createArtifactDescriptorFromPath(path, input);
      const second = createArtifactDescriptorFromPath(path, input);

      expect(first).toMatchObject({
        kind: input.kind,
        path,
        createdAt: input.createdAt,
        producer: input.producer,
        retention: input.retention,
        expiresAt: input.expiresAt,
      });

      expect(first.contentHash).toBe(second.contentHash);
      expect(first.sizeBytes).toBe(Buffer.byteLength(content, 'utf-8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps small payloads inline when they are under the explicit threshold', async () => {
    const mod = await loadArtifactModule();
    const writeTextArtifact = getWriteTextArtifact(mod);
    const createArtifactHandoff = getCreateArtifactHandoff(mod);
    const content = 'short summary';
    const dir = mkdtempSync(join(tmpdir(), 'artifact-handoff-inline-'));

    try {
      const descriptor = writeTextArtifact({
        kind: 'prompt',
        path: join(dir, 'short.md'),
        content,
        createdAt: '2026-04-07T00:00:00.000Z',
        producer: { system: 'omc', component: 'worker-1' },
        retention: 'session',
      });

      const handoff = createArtifactHandoff({
        body: content,
        summary: 'short summary',
        thresholdBytes: Buffer.byteLength(content, 'utf-8') + 1,
        descriptorFactory: () => descriptor,
      });

      expect(readMode(handoff)).toBe('inline');
      expect(readInlineContent(handoff)).toBe(content);
      expect(handoff.summary).toBe('short summary');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('switches to descriptor mode when payload exceeds the explicit threshold', async () => {
    const mod = await loadArtifactModule();
    const writeTextArtifact = getWriteTextArtifact(mod);
    const createArtifactHandoff = getCreateArtifactHandoff(mod);
    const content = 'x'.repeat(128);
    const dir = mkdtempSync(join(tmpdir(), 'artifact-handoff-descriptor-'));

    try {
      const descriptor = writeTextArtifact({
        kind: 'result',
        path: join(dir, 'large.md'),
        content,
        createdAt: '2026-04-07T00:00:00.000Z',
        producer: { system: 'omc', component: 'worker-1' },
        retention: 'until-completion',
      });

      const handoff = createArtifactHandoff({
        body: content,
        summary: 'large result omitted from inline handoff',
        thresholdBytes: 32,
        descriptorFactory: () => descriptor,
      });

      expect(readMode(handoff)).toBe('descriptor');
      expect(readInlineContent(handoff)).toBeUndefined();
      expect(readDescriptor(handoff)).toMatchObject({
        kind: 'result',
        path: descriptor.path,
        producer: { system: 'omc', component: 'worker-1' },
        retention: 'until-completion',
      });
      expect(handoff.summary).toBe('large result omitted from inline handoff');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
