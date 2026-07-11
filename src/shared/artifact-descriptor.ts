import { createHash, randomBytes } from 'crypto';
import { closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
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
  // Atomic replacement with an exclusive, unpredictable temp name: random suffix + O_EXCL prevents
  // same-process concurrent writes and stale/precreated temp collisions from clobbering each other.
  const tmp = `${options.path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, options.content, { encoding: "utf-8" });
  } catch (e) {
    try { closeSync(fd); unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, options.path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
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
