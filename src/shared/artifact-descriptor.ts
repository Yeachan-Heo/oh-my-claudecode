import { createHash } from 'crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export const DEFAULT_INLINE_ARTIFACT_THRESHOLD_BYTES = 2048;
const DEFAULT_HANDOFF_SUMMARY_MAX_CHARS = 160;

export type ArtifactRetention = 'ephemeral' | 'session' | 'until-completion' | 'persistent';

export interface ArtifactProducer {
  system: 'omc' | 'omx';
  component: string;
  worker?: string;
}

export interface ArtifactDescriptor {
  kind: string;
  path: string;
  contentHash?: string;
  createdAt: string;
  producer: ArtifactProducer;
  sizeBytes?: number;
  retention: ArtifactRetention;
  expiresAt?: string;
}

export interface InlineArtifactHandoff {
  mode: 'inline';
  body: string;
  summary: string;
  sizeBytes: number;
  thresholdBytes: number;
}

export interface DescriptorArtifactHandoff {
  mode: 'descriptor';
  summary: string;
  descriptor: ArtifactDescriptor;
  sizeBytes: number;
  thresholdBytes: number;
}

export type ArtifactHandoff = InlineArtifactHandoff | DescriptorArtifactHandoff;

export interface CreateArtifactDescriptorOptions {
  kind: string;
  producer: ArtifactProducer;
  retention: ArtifactRetention;
  createdAt?: string;
  expiresAt?: string;
}

export interface WriteTextArtifactOptions extends CreateArtifactDescriptorOptions {
  path: string;
  content: string;
}

export interface CreateArtifactHandoffOptions {
  body: string;
  summary?: string;
  thresholdBytes?: number;
  descriptorFactory: () => ArtifactDescriptor;
}

export function summarizeArtifactBody(body: string, maxChars: number = DEFAULT_HANDOFF_SUMMARY_MAX_CHARS): string {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function createArtifactDescriptorFromPath(
  path: string,
  options: CreateArtifactDescriptorOptions,
): ArtifactDescriptor {
  const content = readFileSync(path);
  const stats = statSync(path);

  return {
    kind: options.kind,
    path,
    contentHash: createHash('sha256').update(content).digest('hex'),
    createdAt: options.createdAt ?? new Date(stats.mtimeMs).toISOString(),
    producer: options.producer,
    sizeBytes: stats.size,
    retention: options.retention,
    expiresAt: options.expiresAt,
  };
}

export function writeTextArtifact(options: WriteTextArtifactOptions): ArtifactDescriptor {
  mkdirSync(dirname(options.path), { recursive: true });
  writeFileSync(options.path, options.content, { encoding: 'utf-8', mode: 0o600 });

  return createArtifactDescriptorFromPath(options.path, options);
}

export function createArtifactHandoff(options: CreateArtifactHandoffOptions): ArtifactHandoff {
  const thresholdBytes = options.thresholdBytes ?? DEFAULT_INLINE_ARTIFACT_THRESHOLD_BYTES;
  const sizeBytes = Buffer.byteLength(options.body, 'utf-8');
  const summary = options.summary ?? summarizeArtifactBody(options.body);

  if (sizeBytes <= thresholdBytes) {
    return {
      mode: 'inline',
      body: options.body,
      summary,
      sizeBytes,
      thresholdBytes,
    };
  }

  return {
    mode: 'descriptor',
    summary,
    descriptor: options.descriptorFactory(),
    sizeBytes,
    thresholdBytes,
  };
}
