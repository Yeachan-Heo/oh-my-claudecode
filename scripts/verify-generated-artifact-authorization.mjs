#!/usr/bin/env node
/**
 * Base-owned verifier for exceptional generated-artifact pull requests.
 *
 * This file is intentionally self-contained. The pull_request_target workflow
 * checks out the event base SHA before invoking it, so neither this verifier
 * nor the manifest can be supplied by the candidate pull request.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..');
const MANIFEST_PATH = join(REPOSITORY_ROOT, '.github', 'generated-artifact-authorizations.json');
const OWNER = 'Yeachan-Heo';
const DEFAULT_BRANCH = 'main';
const API_URL = 'https://api.github.com';
const MAX_PULL_FILES = 3000;
const ALLOWED_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);
const GENERATED_PREFIXES = ['dist/', 'bridge/'];
const FILE_STATUSES = new Set(['added', 'modified', 'removed', 'renamed', 'copied', 'changed']);

export class AuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

function fail(message) {
  throw new AuthorizationError(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer`);
  return value;
}

function requiredNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function requiredSha(value, label) {
  const sha = requiredString(value, label);
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`${label} must be a lowercase 40-character SHA-1`);
  return sha;
}

function assertExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(requiredObject(value, label)).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unexpected or missing fields`);
  }
}

function parseRepository(repository) {
  const value = requiredString(repository, 'repository');
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match) fail('repository must be an owner/name slug');
  return { owner: match[1], name: match[2] };
}

function assertDefaultMainProvenance(environment, repositoryMetadata, repository, owner) {
  const runtime = requiredObject(environment, 'runtime environment');
  if (runtime.githubEventName !== 'pull_request_target') {
    fail('verifier only accepts pull_request_target events');
  }
  if (requiredString(runtime.githubRepository, 'runtime GITHUB_REPOSITORY') !== repository) {
    fail('runtime repository does not match the base-owned authorization manifest');
  }
  if (requiredString(runtime.githubRef, 'runtime GITHUB_REF') !== `refs/heads/${DEFAULT_BRANCH}`) {
    fail(`runtime GITHUB_REF is not refs/heads/${DEFAULT_BRANCH}`);
  }
  requiredSha(runtime.githubSha, 'runtime GITHUB_SHA');

  const metadata = requiredObject(repositoryMetadata, 'live repository metadata');
  if (requiredString(metadata.full_name, 'live repository metadata.full_name') !== repository) {
    fail('live repository metadata repository does not match the protected repository');
  }
  const metadataOwner = requiredObject(metadata.owner, 'live repository metadata.owner');
  if (
    requiredString(metadataOwner.login, 'live repository metadata.owner.login') !== owner
  ) {
    fail('live repository metadata owner does not match the protected owner');
  }
  if (requiredString(metadata.default_branch, 'live repository metadata.default_branch') !== DEFAULT_BRANCH) {
    fail(`live repository metadata default branch is not ${DEFAULT_BRANCH}`);
  }
}

export function readDetachedCheckoutHead(repositoryRoot = REPOSITORY_ROOT) {
  const root = resolve(requiredString(repositoryRoot, 'verifier repository root'));
  let head;
  try {
    head = readFileSync(join(root, '.git', 'HEAD'), 'utf8');
  } catch {
    fail('checked-out base .git/HEAD is unreadable');
  }
  if (!/^[0-9a-f]{40}\n$/.test(head)) {
    fail('checked-out base .git/HEAD is not a detached lowercase 40-character SHA-1');
  }
  return head.slice(0, -1);
}

function isGeneratedPath(filename) {
  return GENERATED_PREFIXES.some(prefix => filename.startsWith(prefix));
}

function recordTouchesGeneratedPath(record) {
  return (
    isGeneratedPath(record.filename) ||
    (record.previousFilename !== null && isGeneratedPath(record.previousFilename))
  );
}

function compareRecords(left, right) {
  for (const key of ['filename', 'status', 'sha', 'previousFilename']) {
    const a = left[key] ?? '';
    const b = right[key] ?? '';
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

function assertSafeRepositoryPath(filename, label) {
  const path = requiredString(filename, label);
  if (
    path.includes('\u0000') ||
    path.startsWith('/') ||
    path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    fail(`${label} is not a canonical repository path`);
  }
  return path;
}

function canonicalRecord(status, filename, sha, previousFilename, label) {
  if (!FILE_STATUSES.has(status)) fail(`${label}.status is not a supported GitHub file status`);
  const canonicalFilename = assertSafeRepositoryPath(filename, `${label}.filename`);
  const canonicalSha = requiredSha(sha, `${label}.sha`);

  if (status === 'renamed' || status === 'copied') {
    return {
      status,
      filename: canonicalFilename,
      sha: canonicalSha,
      previousFilename: assertSafeRepositoryPath(previousFilename, `${label}.previousFilename`),
    };
  }

  if (previousFilename !== null && previousFilename !== undefined) {
    fail(`${label}.previousFilename is only allowed for renamed or copied files`);
  }

  return { status, filename: canonicalFilename, sha: canonicalSha, previousFilename: null };
}

function sortAndAssertUnique(records, label) {
  const sorted = [...records].sort(compareRecords);
  const filenames = new Set();
  for (const record of sorted) {
    if (filenames.has(record.filename)) fail(`${label} contains duplicate filenames`);
    filenames.add(record.filename);
  }
  return sorted;
}

/**
 * Converts fully paginated GitHub pull-file records into the stable,
 * base-owned representation hashed by the authorization manifest.
 */
export function canonicalizeChangedFiles(files, label = 'changed files') {
  if (!Array.isArray(files)) fail(`${label} must be an array`);
  const records = files.map((file, index) => {
    const value = requiredObject(file, `${label}[${index}]`);
    const status = requiredString(value.status, `${label}[${index}].status`);
    const previousFilename = Object.hasOwn(value, 'previous_filename')
      ? value.previous_filename
      : null;
    return canonicalRecord(status, value.filename, value.sha, previousFilename, `${label}[${index}]`);
  });
  return sortAndAssertUnique(records, label);
}

/**
 * Validates canonical manifest records without accepting API-shaped aliases.
 */
export function canonicalizeAuthorizedRecords(records, label = 'authorized generated files') {
  if (!Array.isArray(records)) fail(`${label} must be an array`);
  const canonical = records.map((record, index) => {
    const value = requiredObject(record, `${label}[${index}]`);
    assertExactKeys(value, ['status', 'filename', 'sha', 'previousFilename'], `${label}[${index}]`);
    return canonicalRecord(
      requiredString(value.status, `${label}[${index}].status`),
      value.filename,
      value.sha,
      value.previousFilename,
      `${label}[${index}]`,
    );
  });
  return sortAndAssertUnique(canonical, label);
}

export function canonicalizeGeneratedFiles(files, label = 'changed files') {
  return canonicalizeChangedFiles(files, label).filter(recordTouchesGeneratedPath);
}

export function calculateGeneratedDelta(records) {
  const canonical = canonicalizeAuthorizedRecords(records, 'generated delta records');
  const serialized = JSON.stringify(canonical);
  return {
    count: canonical.length,
    sha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
  };
}

function recordsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateAuthorizationManifest(manifest) {
  assertExactKeys(manifest, ['schemaVersion', 'repository', 'owner', 'authorizations'], 'authorization manifest');
  if (manifest.schemaVersion !== 1) fail('authorization manifest has an unsupported schema version');

  const repository = requiredString(manifest.repository, 'authorization manifest.repository');
  const { owner } = parseRepository(repository);
  if (manifest.owner !== owner || manifest.owner !== OWNER) {
    fail('authorization manifest owner is not the protected repository owner');
  }
  if (!Array.isArray(manifest.authorizations)) fail('authorization manifest.authorizations must be an array');

  const seenPullNumbers = new Set();
  const authorizations = manifest.authorizations.map((entry, index) => {
    const label = `authorization manifest.authorizations[${index}]`;
    assertExactKeys(
      entry,
      ['pullNumber', 'targetRef', 'mergeBaseSha', 'headSha', 'owner', 'generatedDelta', 'generatedFiles'],
      label,
    );
    const pullNumber = requiredPositiveInteger(entry.pullNumber, `${label}.pullNumber`);
    if (seenPullNumbers.has(pullNumber)) fail('authorization manifest contains duplicate pull numbers');
    seenPullNumbers.add(pullNumber);

    const targetRef = requiredString(entry.targetRef, `${label}.targetRef`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(targetRef) || targetRef.includes('..')) {
      fail(`${label}.targetRef is not a canonical ref name`);
    }
    const mergeBaseSha = requiredSha(entry.mergeBaseSha, `${label}.mergeBaseSha`);
    const headSha = requiredSha(entry.headSha, `${label}.headSha`);
    if (entry.owner !== manifest.owner) fail(`${label}.owner does not match the manifest owner`);

    assertExactKeys(entry.generatedDelta, ['count', 'sha256'], `${label}.generatedDelta`);
    const generatedDelta = {
      count: requiredPositiveInteger(entry.generatedDelta.count, `${label}.generatedDelta.count`),
      sha256: requiredString(entry.generatedDelta.sha256, `${label}.generatedDelta.sha256`),
    };
    if (!/^[0-9a-f]{64}$/.test(generatedDelta.sha256)) {
      fail(`${label}.generatedDelta.sha256 must be a lowercase SHA-256 digest`);
    }

    const generatedFiles = canonicalizeAuthorizedRecords(entry.generatedFiles, `${label}.generatedFiles`);
    const calculatedDelta = calculateGeneratedDelta(generatedFiles);
    if (
      calculatedDelta.count !== generatedDelta.count ||
      calculatedDelta.sha256 !== generatedDelta.sha256
    ) {
      fail(`${label} generated file closure does not match its count and digest`);
    }

    return { pullNumber, targetRef, mergeBaseSha, headSha, owner: entry.owner, generatedDelta, generatedFiles };
  });

  return { schemaVersion: 1, repository, owner: manifest.owner, authorizations };
}

function eventIdentity(event, repository, owner) {
  const payload = requiredObject(event, 'event');
  if (!ALLOWED_ACTIONS.has(payload.action)) fail('event action is not an allowed pull_request_target action');
  if (requiredPositiveInteger(payload.number, 'event.number') !== payload.number) fail('event.number is invalid');

  const eventRepository = requiredObject(payload.repository, 'event.repository');
  if (eventRepository.full_name !== repository) fail('event repository does not match the protected repository');
  if (requiredObject(eventRepository.owner, 'event.repository.owner').login !== owner) {
    fail('event repository owner does not match the protected owner');
  }

  const pull = requiredObject(payload.pull_request, 'event.pull_request');
  const base = requiredObject(pull.base, 'event.pull_request.base');
  const head = requiredObject(pull.head, 'event.pull_request.head');
  const user = requiredObject(pull.user, 'event.pull_request.user');
  const baseRepository = requiredObject(base.repo, 'event.pull_request.base.repo');
  const headRepository = requiredObject(head.repo, 'event.pull_request.head.repo');
  if (requiredString(baseRepository.full_name, 'event.pull_request.base.repo.full_name') !== repository) {
    fail('event pull request base repository does not match the protected repository');
  }

  return {
    pullNumber: payload.number,
    baseRef: requiredString(base.ref, 'event.pull_request.base.ref'),
    baseSha: requiredSha(base.sha, 'event.pull_request.base.sha'),
    headSha: requiredSha(head.sha, 'event.pull_request.head.sha'),
    headRepository: requiredString(headRepository.full_name, 'event.pull_request.head.repo.full_name'),
    authorLogin: requiredString(user.login, 'event.pull_request.user.login'),
    authorAssociation: requiredString(pull.author_association, 'event.pull_request.author_association'),
  };
}

function livePullIdentity(livePull, repository) {
  const pull = requiredObject(livePull, 'live pull request');
  const base = requiredObject(pull.base, 'live pull request.base');
  const head = requiredObject(pull.head, 'live pull request.head');
  const user = requiredObject(pull.user, 'live pull request.user');
  const baseRepository = requiredObject(base.repo, 'live pull request.base.repo');
  const headRepository = requiredObject(head.repo, 'live pull request.head.repo');

  return {
    pullNumber: requiredPositiveInteger(pull.number, 'live pull request.number'),
    baseRef: requiredString(base.ref, 'live pull request.base.ref'),
    baseSha: requiredSha(base.sha, 'live pull request.base.sha'),
    baseRepository: requiredString(baseRepository.full_name, 'live pull request.base.repo.full_name'),
    headSha: requiredSha(head.sha, 'live pull request.head.sha'),
    headRepository: requiredString(headRepository.full_name, 'live pull request.head.repo.full_name'),
    authorLogin: requiredString(user.login, 'live pull request.user.login'),
    authorAssociation: requiredString(pull.author_association, 'live pull request.author_association'),
    changedFiles: requiredNonNegativeInteger(pull.changed_files, 'live pull request.changed_files'),
  };
}

function assertLiveEventCoherence(eventData, liveData, repository) {
  if (
    liveData.pullNumber !== eventData.pullNumber ||
    liveData.baseRef !== eventData.baseRef ||
    liveData.baseSha !== eventData.baseSha ||
    liveData.headSha !== eventData.headSha ||
    liveData.headRepository !== eventData.headRepository ||
    liveData.baseRepository !== repository
  ) {
    fail('event identity is stale or ref-confused relative to the live pull request');
  }
}

function assertCompareBaseAndGetMergeBase(compare, expectedBaseSha) {
  const response = requiredObject(compare, 'compare response');
  const base = requiredObject(response.base_commit, 'compare response.base_commit');
  if (requiredSha(base.sha, 'compare response.base_commit.sha') !== expectedBaseSha) {
    fail('compare base does not match the exact live base SHA');
  }
  const mergeBase = requiredObject(response.merge_base_commit, 'compare response.merge_base_commit');
  return requiredSha(mergeBase.sha, 'compare response.merge_base_commit.sha');
}

function assertOwnerCommitSignature(commit, signature, headSha, owner) {
  const commitResponse = requiredObject(commit, 'head commit response');
  if (requiredSha(commitResponse.sha, 'head commit response.sha') !== headSha) {
    fail('head commit response does not match the exact live head SHA');
  }

  const restCommit = requiredObject(commitResponse.commit, 'head commit response.commit');
  const verification = requiredObject(restCommit.verification, 'head commit response.commit.verification');
  if (verification.verified !== true) fail('GitHub REST does not verify the exact head signature');
  if (requiredObject(commitResponse.author, 'head commit response.author').login !== owner) {
    fail('GitHub REST head commit author is not the protected owner');
  }

  const graphCommit = requiredObject(signature, 'GitHub GraphQL commit signature');
  if (requiredSha(graphCommit.oid, 'GitHub GraphQL commit signature.oid') !== headSha) {
    fail('GitHub GraphQL signature is not for the exact live head SHA');
  }
  const graphSignature = requiredObject(graphCommit.signature, 'GitHub GraphQL commit signature.signature');
  if (graphSignature.isValid !== true) fail('GitHub GraphQL does not verify the exact head signature');
  if (requiredObject(graphSignature.signer, 'GitHub GraphQL commit signature.signer').login !== owner) {
    fail('GitHub GraphQL signature signer is not the protected owner');
  }
}

/**
 * Pure authorization decision. All inputs are base-owned or GitHub API data;
 * callers must not pass candidate checkout data to this function.
 */
export function authorizeGeneratedArtifactPullRequest({
  event,
  environment,
  manifest,
  repositoryMetadata,
  checkedOutBaseSha,
  livePull,
  compare,
  commit,
  signature,
  files,
}) {
  const trustedManifest = validateAuthorizationManifest(manifest);
  assertDefaultMainProvenance(
    environment,
    repositoryMetadata,
    trustedManifest.repository,
    trustedManifest.owner,
  );

  const eventData = eventIdentity(event, trustedManifest.repository, trustedManifest.owner);
  const liveData = livePullIdentity(livePull, trustedManifest.repository);
  assertLiveEventCoherence(eventData, liveData, trustedManifest.repository);
  if (requiredSha(checkedOutBaseSha, 'checked-out base SHA') !== eventData.baseSha) {
    fail('checked-out base SHA does not match the exact event/live pull request base SHA');
  }

  if (liveData.changedFiles > MAX_PULL_FILES) {
    fail('live pull request exceeds GitHub\'s fully enumerable pull-file limit');
  }
  const liveFiles = canonicalizeChangedFiles(files, 'live pull request files');
  if (liveFiles.length !== liveData.changedFiles) {
    fail('live pull request file list is malformed or truncated');
  }
  const compareMergeBaseSha = assertCompareBaseAndGetMergeBase(compare, liveData.baseSha);

  const generatedFiles = liveFiles.filter(recordTouchesGeneratedPath);
  if (generatedFiles.length === 0) {
    return {
      requiresAuthorization: false,
      pullNumber: eventData.pullNumber,
      generatedDelta: { count: 0, sha256: null },
    };
  }

  const authorization = trustedManifest.authorizations.find(entry => entry.pullNumber === eventData.pullNumber);
  if (!authorization) fail('generated changes have no base-owned authorization entry');
  if (
    authorization.targetRef !== eventData.baseRef ||
    authorization.targetRef !== liveData.baseRef ||
    authorization.headSha !== eventData.headSha ||
    authorization.headSha !== liveData.headSha
  ) {
    fail('generated changes do not match the authorized PR/target/head identity');
  }
  if (authorization.mergeBaseSha !== compareMergeBaseSha) {
    fail('compare merge base does not match the authorized merge base SHA');
  }
  if (
    eventData.headRepository !== trustedManifest.repository ||
    liveData.headRepository !== trustedManifest.repository
  ) {
    fail('generated changes from a fork are never authorized');
  }
  if (
    eventData.authorAssociation !== 'OWNER' ||
    liveData.authorAssociation !== 'OWNER' ||
    eventData.authorLogin !== trustedManifest.owner ||
    liveData.authorLogin !== trustedManifest.owner
  ) {
    fail('generated changes require the protected owner as the pull request author');
  }

  assertOwnerCommitSignature(commit, signature, liveData.headSha, trustedManifest.owner);

  const generatedDelta = calculateGeneratedDelta(generatedFiles);
  if (
    generatedDelta.count !== authorization.generatedDelta.count ||
    generatedDelta.sha256 !== authorization.generatedDelta.sha256 ||
    !recordsEqual(generatedFiles, authorization.generatedFiles)
  ) {
    fail('generated changes fall outside the base-owned authorized closure');
  }

  return {
    requiresAuthorization: true,
    pullNumber: eventData.pullNumber,
    generatedDelta,
  };
}

export function evaluateGeneratedArtifactAuthorization(input) {
  try {
    return { allowed: true, decision: authorizeGeneratedArtifactPullRequest(input) };
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : 'unknown authorization failure',
    };
  }
}

function apiPath(repository, suffix) {
  const { owner, name } = parseRepository(repository);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`;
}

function requiredToken(token) {
  return requiredString(token, 'GITHUB_TOKEN');
}

export function createGitHubApiClient({ token, fetchImpl = globalThis.fetch }) {
  const bearerToken = requiredToken(token);
  if (typeof fetchImpl !== 'function') fail('global fetch is unavailable');

  async function request(path, options = {}) {
    const response = await fetchImpl(`${API_URL}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${bearerToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers ?? {}),
      },
    });
    if (!response || response.ok !== true) {
      fail(`GitHub API request failed for ${path}`);
    }
    try {
      return await response.json();
    } catch {
      fail(`GitHub API returned malformed JSON for ${path}`);
    }
  }

  return {
    get(path) {
      return request(path, { method: 'GET' });
    },
    graphql(query, variables) {
      return request('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
    },
  };
}

export async function fetchCompletePullFiles(api, repository, pullNumber, expectedCount) {
  const count = requiredNonNegativeInteger(expectedCount, 'expected pull file count');
  if (count > MAX_PULL_FILES) fail('live pull request exceeds GitHub\'s fully enumerable pull-file limit');

  const pages = Math.ceil(count / 100);
  const files = [];
  for (let page = 1; page <= pages; page += 1) {
    const pageFiles = await api.get(apiPath(repository, `/pulls/${pullNumber}/files?per_page=100&page=${page}`));
    if (!Array.isArray(pageFiles)) fail('GitHub pull file page is malformed');
    const expectedPageLength = page === pages ? count - files.length : 100;
    if (pageFiles.length !== expectedPageLength) fail('GitHub pull file page is truncated or inconsistent');
    files.push(...pageFiles);
  }

  const overflow = await api.get(apiPath(repository, `/pulls/${pullNumber}/files?per_page=100&page=${pages + 1}`));
  if (!Array.isArray(overflow) || overflow.length !== 0) {
    fail('GitHub pull file pagination is truncated or inconsistent');
  }
  return files;
}

const SIGNATURE_QUERY = `query ExactHeadSignature($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expression) {
      ... on Commit {
        oid
        signature {
          isValid
          signer {
            login
          }
        }
      }
    }
  }
}`;

export async function verifyLiveGeneratedArtifactAuthorization({ event, manifest, environment, token, fetchImpl }) {
  const trustedManifest = validateAuthorizationManifest(manifest);
  const checkedOutBaseSha = readDetachedCheckoutHead();
  const api = createGitHubApiClient({ token, fetchImpl });
  const repositoryMetadata = await api.get(apiPath(trustedManifest.repository, ''));
  const eventData = eventIdentity(event, trustedManifest.repository, trustedManifest.owner);
  const livePull = await api.get(apiPath(trustedManifest.repository, `/pulls/${eventData.pullNumber}`));
  const liveData = livePullIdentity(livePull, trustedManifest.repository);
  assertLiveEventCoherence(eventData, liveData, trustedManifest.repository);

  const files = await fetchCompletePullFiles(api, trustedManifest.repository, eventData.pullNumber, liveData.changedFiles);
  // Compare is queried only for the exact base and merge-base identity. Its files
  // array is capped independently, so only fully paginated pull files are authoritative.
  const compare = await api.get(
    apiPath(
      trustedManifest.repository,
      `/compare/${encodeURIComponent(liveData.baseSha)}...${encodeURIComponent(liveData.headSha)}?per_page=1&page=1`,
    ),
  );
  const commit = await api.get(apiPath(trustedManifest.repository, `/commits/${encodeURIComponent(liveData.headSha)}`));

  const { owner, name } = parseRepository(trustedManifest.repository);
  const graphResponse = await api.graphql(SIGNATURE_QUERY, {
    owner,
    name,
    expression: liveData.headSha,
  });
  if (!isObject(graphResponse) || !isObject(graphResponse.data) || !isObject(graphResponse.data.repository)) {
    fail('GitHub GraphQL signature response is malformed');
  }
  if (Array.isArray(graphResponse.errors) && graphResponse.errors.length > 0) {
    fail('GitHub GraphQL signature response contains errors');
  }

  const decision = authorizeGeneratedArtifactPullRequest({
    event,
    environment,
    manifest: trustedManifest,
    repositoryMetadata,
    checkedOutBaseSha,
    livePull,
    compare,
    commit,
    signature: graphResponse.data.repository.object,
    files,
  });

  // Close the observable push-race window before reporting authorization.
  const finalLivePull = await api.get(apiPath(trustedManifest.repository, `/pulls/${eventData.pullNumber}`));
  const finalLiveData = livePullIdentity(finalLivePull, trustedManifest.repository);
  assertLiveEventCoherence(eventData, finalLiveData, trustedManifest.repository);
  return decision;
}

export function loadBaseOwnedManifest(manifestPath = MANIFEST_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('base-owned authorization manifest is unreadable or malformed JSON');
  }
  return validateAuthorizationManifest(parsed);
}

async function main() {
  const eventPath = requiredString(process.env.GITHUB_EVENT_PATH, 'GITHUB_EVENT_PATH');
  let event;
  try {
    event = JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch {
    fail('GitHub event payload is unreadable or malformed JSON');
  }

  const decision = await verifyLiveGeneratedArtifactAuthorization({
    event,
    manifest: loadBaseOwnedManifest(),
    environment: {
      githubEventName: process.env.GITHUB_EVENT_NAME,
      githubRepository: process.env.GITHUB_REPOSITORY,
      githubRef: process.env.GITHUB_REF,
      githubSha: process.env.GITHUB_SHA,
    },
    token: process.env.GITHUB_TOKEN,
  });
  const prefix = decision.requiresAuthorization ? 'authorized generated delta' : 'no generated changes';
  console.log(`${prefix}: PR #${decision.pullNumber}`);
}

const entrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entrypoint) {
  main().catch(error => {
    console.error(`generated-artifact authorization failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
