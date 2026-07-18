import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error The release helper is intentionally dependency-free ESM without declarations.
import * as releaseBoundary from '../../scripts/release-boundary.mjs';

const {
  assertArchive,
  assertEvidence,
  assertNpmAbsent,
  assertSlsaProvenance,
  assertSigstoreFallback,
  assertTrigger,
  buildEvidenceFromBytes,
  classifySigstoreRekorFailure,
  cliMain,
  decodeDssePayload,
  prepareStage,
  selectSlsaAttestation,
  verifyRegistry,
  writeEvidence,
} = releaseBoundary;

const PACKAGE_NAME = 'oh-my-claude-sisyphus';
const VERSION = '4.15.4';
const TAG = `v${VERSION}`;
const SHA = 'a'.repeat(40);
const TEMP_ROOTS: string[] = [];

type TarEntry = {
  path: string;
  content?: Buffer | string;
  mode?: number;
  type?: '0' | '5';
};

type TestServer = {
  base: string;
  close: () => Promise<void>;
};

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  TEMP_ROOTS.push(root);
  return root;
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function tarHeader(entry: TarEntry, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  if (Buffer.byteLength(entry.path) > 100) {
    throw new Error(`test tar fixture path is too long: ${entry.path}`);
  }
  header.write(entry.path, 0, 'utf8');
  writeOctal(header, 100, 8, entry.mode ?? 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.type === '5' ? 0 : content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = (entry.type ?? '0').charCodeAt(0);
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}

function makeTarball(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content ?? '', 'utf8');
    blocks.push(tarHeader(entry, content));
    if (entry.type !== '5') {
      blocks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function packageManifest(gitHead?: string): Record<string, unknown> {
  return {
    name: PACKAGE_NAME,
    version: VERSION,
    ...(gitHead ? { gitHead } : {}),
    bin: {
      'oh-my-claudecode': 'bin/oh-my-claudecode.js',
      omc: 'bin/oh-my-claudecode.js',
      'omc-cli': 'bridge/cli.cjs',
    },
  };
}

function releaseTarball(gitHead = SHA, extraEntries: TarEntry[] = [], readme = '# fixture\n'): Buffer {
  return makeTarball([
    { path: 'package/package.json', content: `${JSON.stringify(packageManifest(gitHead), null, 2)}\n` },
    {
      path: 'package/.claude-plugin/plugin.json',
      content: JSON.stringify({ name: 'oh-my-claudecode', version: VERSION }),
    },
    {
      path: 'package/.claude-plugin/marketplace.json',
      content: JSON.stringify({
        version: VERSION,
        plugins: [{ name: 'oh-my-claudecode', version: VERSION, source: './' }],
      }),
    },
    {
      path: 'package/.mcp.json',
      content: JSON.stringify({
        mcpServers: {
          omc: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs'] },
        },
      }),
    },
    { path: 'package/bin/oh-my-claudecode.js', content: '#!/usr/bin/env node\n', mode: 0o755 },
    { path: 'package/bridge/cli.cjs', content: 'module.exports = {};\n' },
    { path: 'package/bridge/claude-md-coordinator.cjs', content: 'module.exports = {};\n' },
    { path: 'package/bridge/mcp-server.cjs', content: 'module.exports = {};\n' },
    { path: 'package/bridge/runtime-cli.cjs', content: 'module.exports = {};\n' },
    { path: 'package/bridge/team.js', content: 'export {};\n' },
    { path: 'package/README.md', content: readme },
    ...extraEntries,
  ]);
}

function writeTarball(root: string, name: string, bytes: Buffer): string {
  const path = join(root, name);
  writeFileSync(path, bytes);
  return path;
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListening);
      resolveListening();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose())),
  };
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function withEnvironment<T>(values: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function dssePayload(sha512: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `pkg:npm/${PACKAGE_NAME}@${VERSION}`, digest: { sha512 } }],
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: {
          workflow: {
            repository: 'https://github.com/Yeachan-Heo/oh-my-claudecode',
            path: '.github/workflows/release.yml',
            ref: `refs/tags/${TAG}`,
          },
        },
        resolvedDependencies: [{
          uri: `git+https://github.com/Yeachan-Heo/oh-my-claudecode@refs/tags/${TAG}`,
          digest: { gitCommit: SHA },
        }],
      },
      runDetails: {
        builder: { id: 'https://github.com/actions/runner/github-hosted' },
        metadata: { invocationId: 'https://github.com/Yeachan-Heo/oh-my-claudecode/actions/runs/123' },
      },
    },
    ...overrides,
  };
}

function slsaAttestation(payload: Record<string, unknown>, signature = 'fixture-signature'): Record<string, unknown> {
  return {
    predicateType: 'https://slsa.dev/provenance/v1',
    bundle: {
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
        signatures: [{ keyid: 'fixture', sig: signature }],
      },
    },
  };
}

function auditReport(
  attestation: Record<string, unknown>,
  registry: string,
  overrides: { invalid?: unknown[]; missing?: unknown[]; verified?: unknown[] } = {},
): Record<string, unknown> {
  return {
    invalid: overrides.invalid ?? [],
    missing: overrides.missing ?? [],
    verified: overrides.verified ?? [{
      name: PACKAGE_NAME,
      version: VERSION,
      location: `node_modules/${PACKAGE_NAME}`,
      registry: `${registry}/`,
      attestations: [{ predicateType: 'https://slsa.dev/provenance/v1' }],
      attestationBundles: [attestation],
    }],
  };
}

function createTriggerRepository(): { root: string; sha: string } {
  const root = makeTempRoot('release-boundary-trigger-');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, '.github'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify(packageManifest(), null, 2));
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'oh-my-claudecode', version: VERSION }));
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    version: VERSION,
    plugins: [{ name: 'oh-my-claudecode', version: VERSION }],
  }));
  writeFileSync(join(root, 'docs', 'CLAUDE.md'), `<!-- OMC:VERSION:${VERSION} -->\n`);
  writeFileSync(join(root, 'CHANGELOG.md'), `# oh-my-claudecode v${VERSION}: fixture\n`);
  writeFileSync(join(root, '.github', 'release-body.md'), '# Release notes\n');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'release@example.test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'release fixture'], { cwd: root, stdio: 'ignore' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  execFileSync('git', ['tag', '-a', TAG, '-m', TAG], { cwd: root, stdio: 'ignore' });
  return { root, sha };
}

afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('release-boundary.mjs', () => {
  it('fails closed for npm collision, status, malformed-body, transport, and timeout states', async () => {
    const server = await startServer((request, response) => {
      switch (request.url) {
        case `/${PACKAGE_NAME}/4.15.4`:
          response.writeHead(404);
          response.end();
          break;
        case `/${PACKAGE_NAME}/4.15.5`:
          sendJson(response, 200, { version: '4.15.5' });
          break;
        case `/${PACKAGE_NAME}/4.15.6`:
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end('{malformed');
          break;
        case `/${PACKAGE_NAME}/4.15.7`:
          request.socket.destroy();
          break;
        case `/${PACKAGE_NAME}/4.15.8`:
          break;
        default:
          response.writeHead(500);
          response.end();
      }
    });
    try {
      await withEnvironment({ RELEASE_BOUNDARY_REGISTRY_URL: server.base }, async () => {
        await expect(assertNpmAbsent(PACKAGE_NAME, VERSION)).resolves.toMatchObject({ absent: true });
        await expect(assertNpmAbsent(PACKAGE_NAME, '4.15.5')).rejects.toThrow('already exists');
        await expect(assertNpmAbsent(PACKAGE_NAME, '4.15.6')).rejects.toThrow('unexpected HTTP 503');
        await expect(assertNpmAbsent(PACKAGE_NAME, '4.15.7')).rejects.toThrow('network request failed');
      });
      await withEnvironment({
        RELEASE_BOUNDARY_REGISTRY_URL: server.base,
        RELEASE_BOUNDARY_FETCH_TIMEOUT_MS: '10',
      }, async () => {
        await expect(assertNpmAbsent(PACKAGE_NAME, '4.15.8')).rejects.toThrow('network request failed');
      });
    } finally {
      await server.close();
    }
  });

  it('requires an annotated tag, exact checkout SHA, version parity, and committed release notes', () => {
    const { root, sha } = createTriggerRepository();
    expect(assertTrigger({ tag: TAG, sha, cwd: root })).toEqual({ version: VERSION, sha });
    expect(() => assertTrigger({ tag: VERSION, sha, cwd: root })).toThrow('canonical');
    expect(() => assertTrigger({ tag: TAG, sha: 'b'.repeat(40), cwd: root })).toThrow('same commit');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...packageManifest(), version: '4.15.3' }));
    expect(() => assertTrigger({ tag: TAG, sha, cwd: root })).toThrow('package.json version');
    writeFileSync(join(root, 'package.json'), JSON.stringify(packageManifest(), null, 2));

    writeFileSync(join(root, 'docs', 'CLAUDE.md'), '<!-- OMC:VERSION:4.15.3 -->\n');
    expect(() => assertTrigger({ tag: TAG, sha, cwd: root })).toThrow('does not advertise');

    writeFileSync(join(root, 'docs', 'CLAUDE.md'), `<!-- OMC:VERSION:${VERSION} -->\n`);
    writeFileSync(join(root, '.github', 'release-body.md'), ' \n');
    expect(() => assertTrigger({ tag: TAG, sha, cwd: root })).toThrow('must be non-empty');
    writeFileSync(join(root, '.github', 'release-body.md'), '# Changed release notes\n');
    expect(() => assertTrigger({ tag: TAG, sha, cwd: root })).toThrow('match the contents committed at HEAD');
    execFileSync('git', ['tag', '-d', TAG], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['tag', TAG], { cwd: root, stdio: 'ignore' });
    expect(() => assertTrigger({ tag: TAG, sha, cwd: root })).toThrow('must be annotated');
  });

  it('stages a safe npm archive with only a staged gitHead injection and rejects traversal', () => {
    const root = makeTempRoot('release-boundary-stage-');
    const trackedManifestPath = join(root, 'package.json');
    const trackedManifest = `${JSON.stringify(packageManifest(), null, 2)}\n`;
    writeFileSync(trackedManifestPath, trackedManifest);
    const seedPath = writeTarball(root, 'seed.tgz', makeTarball([
      { path: 'package/package.json', content: trackedManifest },
      { path: 'package/bin/oh-my-claudecode.js', content: '#!/usr/bin/env node\n', mode: 0o755 },
    ]));
    const stage = join(root, 'stage');

    prepareStage(seedPath, stage, SHA);
    expect(readFileSync(trackedManifestPath, 'utf8')).toBe(trackedManifest);
    expect(JSON.parse(readFileSync(join(stage, 'package', 'package.json'), 'utf8'))).toMatchObject({
      name: PACKAGE_NAME,
      version: VERSION,
      gitHead: SHA,
    });

    const traversalPath = writeTarball(root, 'traversal.tgz', makeTarball([
      { path: '../outside.txt', content: 'escape' },
    ]));
    const rejectedStage = join(root, 'rejected-stage');
    expect(() => prepareStage(traversalPath, rejectedStage, SHA)).toThrow('unsafe');
    expect(() => readFileSync(join(root, 'outside.txt'), 'utf8')).toThrow();
  });

  it('asserts the final archive surfaces and records tamper-evident byte and content manifests', async () => {
    const root = makeTempRoot('release-boundary-evidence-');
    const tarballPath = writeTarball(root, `${PACKAGE_NAME}-${VERSION}.tgz`, releaseTarball());
    const evidencePath = join(root, 'release-evidence.json');

    expect(() => assertArchive(tarballPath, { version: VERSION, gitHead: SHA })).not.toThrow();
    const evidence = writeEvidence(tarballPath, evidencePath);
    expect(evidence).toMatchObject({
      package: { name: PACKAGE_NAME, version: VERSION, gitHead: SHA },
      sourceSha: SHA,
      tag: TAG,
      npmIntegrity: expect.stringMatching(/^sha512-/),
    });
    expect(evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.archiveManifest).toMatchObject({
      algorithm: 'sha256',
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(evidence.archiveManifest.files).toContainEqual(expect.objectContaining({
      path: 'package/bridge/claude-md-coordinator.cjs',
      byteLength: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(evidence.archiveManifest.files.map((file: { path: string }) => file.path)).toEqual([
      'package/.claude-plugin/marketplace.json',
      'package/.claude-plugin/plugin.json',
      'package/.mcp.json',
      'package/README.md',
      'package/bin/oh-my-claudecode.js',
      'package/bridge/claude-md-coordinator.cjs',
      'package/bridge/cli.cjs',
      'package/bridge/mcp-server.cjs',
      'package/bridge/runtime-cli.cjs',
      'package/bridge/team.js',
      'package/package.json',
    ]);

    const forbiddenPath = writeTarball(root, 'forbidden.tgz', releaseTarball(SHA, [
      { path: 'package/.omc/evidence.json', content: '{}' },
    ]));
    expect(() => assertArchive(forbiddenPath, { version: VERSION, gitHead: SHA })).toThrow('forbidden operational artifact');
    expect(assertEvidence(tarballPath, evidencePath)).toEqual(evidence);
    const missingCoordinatorPath = writeTarball(root, 'missing-coordinator.tgz', makeTarball([
      { path: 'package/package.json', content: `${JSON.stringify(packageManifest(SHA), null, 2)}\n` },
      { path: 'package/.claude-plugin/plugin.json', content: JSON.stringify({ name: 'oh-my-claudecode', version: VERSION }) },
      { path: 'package/.claude-plugin/marketplace.json', content: JSON.stringify({ version: VERSION, plugins: [{ name: 'oh-my-claudecode', version: VERSION, source: './' }] }) },
      { path: 'package/.mcp.json', content: JSON.stringify({ mcpServers: { omc: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs'] } } }) },
      { path: 'package/bin/oh-my-claudecode.js', content: '#!/usr/bin/env node\n', mode: 0o755 },
      { path: 'package/bridge/cli.cjs', content: 'module.exports = {};\n' },
      { path: 'package/bridge/mcp-server.cjs', content: 'module.exports = {};\n' },
      { path: 'package/bridge/runtime-cli.cjs', content: 'module.exports = {};\n' },
      { path: 'package/bridge/team.js', content: 'export {};\n' },
    ]));
    expect(() => assertArchive(missingCoordinatorPath, { version: VERSION, gitHead: SHA })).toThrow('bridge/claude-md-coordinator.cjs');
    await expect(cliMain([
      'assert-evidence',
      '--tarball',
      tarballPath,
      '--evidence',
      evidencePath,
    ])).resolves.toBeUndefined();
    writeFileSync(tarballPath, releaseTarball(SHA, [], '# tampered bytes\n'));
    expect(() => assertEvidence(tarballPath, evidencePath)).toThrow();
  });

  it('decodes exactly one DSSE SLSA statement and requires distinct workflow-v1 build type and GitHub-hosted builder', () => {

    const archiveEvidence = buildEvidenceFromBytes(releaseTarball());
    const payload = dssePayload(archiveEvidence.sha512.hex);
    const attestation = slsaAttestation(payload);
    expect(selectSlsaAttestation({ attestations: [attestation] })).toBe(attestation);
    expect(decodeDssePayload(attestation)).toEqual(payload);
    expect(assertSlsaProvenance(payload, {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      sha512: archiveEvidence.sha512.hex,
    })).toBe(true);
    const wrongBuildTypePayload = dssePayload(archiveEvidence.sha512.hex);
    (wrongBuildTypePayload.predicate as { buildDefinition: { buildType: string } }).buildDefinition.buildType = 'https://github.com/actions/runner/github-hosted';
    expect(() => assertSlsaProvenance(wrongBuildTypePayload, {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      sha512: archiveEvidence.sha512.hex,
    })).toThrow('workflow v1 build type');
    const wrongBuilderPayload = dssePayload(archiveEvidence.sha512.hex);
    (wrongBuilderPayload.predicate as { runDetails: { builder: { id: string } } }).runDetails.builder.id = 'https://github.com/actions/runner/self-hosted';
    expect(() => assertSlsaProvenance(wrongBuilderPayload, {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      sha512: archiveEvidence.sha512.hex,
    })).toThrow('builder id');

    expect(() => selectSlsaAttestation({ attestations: [attestation, attestation] })).toThrow('exactly one');
    expect(() => decodeDssePayload({ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: 'bad!' } } })).toThrow('canonical base64');
    const wrongRefPayload = dssePayload(archiveEvidence.sha512.hex);
    const wrongRefPredicate = wrongRefPayload.predicate as {
      buildDefinition: {
        externalParameters: { workflow: Record<string, unknown> };
      };
    };
    wrongRefPredicate.buildDefinition.externalParameters.workflow.ref = 'refs/tags/v4.15.3';
    const wrongSubjectPayload = dssePayload('b'.repeat(128));
    expect(() => assertSlsaProvenance(wrongSubjectPayload, {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      sha512: archiveEvidence.sha512.hex,
    })).toThrow('subject');
    const wrongCommitPayload = dssePayload(archiveEvidence.sha512.hex);
    const wrongCommitPredicate = wrongCommitPayload.predicate as {
      buildDefinition: {
        resolvedDependencies: Array<{ digest: Record<string, unknown> }>;
      };
    };
    wrongCommitPredicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'b'.repeat(40);
    expect(() => assertSlsaProvenance(wrongCommitPayload, {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      sha512: archiveEvidence.sha512.hex,
    })).toThrow('resolved dependency');
    expect(() => assertSlsaProvenance(wrongRefPayload, {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      sha512: archiveEvidence.sha512.hex,
    })).toThrow('workflow repository, path, or ref');
  });

  it('verifies registry bytes against evidence and records only the narrow fallback classifier', async () => {
    const root = makeTempRoot('release-boundary-registry-');
    const tarball = releaseTarball();
    const localTarballPath = writeTarball(root, `${PACKAGE_NAME}-${VERSION}.tgz`, tarball);
    const evidencePath = join(root, 'release-evidence.json');
    const evidence = writeEvidence(localTarballPath, evidencePath);
    let base = '';
    let servedTarball = tarball;
    let registryAttestation = slsaAttestation(dssePayload(evidence.sha512.hex));

    let attestationMode: 'required' | 'absent' = 'required';
    const server = await startServer((request, response) => {
      if (request.url === `/${PACKAGE_NAME}/${VERSION}`) {
        sendJson(response, 200, {
          name: PACKAGE_NAME,
          version: VERSION,
          gitHead: SHA,
          dist: {
            tarball: `${base}/tarballs/${PACKAGE_NAME}-${VERSION}.tgz`,
            integrity: evidence.npmIntegrity,
            shasum: evidence.sha1,
            signatures: [{ keyid: 'fixture', sig: 'fixture' }],
          },
        });
        return;
      }
      if (request.url === `/${PACKAGE_NAME}`) {
        sendJson(response, 200, { 'dist-tags': { latest: VERSION } });
        return;
      }
      if (request.url === `/tarballs/${PACKAGE_NAME}-${VERSION}.tgz`) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(servedTarball);
        return;
      }
      if (request.url === `/-/npm/v1/attestations/${PACKAGE_NAME}@${VERSION}`) {
        if (attestationMode === 'absent') {
          response.writeHead(404);
          response.end();
          return;
        }
        sendJson(response, 200, { attestations: [registryAttestation] });

        return;
      }
      response.writeHead(404);
      response.end();
    });
    base = server.base;
    const auditPath = join(root, 'npm-audit-signatures.json');
    const npmVerifiedAttestation = slsaAttestation(dssePayload(evidence.sha512.hex));
    writeFileSync(auditPath, JSON.stringify(auditReport(npmVerifiedAttestation, base)));
    const requiredRegistryOptions = {
      packageName: PACKAGE_NAME,
      version: VERSION,
      tag: TAG,
      sha: SHA,
      evidencePath,
      tarballPath: localTarballPath,
      provenance: 'required',
      auditPath,
    };
    try {
      await withEnvironment({ RELEASE_BOUNDARY_REGISTRY_URL: base }, async () => {
        await expect(cliMain([
          'verify-registry',
          '--package',
          PACKAGE_NAME,
          '--version',
          VERSION,
          '--tag',
          TAG,
          '--sha',
          SHA,
          '--evidence',
          evidencePath,
          '--tarball',
          localTarballPath,
          '--provenance',
          'required',
        ])).rejects.toThrow('--audit is required');

        await expect(cliMain([
          'verify-registry',
          '--package',
          PACKAGE_NAME,
          '--version',
          VERSION,
          '--tag',
          TAG,
          '--sha',
          SHA,
          '--evidence',
          evidencePath,
          '--tarball',
          localTarballPath,
          '--provenance',
          'required',
          '--audit',
          auditPath,

        ])).resolves.toBeUndefined();

        servedTarball = releaseTarball(SHA, [], '# tampered bytes\n');
        await expect(verifyRegistry({
          packageName: PACKAGE_NAME,
          version: VERSION,
          tag: TAG,
          sha: SHA,
          evidencePath,
          tarballPath: localTarballPath,
          provenance: 'required',
          auditPath,
        })).rejects.toThrow();
        servedTarball = tarball;
        writeFileSync(auditPath, JSON.stringify(auditReport(npmVerifiedAttestation, base, { invalid: [{ code: 'EATTESTATIONVERIFY' }] })));
        await expect(verifyRegistry(requiredRegistryOptions)).rejects.toThrow('invalid or missing signatures');
        writeFileSync(auditPath, JSON.stringify(auditReport(npmVerifiedAttestation, base, { missing: [{ name: PACKAGE_NAME }] })));
        await expect(verifyRegistry(requiredRegistryOptions)).rejects.toThrow('invalid or missing signatures');
        writeFileSync(auditPath, JSON.stringify(auditReport(npmVerifiedAttestation, base, {
          verified: [{
            name: 'wrong-package',
            version: VERSION,
            registry: `${base}/`,
            attestationBundles: [npmVerifiedAttestation],
          }],
        })));
        await expect(verifyRegistry(requiredRegistryOptions)).rejects.toThrow(`exactly one verified ${PACKAGE_NAME}@${VERSION} entry`);
        writeFileSync(auditPath, JSON.stringify(auditReport(npmVerifiedAttestation, base)));
        registryAttestation = slsaAttestation(dssePayload(evidence.sha512.hex), 'different-signature');
        await expect(verifyRegistry(requiredRegistryOptions)).rejects.toThrow('DSSE signatures mismatch');
        registryAttestation = slsaAttestation(dssePayload('b'.repeat(128)));
        await expect(verifyRegistry(requiredRegistryOptions)).rejects.toThrow('DSSE payload mismatch');
        registryAttestation = slsaAttestation(dssePayload(evidence.sha512.hex));
      });

      const publishLogPath = join(root, 'npm-publish.log');
      writeFileSync(publishLogPath, 'npm error code TLOG_CREATE_ENTRY_ERROR\nnpm error rekor unavailable\n');
      await expect(cliMain([
        'verify-registry',
        '--package',
        PACKAGE_NAME,
        '--version',
        VERSION,
        '--tag',
        TAG,
        '--sha',
        SHA,
        '--evidence',
        evidencePath,
        '--tarball',
        localTarballPath,
        '--provenance',
        'sigstore-fallback',
        '--publish-log',
        publishLogPath,
        '--audit',
        auditPath,
      ])).rejects.toThrow('--audit is only valid');
      attestationMode = 'absent';
      await withEnvironment({
        RELEASE_BOUNDARY_REGISTRY_URL: base,
        GITHUB_RUN_ID: '12345',
      }, async () => {
        await expect(verifyRegistry({
          packageName: PACKAGE_NAME,
          version: VERSION,
          tag: TAG,
          sha: SHA,
          evidencePath,
          tarballPath: localTarballPath,
          provenance: 'sigstore-fallback',
          publishLog: publishLogPath,
        })).resolves.toMatchObject({ provenance: 'sigstore-fallback', classifier: 'TLOG_CREATE_ENTRY_ERROR' });
      });
      expect(JSON.parse(readFileSync(evidencePath, 'utf8'))).toMatchObject({
        provenanceMode: 'sigstore-fallback',
        provenance: {
          mode: 'sigstore-fallback',
          assurance: 'reduced',
          workflowRunId: '12345',
        },
      });
      attestationMode = 'required';
      await withEnvironment({
        RELEASE_BOUNDARY_REGISTRY_URL: base,
        GITHUB_RUN_ID: '12345',
      }, async () => {
        await expect(verifyRegistry({
          packageName: PACKAGE_NAME,
          version: VERSION,
          tag: TAG,
          sha: SHA,
          evidencePath,
          tarballPath: localTarballPath,
          provenance: 'sigstore-fallback',
          publishLog: publishLogPath,
        })).rejects.toThrow('cannot ignore a present SLSA provenance');
      });
    } finally {
      await server.close();
    }
  });

  it('accepts only reviewed Sigstore/Rekor transparency-log failure messages', async () => {
    expect(classifySigstoreRekorFailure('npm ERR! code TLOG_CREATE_ENTRY_ERROR: Rekor entry creation failed')).toBe('TLOG_CREATE_ENTRY_ERROR');
    expect(classifySigstoreRekorFailure('Sigstore could not create a transparency log entry: Rekor unavailable')).toBe('SIGSTORE_REKOR_TRANSPARENCY_LOG');
    expect(classifySigstoreRekorFailure('rekor client installed successfully')).toBeNull();
    expect(classifySigstoreRekorFailure('provenance disabled because of an unrelated network timeout')).toBeNull();
    expect(classifySigstoreRekorFailure('npm ERR! code TLOG_CREATE_ENTRY_ERROR\nSigstore could not create a transparency log entry: Rekor unavailable')).toBeNull();
    expect(classifySigstoreRekorFailure('npm ERR! code TLOG_CREATE_ENTRY_ERROR\nnpm ERR! an unrelated failure')).toBeNull();
    const root = makeTempRoot('release-boundary-sigstore-');
    const publishLogPath = join(root, 'npm-publish.log');
    writeFileSync(publishLogPath, 'npm ERR! code TLOG_CREATE_ENTRY_ERROR\nnpm ERR! Rekor entry creation failed\n');
    expect(assertSigstoreFallback(publishLogPath)).toEqual({ classifier: 'TLOG_CREATE_ENTRY_ERROR' });
    await expect(cliMain([
      'assert-sigstore-fallback',
      '--publish-log',
      publishLogPath,
    ])).resolves.toBeUndefined();
    writeFileSync(publishLogPath, 'npm ERR! an unrelated network timeout\n');
    expect(() => assertSigstoreFallback(publishLogPath)).toThrow('recognized Sigstore/Rekor');
    for (const competingCode of ['E401', 'E403', 'EPUBLISHCONFLICT', 'ENETWORK']) {
      const competingLog = `npm ERR! code TLOG_CREATE_ENTRY_ERROR\nnpm ERR! code ${competingCode}\n`;
      expect(classifySigstoreRekorFailure(competingLog)).toBeNull();
      writeFileSync(publishLogPath, competingLog);
      expect(() => assertSigstoreFallback(publishLogPath)).toThrow('exactly one recognized');
    }
  });
});
