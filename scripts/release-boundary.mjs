#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const PACKAGE_NAME = 'oh-my-claude-sisyphus';
const PLUGIN_NAME = 'oh-my-claudecode';
const REGISTRY_URL_ENV = 'RELEASE_BOUNDARY_REGISTRY_URL';
const FETCH_TIMEOUT_ENV = 'RELEASE_BOUNDARY_FETCH_TIMEOUT_MS';
const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org';
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const SLSA_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const GITHUB_ACTIONS_WORKFLOW_V1_BUILD_TYPE = 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1';

const GITHUB_HOSTED_BUILDER_ID = 'https://github.com/actions/runner/github-hosted';

const REPOSITORY_URL = 'https://github.com/Yeachan-Heo/oh-my-claudecode';
const WORKFLOW_PATH = '.github/workflows/release.yml';
const EXPECTED_BINS = Object.freeze({
  'oh-my-claudecode': 'bin/oh-my-claudecode.js',
  omc: 'bin/oh-my-claudecode.js',
  'omc-cli': 'bridge/cli.cjs',
});
const REQUIRED_ENTRYPOINTS = Object.freeze([
  'bin/oh-my-claudecode.js',
  'bridge/cli.cjs',
  'bridge/claude-md-coordinator.cjs',
  'bridge/mcp-server.cjs',
  'bridge/runtime-cli.cjs',
  'bridge/team.js',
]);

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function requireSha(value, label = 'SHA') {
  if (!/^[0-9a-f]{40}$/i.test(requireString(value, label))) {
    fail(`${label} must be a 40-character hexadecimal git commit`);
  }
  return value.toLowerCase();
}

function requireVersion(value) {
  const version = requireString(value, 'version');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)) {
    fail(`version is not a supported release semver: ${version}`);
  }
  return version;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readJsonFile(path, label = path) {
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseJson(content, label);
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function shaHex(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest('hex');
}

function shaBase64(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest('base64');
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseOctal(buffer, field) {
  const raw = buffer.toString('ascii').replace(/\0/g, '').trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) {
    fail(`invalid tar ${field} field`);
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`invalid tar ${field} value`);
  }
  return value;
}

function hasValidTarChecksum(header) {
  const stored = parseOctal(header.subarray(148, 156), 'checksum');
  let calculated = 0;
  for (let index = 0; index < 512; index += 1) {
    calculated += index >= 148 && index < 156 ? 32 : header[index];
  }
  return stored === calculated;
}

function tarField(buffer) {
  return buffer.toString('utf8').replace(/\0.*$/, '');
}

function normalizeTarPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    fail('tar archive contains an empty or invalid path');
  }
  if (rawPath.includes('\\') || rawPath.startsWith('/')) {
    fail(`tar archive path is unsafe: ${rawPath}`);
  }
  const normalized = rawPath.replace(/\/+$/, '');
  if (normalized === '') {
    fail(`tar archive path is unsafe: ${rawPath}`);
  }
  const segments = normalized.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes(':'))) {
    fail(`tar archive path is unsafe: ${rawPath}`);
  }
  if (segments[0] !== 'package') {
    fail(`tar archive entry must be rooted at package/: ${rawPath}`);
  }
  return normalized;
}

function parsePaxHeader(content) {
  const text = content.toString('utf8');
  if (text.includes('\uFFFD')) {
    fail('tarball contains a PAX header that is not UTF-8');
  }
  const fields = Object.create(null);
  let offset = 0;
  while (offset < text.length) {
    const separator = text.indexOf(' ', offset);
    if (separator < 0) fail('tarball contains a malformed PAX header');
    const lengthText = text.slice(offset, separator);
    if (!/^\d+$/.test(lengthText)) fail('tarball contains a malformed PAX header length');
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || length <= separator - offset || end > text.length) {
      fail('tarball contains a malformed PAX header length');
    }
    const record = text.slice(separator + 1, end);
    if (!record.endsWith('\n')) fail('tarball contains a malformed PAX header record');
    const equals = record.indexOf('=');
    if (equals <= 0) fail('tarball contains a malformed PAX header record');
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1, -1);
    if (Object.hasOwn(fields, key)) fail(`tarball contains a duplicate PAX field: ${key}`);
    fields[key] = value;
    offset = end;
  }
  return fields;
}

/**
 * Read the regular files and directories from a gzip-compressed ustar archive.
 * npm tarballs are ustar/PAX archives. Rejecting links and unsupported records
 * avoids accepting archive semantics that can write outside the requested stage.
 */
export function readTarballBytes(tarballBytes) {
  let tarBytes;
  try {
    tarBytes = gunzipSync(tarballBytes);
  } catch (error) {
    fail(`tarball is not a valid gzip archive: ${error instanceof Error ? error.message : String(error)}`);
  }

  const entries = [];
  const names = new Set();
  let offset = 0;
  let sawEnd = false;
  let globalPax = {};
  let pendingPax = null;
  while (offset < tarBytes.length) {
    if (offset + 512 > tarBytes.length) {
      fail('tarball ends in a partial header');
    }
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!tarBytes.subarray(offset).every(byte => byte === 0)) {
        fail('tarball contains data after its end-of-archive marker');
      }
      sawEnd = true;
      break;
    }
    if (!hasValidTarChecksum(header)) {
      fail('tarball contains a header with an invalid checksum');
    }

    const name = tarField(header.subarray(0, 100));
    const prefix = tarField(header.subarray(345, 500));
    const size = parseOctal(header.subarray(124, 136), 'size');
    const mode = parseOctal(header.subarray(100, 108), 'mode');
    const typeByte = header[156];
    const type = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tarBytes.length) {
      fail(`tarball entry is truncated: ${name}`);
    }
    const paddedSize = Math.ceil(size / 512) * 512;
    if (contentEnd + (paddedSize - size) > tarBytes.length) {
      fail(`tarball entry padding is truncated: ${name}`);
    }
    const content = tarBytes.subarray(contentStart, contentEnd);
    if (type === 'x' || type === 'g') {
      const pax = parsePaxHeader(content);
      if (type === 'g') globalPax = { ...globalPax, ...pax };
      else pendingPax = { ...globalPax, ...pax };
      offset = contentStart + paddedSize;
      continue;
    }
    const rawPath = pendingPax?.path ?? globalPax.path ?? (prefix ? `${prefix}/${name}` : name);
    pendingPax = null;
    const path = normalizeTarPath(rawPath);
    if (type !== '0' && type !== '5') {
      fail(`tarball contains unsupported ${type === '2' ? 'symlink' : 'non-file'} entry: ${path}`);
    }
    if (type === '5' && size !== 0) {
      fail(`tarball directory has content: ${path}`);
    }
    if (names.has(path)) {
      fail(`tarball contains duplicate entry: ${path}`);
    }
    names.add(path);
    entries.push({
      path,
      type: type === '5' ? 'directory' : 'file',
      mode,
      content,
    });
    offset = contentStart + paddedSize;
  }

  if (!sawEnd) {
    fail('tarball is missing its end-of-archive marker');
  }
  if (pendingPax !== null) {
    fail('tarball ends with an unbound PAX header');
  }
  return entries;
}

export function readTarball(tarballPath) {
  let tarballBytes;
  try {
    tarballBytes = readFileSync(tarballPath);
  } catch (error) {
    fail(`cannot read tarball ${tarballPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    bytes: tarballBytes,
    entries: readTarballBytes(tarballBytes),
  };
}

function requireArchiveFile(entriesByPath, path) {
  const entry = entriesByPath.get(`package/${path}`);
  if (!entry || entry.type !== 'file') {
    fail(`archive is missing required file package/${path}`);
  }
  return entry;
}

function parseArchiveJson(entriesByPath, path) {
  const entry = requireArchiveFile(entriesByPath, path);
  return parseJson(entry.content.toString('utf8'), `archive package/${path}`);
}

function assertExactBins(packageJson) {
  if (!isPlainObject(packageJson.bin)) {
    fail('archive package.json.bin must be an object');
  }
  const actualEntries = Object.entries(packageJson.bin).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(EXPECTED_BINS).sort(([left], [right]) => left.localeCompare(right));
  if (stableJson(actualEntries) !== stableJson(expectedEntries)) {
    fail('archive package.json.bin does not match the required CLI surface');
  }
}

function assertForbiddenArchivePaths(entries) {
  for (const entry of entries) {
    const path = entry.path.slice('package/'.length);
    const basenamePart = basename(path).toLowerCase();
    if (
      path === '.gjc' || path.startsWith('.gjc/') ||
      path === '.omc' || path.startsWith('.omc/') ||
      path === 'logs' || path.startsWith('logs/') ||
      path === 'sessions' || path.startsWith('sessions/') ||
      basenamePart.endsWith('.log') ||
      /(?:^|\/)(?:release-)?evidence(?:[-_./]|$)/i.test(path) ||
      /(?:^|\/)session(?:[-_.].*)?\.(?:json|log|txt)$/i.test(path)
    ) {
      fail(`archive contains forbidden operational artifact: package/${path}`);
    }
  }
}

export function assertArchiveEntries(entries, { version, gitHead, packageName = PACKAGE_NAME }) {
  const expectedVersion = requireVersion(version);
  const expectedGitHead = requireSha(gitHead, 'git-head');
  const entriesByPath = new Map(entries.map(entry => [entry.path, entry]));
  const packageJson = parseArchiveJson(entriesByPath, 'package.json');
  if (!isPlainObject(packageJson)) {
    fail('archive package.json must be an object');
  }
  if (packageJson.name !== packageName) {
    fail(`archive package name mismatch: expected ${packageName}, got ${String(packageJson.name)}`);
  }
  if (packageJson.version !== expectedVersion) {
    fail(`archive package version mismatch: expected ${expectedVersion}, got ${String(packageJson.version)}`);
  }
  if (packageJson.gitHead !== expectedGitHead) {
    fail(`archive package gitHead mismatch: expected ${expectedGitHead}, got ${String(packageJson.gitHead)}`);
  }
  assertExactBins(packageJson);
  for (const entrypoint of REQUIRED_ENTRYPOINTS) {
    requireArchiveFile(entriesByPath, entrypoint);
  }
  for (const target of Object.values(EXPECTED_BINS)) {
    requireArchiveFile(entriesByPath, target);
  }

  const pluginJson = parseArchiveJson(entriesByPath, '.claude-plugin/plugin.json');
  if (!isPlainObject(pluginJson) || pluginJson.name !== PLUGIN_NAME || pluginJson.version !== expectedVersion) {
    fail('archive plugin manifest has an unexpected name or version');
  }
  const marketplaceJson = parseArchiveJson(entriesByPath, '.claude-plugin/marketplace.json');
  if (!isPlainObject(marketplaceJson) || marketplaceJson.version !== expectedVersion || !Array.isArray(marketplaceJson.plugins)) {
    fail('archive marketplace manifest has an unexpected version or plugins list');
  }
  const matchingPlugins = marketplaceJson.plugins.filter(plugin =>
    isPlainObject(plugin) && plugin.name === PLUGIN_NAME,
  );
  if (matchingPlugins.length !== 1 || matchingPlugins[0].version !== expectedVersion || matchingPlugins[0].source !== './') {
    fail('archive marketplace plugin entry does not match the release version and source');
  }

  const mcpJson = parseArchiveJson(entriesByPath, '.mcp.json');
  if (!isPlainObject(mcpJson) || !isPlainObject(mcpJson.mcpServers) || Object.keys(mcpJson.mcpServers).length === 0) {
    fail('archive .mcp.json must expose at least one MCP server');
  }
  const mcpEntrypoints = Object.values(mcpJson.mcpServers).flatMap(server =>
    isPlainObject(server) && Array.isArray(server.args)
      ? server.args.filter(argument => typeof argument === 'string')
      : [],
  );
  if (!mcpEntrypoints.some(argument => argument.replace(/\\/g, '/').endsWith('/bridge/mcp-server.cjs'))) {
    fail('archive .mcp.json does not reference bridge/mcp-server.cjs');
  }

  assertForbiddenArchivePaths(entries);
  return {
    packageJson,
    pluginJson,
    marketplaceJson,
    files: archiveFileManifest(entries),
  };
}

export function assertArchive(tarballPath, options) {
  const archive = readTarball(tarballPath);
  return assertArchiveEntries(archive.entries, options);
}

function archiveFileManifest(entries) {
  const files = entries
    .filter(entry => entry.type === 'file')
    .map(entry => ({
      path: entry.path,
      byteLength: entry.content.length,
      sha256: shaHex('sha256', entry.content),
    }))
    .sort((left, right) => compareStrings(left.path, right.path));
  const manifestInput = files.map(file => `${file.path}\0${file.byteLength}\0${file.sha256}\n`).join('');
  return {
    algorithm: 'sha256',
    digest: shaHex('sha256', Buffer.from(manifestInput, 'utf8')),
    files,
  };
}

function archiveIdentityFromEntries(entries) {
  const entriesByPath = new Map(entries.map(entry => [entry.path, entry]));
  const packageJson = parseArchiveJson(entriesByPath, 'package.json');
  if (!isPlainObject(packageJson)) {
    fail('archive package.json must be an object');
  }
  const pluginJson = parseArchiveJson(entriesByPath, '.claude-plugin/plugin.json');
  const marketplaceJson = parseArchiveJson(entriesByPath, '.claude-plugin/marketplace.json');
  return {
    name: requireString(packageJson.name, 'archive package name'),
    version: requireString(packageJson.version, 'archive package version'),
    gitHead: requireSha(packageJson.gitHead, 'archive package gitHead'),
    bins: Object.fromEntries(Object.entries(packageJson.bin ?? {}).sort(([left], [right]) => left.localeCompare(right))),
    pluginVersion: isPlainObject(pluginJson) ? pluginJson.version : undefined,
    marketplaceVersion: isPlainObject(marketplaceJson) ? marketplaceJson.version : undefined,
    entrypoints: [...REQUIRED_ENTRYPOINTS],
  };
}

export function buildEvidenceFromBytes(tarballBytes, tarballName = 'archive.tgz') {
  const entries = readTarballBytes(tarballBytes);
  const identity = archiveIdentityFromEntries(entries);
  assertArchiveEntries(entries, {
    version: identity.version,
    gitHead: identity.gitHead,
  });
  const manifest = archiveFileManifest(entries);
  const sha512Base64 = shaBase64('sha512', tarballBytes);
  return {
    schemaVersion: 1,
    tarball: basename(tarballName),
    byteLength: tarballBytes.length,
    sha512: {
      hex: shaHex('sha512', tarballBytes),
      base64: sha512Base64,
    },
    sha256: shaHex('sha256', tarballBytes),
    sha1: shaHex('sha1', tarballBytes),
    npmIntegrity: `sha512-${sha512Base64}`,
    archiveManifest: manifest,
    package: identity,
    sourceSha: identity.gitHead,
    tag: `v${identity.version}`,
    ref: `refs/tags/v${identity.version}`,
  };
}

export function writeEvidence(tarballPath, outputPath) {
  const archive = readTarball(tarballPath);
  const evidence = buildEvidenceFromBytes(archive.bytes, basename(tarballPath));
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, `${stableJson(evidence)}\n`, { encoding: 'utf8', flag: 'w' });
  return evidence;
}

function assertRecordedEvidenceMatches(recordedEvidence, recomputedEvidence, { allowProvenance = false } = {}) {
  if (!isPlainObject(recordedEvidence)) {
    fail('evidence must be a JSON object');
  }
  for (const [key, value] of Object.entries(recomputedEvidence)) {
    if (!Object.hasOwn(recordedEvidence, key) || stableJson(recordedEvidence[key]) !== stableJson(value)) {
      fail(`evidence ${key} mismatch`);
    }
  }
  for (const key of Object.keys(recordedEvidence)) {
    if (!Object.hasOwn(recomputedEvidence, key)) {
      if (!allowProvenance || (key !== 'provenance' && key !== 'provenanceMode')) {
        fail(`evidence contains unexpected field: ${key}`);
      }
      if (key === 'provenance' && !isPlainObject(recordedEvidence.provenance)) {
        fail('evidence provenance must be an object');
      }
      if (key === 'provenanceMode' && recordedEvidence.provenanceMode !== 'sigstore-fallback') {
        fail('evidence provenanceMode must be sigstore-fallback');
      }
    }
  }
  if (allowProvenance && (Object.hasOwn(recordedEvidence, 'provenance') || Object.hasOwn(recordedEvidence, 'provenanceMode'))) {
    if (recordedEvidence.provenanceMode !== 'sigstore-fallback' || !isPlainObject(recordedEvidence.provenance) || recordedEvidence.provenance.mode !== recordedEvidence.provenanceMode) {
      fail('evidence provenance and provenanceMode must record sigstore-fallback together');
    }
  }
  return recordedEvidence;
}

function assertEvidenceFromTarball(tarballPath, evidencePath, options) {
  const archive = readTarball(tarballPath);
  const recomputedEvidence = buildEvidenceFromBytes(archive.bytes, basename(tarballPath));
  const recordedEvidence = readJsonFile(evidencePath, 'evidence');
  return assertRecordedEvidenceMatches(recordedEvidence, recomputedEvidence, options);
}

export function assertEvidence(tarballPath, evidencePath) {
  return assertEvidenceFromTarball(tarballPath, evidencePath);
}

function validateEmptyStage(stage) {
  if (existsSync(stage)) {
    let stat;
    try {
      stat = lstatSync(stage);
    } catch (error) {
      fail(`cannot stat stage ${stage}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stat.isDirectory()) {
      fail(`stage exists but is not a directory: ${stage}`);
    }
    if (readdirSync(stage).length !== 0) {
      fail(`stage must be empty: ${stage}`);
    }
  } else {
    mkdirSync(stage, { recursive: true });
  }
}

function injectGitHead(packageJsonText, gitHead) {
  const parsed = parseJson(packageJsonText, 'staged package.json');
  if (!isPlainObject(parsed)) {
    fail('staged package.json must be an object');
  }
  if (Object.hasOwn(parsed, 'gitHead')) {
    fail('seed package.json already contains gitHead; refusing to rewrite a source metadata field');
  }
  const closeIndex = packageJsonText.lastIndexOf('}');
  if (closeIndex < 0 || packageJsonText.slice(closeIndex + 1).trim() !== '') {
    fail('staged package.json is not a single JSON object');
  }
  const newline = packageJsonText.includes('\r\n') ? '\r\n' : '\n';
  const beforeClose = packageJsonText.slice(0, closeIndex);
  const trailingWhitespace = beforeClose.match(/\s*$/)?.[0] ?? '';
  const content = beforeClose.slice(0, beforeClose.length - trailingWhitespace.length);
  const closeIndent = trailingWhitespace.includes('\n')
    ? trailingWhitespace.slice(trailingWhitespace.lastIndexOf('\n') + 1)
    : '';
  const propertyIndent = packageJsonText.match(/(?:\r?\n)([ \t]+)"(?:[^"\\]|\\.)+"\s*:/)?.[1] ?? `${closeIndent}  `;
  const hasProperties = Object.keys(parsed).length > 0;
  const inserted = `${hasProperties ? ',' : ''}${newline}${propertyIndent}"gitHead": ${JSON.stringify(gitHead)}${newline}${closeIndent}`;
  return `${content}${inserted}}${packageJsonText.slice(closeIndex + 1)}`;
}

export function prepareStage(seedTarballPath, stagePath, gitHead) {
  const expectedGitHead = requireSha(gitHead, 'git-head');
  const archive = readTarball(seedTarballPath);
  validateEmptyStage(stagePath);
  const stageRoot = resolve(stagePath);
  for (const entry of archive.entries) {
    const destination = resolve(stageRoot, entry.path);
    const relativeDestination = relative(stageRoot, destination);
    if (relativeDestination === '..' || relativeDestination.startsWith(`..${sep}`) || isAbsolute(relativeDestination)) {
      fail(`tar archive escaped the stage: ${entry.path}`);
    }
    if (entry.type === 'directory') {
      mkdirSync(destination, { recursive: true, mode: entry.mode & 0o777 });
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, entry.content, { encoding: undefined, flag: 'wx', mode: entry.mode & 0o777 });
  }
  const stagedManifestPath = join(stageRoot, 'package', 'package.json');
  if (!existsSync(stagedManifestPath)) {
    fail('seed tarball does not contain package/package.json');
  }
  const stagedManifest = readFileSync(stagedManifestPath, 'utf8');
  writeFileSync(stagedManifestPath, injectGitHead(stagedManifest, expectedGitHead), 'utf8');
  return stagedManifestPath;
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
    fail(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function assertVersionedManifest(value, label, version) {
  if (!isPlainObject(value) || value.version !== version) {
    fail(`${label} version must equal ${version}`);
  }
}

export function assertTrigger({ tag, sha, cwd = process.cwd() }) {
  const version = requireVersion(requireString(tag, 'tag').replace(/^v/, ''));
  if (tag !== `v${version}`) {
    fail(`tag must be the canonical v${version} form`);
  }
  const expectedSha = requireSha(sha);
  if (git(cwd, ['cat-file', '-t', `refs/tags/${tag}`]) !== 'tag') {
    fail(`release tag must be annotated: ${tag}`);
  }
  const tagCommit = requireSha(git(cwd, ['rev-parse', `${tag}^{}`]), `tag ${tag} commit`);
  const checkoutCommit = requireSha(git(cwd, ['rev-parse', 'HEAD']), 'checkout HEAD');
  if (tagCommit !== expectedSha || checkoutCommit !== expectedSha) {
    fail(`tag, checkout, and --sha must identify the same commit (${expectedSha})`);
  }

  const packageJson = readJsonFile(join(cwd, 'package.json'), 'package.json');
  const pluginJson = readJsonFile(join(cwd, '.claude-plugin', 'plugin.json'), '.claude-plugin/plugin.json');
  const marketplaceJson = readJsonFile(join(cwd, '.claude-plugin', 'marketplace.json'), '.claude-plugin/marketplace.json');
  assertVersionedManifest(packageJson, 'package.json', version);
  assertVersionedManifest(pluginJson, '.claude-plugin/plugin.json', version);
  assertVersionedManifest(marketplaceJson, '.claude-plugin/marketplace.json', version);
  if (!Array.isArray(marketplaceJson.plugins) || !marketplaceJson.plugins.some(plugin =>
    isPlainObject(plugin) && plugin.name === PLUGIN_NAME && plugin.version === version,
  )) {
    fail('.claude-plugin/marketplace.json must include the versioned OMC plugin');
  }
  const docsClaude = readFileSync(join(cwd, 'docs', 'CLAUDE.md'), 'utf8');
  if (!docsClaude.includes(`<!-- OMC:VERSION:${version} -->`)) {
    fail(`docs/CLAUDE.md does not advertise ${version}`);
  }
  const changelog = readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8');
  if (!new RegExp(`^# .+ v${escapeRegExp(version)}(?:[:\\s]|$)`, 'm').test(changelog)) {
    fail(`CHANGELOG.md does not start with a ${version} release heading`);
  }
  const releaseBodyPath = '.github/release-body.md';
  if (git(cwd, ['ls-files', '--error-unmatch', releaseBodyPath]) !== releaseBodyPath) {
    fail(`${releaseBodyPath} must be committed`);
  }
  const releaseBody = readFileSync(join(cwd, releaseBodyPath), 'utf8');
  if (releaseBody.trim() === '') {
    fail(`${releaseBodyPath} must be non-empty`);
  }
  let committedReleaseBody;
  try {
    committedReleaseBody = execFileSync('git', ['show', `HEAD:${releaseBodyPath}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    fail(`${releaseBodyPath} cannot be read from HEAD: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (committedReleaseBody !== releaseBody) {
    fail(`${releaseBodyPath} must match the contents committed at HEAD`);
  }
  return { version, sha: expectedSha };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function registryBaseUrl() {
  const configured = process.env[REGISTRY_URL_ENV] ?? DEFAULT_REGISTRY_URL;
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    fail(`${REGISTRY_URL_ENV} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:' && !(process.env[REGISTRY_URL_ENV] && parsed.protocol === 'http:')) {
    fail(`${REGISTRY_URL_ENV} must use HTTPS outside an explicitly injected test registry`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function registryPath(base, path) {
  return `${base}/${path.replace(/^\//, '')}`;
}

function encodePackageName(packageName) {
  return encodeURIComponent(packageName).replace(/%2F/gi, '%2f');
}

function fetchTimeoutMs() {
  const configured = process.env[FETCH_TIMEOUT_ENV];
  if (configured === undefined) return DEFAULT_FETCH_TIMEOUT_MS;
  if (!/^\d+$/.test(configured) || Number(configured) < 1 || Number(configured) > 120_000) {
    fail(`${FETCH_TIMEOUT_ENV} must be an integer between 1 and 120000`);
  }
  return Number(configured);
}

async function fetchBounded(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs());
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'error',
      headers: {
        accept: 'application/json',
        ...(options.headers ?? {}),
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`network request failed for ${url}: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonRequired(url, label) {
  const response = await fetchBounded(url);
  if (response.status !== 200) {
    fail(`${label} returned HTTP ${response.status}`);
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    fail(`cannot read ${label} response: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseJson(text, `${label} response`);
  if (!isPlainObject(parsed) && !Array.isArray(parsed)) {
    fail(`${label} response must be JSON object or array`);
  }
  return parsed;
}

export async function assertNpmAbsent(packageName, version) {
  const encodedPackage = encodePackageName(requireString(packageName, 'package'));
  const encodedVersion = encodeURIComponent(requireVersion(version));
  const url = registryPath(registryBaseUrl(), `${encodedPackage}/${encodedVersion}`);
  const response = await fetchBounded(url);
  if (response.status === 404) {
    return { absent: true, url };
  }
  if (response.status === 200) {
    fail(`npm package version already exists: ${packageName}@${version}`);
  }
  fail(`npm registry absence check returned unexpected HTTP ${response.status}`);
}

function validateEvidence(evidence, { packageName, version, sha }) {
  if (!isPlainObject(evidence) || evidence.schemaVersion !== 1) {
    fail('evidence schemaVersion must be 1');
  }
  if (!Number.isSafeInteger(evidence.byteLength) || evidence.byteLength < 1) {
    fail('evidence byteLength is invalid');
  }
  if (!isPlainObject(evidence.sha512) || !/^[0-9a-f]{128}$/i.test(evidence.sha512.hex) || typeof evidence.sha512.base64 !== 'string') {
    fail('evidence SHA-512 is invalid');
  }
  if (!/^[0-9a-f]{64}$/i.test(evidence.sha256) || !/^[0-9a-f]{40}$/i.test(evidence.sha1)) {
    fail('evidence SHA-256 or SHA-1 is invalid');
  }
  if (evidence.npmIntegrity !== `sha512-${evidence.sha512.base64}`) {
    fail('evidence npm integrity does not match its SHA-512');
  }
  if (!isPlainObject(evidence.archiveManifest) || evidence.archiveManifest.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/i.test(evidence.archiveManifest.digest)) {
    fail('evidence archive manifest digest is invalid');
  }
  if (!isPlainObject(evidence.package) || evidence.package.name !== packageName || evidence.package.version !== version) {
    fail('evidence package identity does not match the requested registry package');
  }
  if (requireSha(evidence.package.gitHead, 'evidence package gitHead') !== sha || requireSha(evidence.sourceSha, 'evidence sourceSha') !== sha) {
    fail('evidence gitHead/sourceSha does not match --sha');
  }
  if (evidence.tag !== `v${version}` || evidence.ref !== `refs/tags/v${version}`) {
    fail('evidence tag/ref does not match the requested version');
  }
  return evidence;
}

function assertDigestEquality(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} mismatch`);
  }
}

function validateRegistryMetadata(metadata, rootMetadata, { packageName, version, sha, evidence, base }) {
  if (!isPlainObject(metadata) || metadata.name !== packageName || metadata.version !== version || requireSha(metadata.gitHead, 'registry gitHead') !== sha) {
    fail('registry package metadata does not match package, version, and gitHead');
  }
  if (!isPlainObject(rootMetadata) || !isPlainObject(rootMetadata['dist-tags'])) {
    fail('registry root metadata has no dist-tags object');
  }
  const expectedDistTag = process.env.RELEASE_BOUNDARY_EXPECTED_DIST_TAG ?? version;
  if (rootMetadata['dist-tags'].latest !== expectedDistTag) {
    fail(`registry latest dist-tag must equal ${expectedDistTag}`);
  }
  if (!isPlainObject(metadata.dist)) {
    fail('registry package metadata has no dist object');
  }
  const { tarball, integrity, shasum, signatures } = metadata.dist;
  if (typeof tarball !== 'string' || typeof integrity !== 'string' || typeof shasum !== 'string') {
    fail('registry dist must include tarball, integrity, and shasum');
  }
  if (!Array.isArray(signatures) || signatures.length === 0) {
    fail('registry dist must include at least one signature');
  }
  let tarballUrl;
  try {
    tarballUrl = new URL(tarball);
  } catch {
    fail('registry dist.tarball is not a URL');
  }
  const injectedRegistry = process.env[REGISTRY_URL_ENV] !== undefined;
  if (tarballUrl.protocol !== 'https:' && !(injectedRegistry && tarballUrl.protocol === 'http:')) {
    fail('registry dist.tarball must use HTTPS');
  }
  const tarballPath = decodeURIComponent(tarballUrl.pathname);
  const expectedTarballStem = packageName.replace(/^@/, '').replace(/\//g, '-');
  if (!tarballPath.includes(expectedTarballStem) || !tarballPath.includes(version)) {
    fail('registry dist.tarball is not package/version-specific');
  }
  assertDigestEquality(integrity, evidence.npmIntegrity, 'registry dist.integrity');
  assertDigestEquality(shasum.toLowerCase(), evidence.sha1.toLowerCase(), 'registry dist.shasum');
  if (!injectedRegistry && tarballUrl.origin !== new URL(base).origin) {
    fail('registry dist.tarball must be served by the configured registry');
  }
  return tarballUrl.toString();
}

function strictBase64Decode(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    fail(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    fail(`${label} is not canonical base64`);
  }
  const text = decoded.toString('utf8');
  if (text.includes('\uFFFD')) {
    fail(`${label} is not valid UTF-8`);
  }
  return decoded;
}

function attestationList(document) {
  if (Array.isArray(document)) return document;
  if (isPlainObject(document) && Array.isArray(document.attestations)) return document.attestations;
  fail('attestation response has no attestations array');
}

export function selectSlsaAttestation(document) {
  const selected = attestationList(document).filter(attestation =>
    isPlainObject(attestation) && attestation.predicateType === SLSA_PREDICATE_TYPE,
  );
  if (selected.length !== 1) {
    fail(`expected exactly one SLSA provenance attestation, found ${selected.length}`);
  }
  return selected[0];
}

export function decodeDssePayload(attestation) {
  if (!isPlainObject(attestation) || !isPlainObject(attestation.bundle) || !isPlainObject(attestation.bundle.dsseEnvelope)) {
    fail('SLSA attestation lacks bundle.dsseEnvelope');
  }
  const payload = strictBase64Decode(attestation.bundle.dsseEnvelope.payload, 'DSSE payload');
  return parseJson(payload.toString('utf8'), 'DSSE payload');
}

function assertRunMetadata(predicate, tag) {
  if (!isPlainObject(predicate.runDetails) || !isPlainObject(predicate.runDetails.builder) || predicate.runDetails.builder.id !== GITHUB_HOSTED_BUILDER_ID) {
    fail('SLSA builder id is not the GitHub-hosted Actions runner');
  }
  const invocationMetadata = predicate.runDetails.metadata;
  if (invocationMetadata !== undefined) {
    if (!isPlainObject(invocationMetadata)) {
      fail('SLSA invocation metadata does not identify the expected repository');
    }
    const invocationId = invocationMetadata.invocationId;
    if (invocationId !== undefined && (typeof invocationId !== 'string' || !invocationId.includes('Yeachan-Heo/oh-my-claudecode'))) {
      fail('SLSA invocation metadata does not identify the expected repository');
    }
  }
  const runDetailsText = stableJson(predicate.runDetails);
  if (runDetailsText.includes('refs/tags/') && !runDetailsText.includes(`refs/tags/${tag}`)) {
    fail('SLSA run metadata identifies a different tag');
  }
}


export function assertSlsaProvenance(payload, { packageName, version, tag, sha, sha512 }) {
  if (!isPlainObject(payload) || payload._type !== IN_TOTO_STATEMENT_TYPE) {
    fail('DSSE payload is not an in-toto Statement v1');
  }
  if (!Array.isArray(payload.subject)) {
    fail('SLSA payload has no subject array');
  }
  const expectedSubjectName = `pkg:npm/${packageName}@${version}`;
  const subjects = payload.subject.filter(subject => isPlainObject(subject) && subject.name === expectedSubjectName);
  if (subjects.length !== 1 || !isPlainObject(subjects[0].digest) || subjects[0].digest.sha512 !== sha512) {
    fail('SLSA subject does not bind the expected package to the archive SHA-512');
  }
  if (!isPlainObject(payload.predicate) || !isPlainObject(payload.predicate.buildDefinition)) {
    fail('SLSA payload has no build definition');
  }
  const buildDefinition = payload.predicate.buildDefinition;
  if (buildDefinition.buildType !== GITHUB_ACTIONS_WORKFLOW_V1_BUILD_TYPE) {
    fail('SLSA build type is not the GitHub Actions workflow v1 build type');
  }

  const workflow = buildDefinition.externalParameters?.workflow;
  if (!isPlainObject(workflow) || workflow.repository !== REPOSITORY_URL || workflow.path !== WORKFLOW_PATH || workflow.ref !== `refs/tags/${tag}`) {
    fail('SLSA workflow repository, path, or ref does not match the release');
  }
  if (!Array.isArray(buildDefinition.resolvedDependencies)) {
    fail('SLSA build definition has no resolvedDependencies');
  }
  const expectedDependencyUri = `git+${REPOSITORY_URL}@refs/tags/${tag}`;
  const dependencies = buildDefinition.resolvedDependencies.filter(dependency =>
    isPlainObject(dependency) && dependency.uri === expectedDependencyUri,
  );
  if (dependencies.length !== 1 || !isPlainObject(dependencies[0].digest) || requireSha(dependencies[0].digest.gitCommit, 'SLSA dependency gitCommit') !== sha) {
    fail('SLSA resolved dependency does not bind the tag to the release SHA');
  }
  assertRunMetadata(payload.predicate, tag);

  return true;
}

function hasCompetingNpmFailure(logText) {
  const npmErrorCode = /\bnpm\s+(?:err!|error)\s+code\s+([a-z][a-z0-9_:-]*)\b/gi;
  for (const match of logText.matchAll(npmErrorCode)) {
    if (match[1].toUpperCase() !== 'TLOG_CREATE_ENTRY_ERROR') return true;
  }
  if (/\b(?:e401|e403|e409|epublishconflict|einvalidpackagename|einvalidtagname|einvalidversion|eintegrity|enetwork|etimedout|econn(?:reset|refused)|enotfound|eai_again)\b/i.test(logText)) {
    return true;
  }
  if (/\b(?:unauthori[sz]ed|forbidden|permission denied|access denied|authentication|auth token|cannot publish over|publish conflict|version already exists|already published|invalid package|invalid tag|invalid version|package validation|network|timed out|connection (?:refused|reset)|fetch failed|integrity|checksum|fatal(?:\s+error)?)\b/i.test(logText)) {
    return true;
  }
  for (const line of logText.split(/\r?\n/)) {
    if (!/\bnpm\s+(?:err!|error)|\bfatal(?:\s+error)?\b/i.test(line)) continue;
    if (/a complete log of this run can be found/i.test(line)) continue;
    if (!/\b(?:tlog_create_entry_error|sigstore|rekor|transparency[-\s]+log|tlog)\b/i.test(line)) return true;
  }
  return false;
}

/** Return one reviewed classifier name, never a truthy generic error match. */
export function classifySigstoreRekorFailure(logText) {
  if (typeof logText !== 'string' || logText.trim() === '' || hasCompetingNpmFailure(logText)) return null;
  const hasTlogCreateEntryError = /\bTLOG_CREATE_ENTRY_ERROR\b/i.test(logText);
  const rekorSigstore = /\b(?:sigstore|rekor)\b[\s\S]{0,160}\b(?:transparency\s+log|tlog)\b/i;
  const tlogRekorSigstore = /\b(?:transparency\s+log|tlog)\b[\s\S]{0,160}\b(?:sigstore|rekor)\b/i;
  const createFailure = /\b(?:create|submit|write)\b[\s\S]{0,80}\b(?:failed|failure|error|unavailable|unreachable|timeout)\b/i;
  const hasSigstoreRekorTransparencyLogFailure = (rekorSigstore.test(logText) || tlogRekorSigstore.test(logText)) && createFailure.test(logText);
  const classifiers = [
    ...(hasTlogCreateEntryError ? ['TLOG_CREATE_ENTRY_ERROR'] : []),
    ...(hasSigstoreRekorTransparencyLogFailure ? ['SIGSTORE_REKOR_TRANSPARENCY_LOG'] : []),
  ];
  return classifiers.length === 1 ? classifiers[0] : null;
}

export function assertSigstoreFallback(publishLogPath) {
  let publishLogText;
  try {
    publishLogText = readFileSync(publishLogPath, 'utf8');
  } catch (error) {
    fail(`cannot read publish log: ${error instanceof Error ? error.message : String(error)}`);
  }
  const classifier = classifySigstoreRekorFailure(publishLogText);
  if (!classifier) {
    fail('publish log does not contain exactly one recognized Sigstore/Rekor transparency-log failure without competing errors');
  }
  return { classifier };
}

function canonicalRegistryUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(requireString(value, label));
  } catch {
    fail(`${label} is not a valid registry URL`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail(`${label} is not a canonical registry URL`);
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}

function selectNpmVerifiedSlsaAttestation(auditPath, { packageName, version, registry }) {
  const report = readJsonFile(requireString(auditPath, 'audit'), 'npm audit signatures report');
  if (!isPlainObject(report) || !Array.isArray(report.invalid) || !Array.isArray(report.missing) || !Array.isArray(report.verified)) {
    fail('npm audit signatures report must contain invalid, missing, and verified arrays');
  }
  if (report.invalid.length !== 0 || report.missing.length !== 0) {
    fail('npm audit signatures report contains invalid or missing signatures');
  }
  const candidates = report.verified.filter(entry =>
    isPlainObject(entry) && entry.name === packageName && entry.version === version,
  );
  if (candidates.length !== 1) {
    fail(`npm audit signatures report must contain exactly one verified ${packageName}@${version} entry`);
  }
  const entry = candidates[0];
  if (canonicalRegistryUrl(entry.registry, 'npm audit verified registry') !== canonicalRegistryUrl(registry, 'expected registry')) {
    fail('npm audit verified registry does not match the expected registry');
  }
  if (!Array.isArray(entry.attestationBundles)) {
    fail('npm audit verified entry has no attestationBundles array');
  }
  return selectSlsaAttestation({ attestations: entry.attestationBundles });
}

function dsseEnvelopeForComparison(attestation, label) {
  if (!isPlainObject(attestation) || !isPlainObject(attestation.bundle) || !isPlainObject(attestation.bundle.dsseEnvelope)) {
    fail(`${label} lacks bundle.dsseEnvelope`);
  }
  const envelope = attestation.bundle.dsseEnvelope;
  strictBase64Decode(envelope.payload, `${label} DSSE payload`);
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0) {
    fail(`${label} has no DSSE signatures`);
  }
  return envelope;
}

function assertMatchingSlsaBundles(npmVerifiedAttestation, registryAttestation) {
  const npmEnvelope = dsseEnvelopeForComparison(npmVerifiedAttestation, 'npm-verified SLSA attestation');
  const registryEnvelope = dsseEnvelopeForComparison(registryAttestation, 'registry SLSA attestation');
  assertDigestEquality(npmEnvelope.payload, registryEnvelope.payload, 'npm-verified and registry SLSA DSSE payload');
  if (stableJson(npmEnvelope.signatures) !== stableJson(registryEnvelope.signatures)) {
    fail('npm-verified and registry SLSA DSSE signatures mismatch');
  }
}

async function fetchAttestationForFallback(url) {
  const response = await fetchBounded(url);
  if (response.status === 404) return null;
  if (response.status !== 200) {
    fail(`attestation endpoint returned HTTP ${response.status} during fallback verification`);
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    fail(`cannot read fallback attestation response: ${error instanceof Error ? error.message : String(error)}`);
  }
  const document = parseJson(text, 'fallback attestation response');
  const attestations = attestationList(document);
  if (attestations.some(attestation => isPlainObject(attestation) && attestation.predicateType === SLSA_PREDICATE_TYPE)) {
    fail('fallback cannot ignore a present SLSA provenance attestation');
  }
  return document;
}

function updateFallbackEvidence(evidencePath, evidence, { classifier, tag, sha }) {
  const workflowRunId = process.env.GITHUB_RUN_ID;
  if (typeof workflowRunId !== 'string' || workflowRunId.trim() === '') {
    fail('GITHUB_RUN_ID is required to record reduced-assurance fallback evidence');
  }
  const updated = {
    ...evidence,
    provenanceMode: 'sigstore-fallback',
    provenance: {
      mode: 'sigstore-fallback',
      classifier,
      assurance: 'reduced',
      workflowRunId,
      tag,
      sourceSha: sha,
      archiveDigests: {
        sha512: evidence.sha512.hex,
        sha256: evidence.sha256,
        sha1: evidence.sha1,
        byteLength: evidence.byteLength,
        npmIntegrity: evidence.npmIntegrity,
        archiveManifest: evidence.archiveManifest.digest,
      },
    },
  };
  writeFileSync(evidencePath, `${stableJson(updated)}\n`, 'utf8');
  return updated;
}

export async function verifyRegistry({ packageName, version, tag, sha, evidencePath, tarballPath, provenance, publishLog, auditPath }) {

  const expectedPackage = requireString(packageName, 'package');
  const expectedVersion = requireVersion(version);
  const expectedTag = requireString(tag, 'tag');
  if (expectedTag !== `v${expectedVersion}`) {
    fail(`tag must equal v${expectedVersion}`);
  }
  const expectedSha = requireSha(sha);
  if (provenance !== 'required' && provenance !== 'sigstore-fallback') {
    fail('provenance must be required or sigstore-fallback');
  }
  if (provenance === 'required') {
    if (publishLog !== undefined) fail('--publish-log is only valid with --provenance sigstore-fallback');
    if (auditPath === undefined) fail('--audit is required for --provenance required');
  } else {
    if (auditPath !== undefined) fail('--audit is only valid with --provenance required');
    if (!publishLog) fail('--publish-log is required for sigstore-fallback');
  }

  const evidence = validateEvidence(
    assertEvidenceFromTarball(
      requireString(tarballPath, 'tarball'),
      evidencePath,
      { allowProvenance: true },
    ),
    {
      packageName: expectedPackage,
      version: expectedVersion,
      sha: expectedSha,
    },
  );
  const base = registryBaseUrl();
  const npmVerifiedAttestation = provenance === 'required'
    ? selectNpmVerifiedSlsaAttestation(auditPath, {
      packageName: expectedPackage,
      version: expectedVersion,
      registry: base,
    })
    : null;

  const encodedPackage = encodePackageName(expectedPackage);
  const encodedVersion = encodeURIComponent(expectedVersion);
  const metadata = await fetchJsonRequired(registryPath(base, `${encodedPackage}/${encodedVersion}`), 'registry version metadata');
  const rootMetadata = await fetchJsonRequired(registryPath(base, encodedPackage), 'registry root metadata');
  const tarballUrl = validateRegistryMetadata(metadata, rootMetadata, {
    packageName: expectedPackage,
    version: expectedVersion,
    sha: expectedSha,
    evidence,
    base,
  });
  const tarballResponse = await fetchBounded(tarballUrl, { headers: { accept: 'application/octet-stream' } });
  if (tarballResponse.status !== 200) {
    fail(`registry tarball returned HTTP ${tarballResponse.status}`);
  }
  let registryTarball;
  try {
    registryTarball = Buffer.from(await tarballResponse.arrayBuffer());
  } catch (error) {
    fail(`cannot read registry tarball: ${error instanceof Error ? error.message : String(error)}`);
  }
  const registryEvidence = buildEvidenceFromBytes(registryTarball, basename(new URL(tarballUrl).pathname));
  assertDigestEquality(registryEvidence.byteLength, evidence.byteLength, 'registry tarball byte length');
  assertDigestEquality(registryEvidence.sha512.hex, evidence.sha512.hex, 'registry tarball SHA-512');
  assertDigestEquality(registryEvidence.sha512.base64, evidence.sha512.base64, 'registry tarball SHA-512 base64');
  assertDigestEquality(registryEvidence.sha256, evidence.sha256, 'registry tarball SHA-256');
  assertDigestEquality(registryEvidence.sha1, evidence.sha1, 'registry tarball SHA-1');
  assertDigestEquality(registryEvidence.npmIntegrity, evidence.npmIntegrity, 'registry tarball npm integrity');
  assertDigestEquality(registryEvidence.archiveManifest.digest, evidence.archiveManifest.digest, 'registry tarball archive manifest');
  assertArchiveEntries(readTarballBytes(registryTarball), {
    packageName: expectedPackage,
    version: expectedVersion,
    gitHead: expectedSha,
  });

  const attestationUrl = registryPath(base, `-/npm/v1/attestations/${encodedPackage}@${encodedVersion}`);
  if (provenance === 'required') {
    const attestationDocument = await fetchJsonRequired(attestationUrl, 'attestation endpoint');
    const registryAttestation = selectSlsaAttestation(attestationDocument);
    assertMatchingSlsaBundles(npmVerifiedAttestation, registryAttestation);
    const payload = decodeDssePayload(npmVerifiedAttestation);
    assertSlsaProvenance(payload, {
      packageName: expectedPackage,
      version: expectedVersion,
      tag: expectedTag,
      sha: expectedSha,
      sha512: evidence.sha512.hex,
    });
    return { provenance: 'required', evidence };
  }


  const { classifier } = assertSigstoreFallback(publishLog);
  await fetchAttestationForFallback(attestationUrl);
  const updatedEvidence = updateFallbackEvidence(evidencePath, evidence, {
    classifier,
    tag: expectedTag,
    sha: expectedSha,
  });
  return { provenance: 'sigstore-fallback', classifier, evidence: updatedEvidence };
}

function parseCliArguments(argv) {
  const [command, ...tokens] = argv;
  if (!command) fail('missing command');
  const flags = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      fail(`unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (name === '' || Object.hasOwn(flags, name)) {
      fail(`invalid or duplicate option: ${token}`);
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`option ${token} requires a value`);
    }
    flags[name] = value;
    index += 1;
  }
  return { command, flags };
}

function requireFlags(flags, requiredNames, optionalNames = []) {
  for (const name of requiredNames) {
    if (!Object.hasOwn(flags, name)) {
      fail(`missing required option --${name}`);
    }
  }
  const allowed = new Set([...requiredNames, ...optionalNames]);
  for (const name of Object.keys(flags)) {
    if (!allowed.has(name)) {
      fail(`unknown option --${name}`);
    }
  }
}

export async function cliMain(argv = process.argv.slice(2)) {
  const { command, flags } = parseCliArguments(argv);
  switch (command) {
    case 'assert-trigger':
      requireFlags(flags, ['tag', 'sha']);
      assertTrigger({ tag: flags.tag, sha: flags.sha });
      break;
    case 'assert-npm-absent':
      requireFlags(flags, ['package', 'version']);
      await assertNpmAbsent(flags.package, flags.version);
      break;
    case 'prepare-stage':
      requireFlags(flags, ['seed-tarball', 'stage', 'git-head']);
      prepareStage(flags['seed-tarball'], flags.stage, flags['git-head']);
      break;
    case 'assert-archive':
      requireFlags(flags, ['tarball', 'version', 'git-head']);
      assertArchive(flags.tarball, { version: flags.version, gitHead: flags['git-head'] });
      break;
    case 'write-evidence':
      requireFlags(flags, ['tarball', 'output']);
      writeEvidence(flags.tarball, flags.output);
      break;
    case 'assert-evidence':
      requireFlags(flags, ['tarball', 'evidence']);
      assertEvidence(flags.tarball, flags.evidence);
      break;
    case 'assert-sigstore-fallback':
      requireFlags(flags, ['publish-log']);
      process.stdout.write(`${assertSigstoreFallback(flags['publish-log']).classifier}\n`);

      break;
    case 'verify-registry':
      requireFlags(flags, ['package', 'version', 'tag', 'sha', 'evidence', 'tarball', 'provenance'], ['publish-log', 'audit']);
      if (flags.provenance === 'required') {
        if (Object.hasOwn(flags, 'publish-log')) fail('--publish-log is only valid with --provenance sigstore-fallback');
        if (!Object.hasOwn(flags, 'audit')) fail('--audit is required with --provenance required');
      }
      if (flags.provenance === 'sigstore-fallback') {
        if (Object.hasOwn(flags, 'audit')) fail('--audit is only valid with --provenance required');
        if (!Object.hasOwn(flags, 'publish-log')) fail('--publish-log is required with --provenance sigstore-fallback');
      }

      await verifyRegistry({
        packageName: flags.package,
        version: flags.version,
        tag: flags.tag,
        sha: flags.sha,
        evidencePath: flags.evidence,
        tarballPath: flags.tarball,
        provenance: flags.provenance,
        publishLog: flags['publish-log'],
        auditPath: flags.audit,
      });
      break;
    default:
      fail(`unknown command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  cliMain().catch(error => {
    process.stderr.write(`release-boundary: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
