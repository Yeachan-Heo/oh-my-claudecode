import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'Yeachan-Heo/oh-my-claudecode';
const OWNER = 'Yeachan-Heo';
const MERGE_BASE_SHA = '761ed112868072c2bc5866f5b0dbe5b0dda114c2';
const LIVE_BASE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '8065c11a32e58b4dd2e44b2c768e0d37fb4f4b86';
const PULL_NUMBER = 3479;
const ROOT = process.cwd();
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'generated-artifact-authorization.yml');
const MANIFEST_PATH = join(ROOT, '.github', 'generated-artifact-authorizations.json');
const VERIFIER_PATH = join(ROOT, 'scripts', 'verify-generated-artifact-authorization.mjs');

type CanonicalRecord = {
  status: string;
  filename: string;
  sha: string;
  previousFilename: string | null;
};

type Manifest = {
  schemaVersion: number;
  repository: string;
  owner: string;
  authorizations: Array<{
    pullNumber: number;
    targetRef: string;
    mergeBaseSha: string;
    headSha: string;
    owner: string;
    generatedDelta: { count: number; sha256: string };
    generatedFiles: CanonicalRecord[];
  }>;
};

type Evaluation = { allowed: boolean; reason?: string; decision?: Record<string, unknown> };

type ApiFile = {
  status: string;
  filename: string;
  sha: string;
  previous_filename?: string;
};

type MutableInput = {
  environment: {
    githubEventName: string;
    githubRepository: string;
    githubRef: string;
    githubSha: string;
  };
  manifest: Manifest;
  repositoryMetadata: { full_name: string; owner: { login: string }; default_branch: string };
  checkedOutBaseSha: string;
  event: {
    action: string;
    number: number;
    repository: { full_name: string; owner: { login: string } };
    pull_request: {
      base: { ref: string; sha: string; repo: { full_name: string } };
      head: { sha: string; repo: { full_name: string } };
      user: { login: string };
      author_association: string;
    };
  };
  livePull: {
    number: number;
    base: { ref: string; sha: string; repo: { full_name: string } };
    head: { sha: string; repo: { full_name: string } };
    user: { login: string };
    author_association: string;
    changed_files: number;
  };
  compare: {
    base_commit: { sha: string };
    merge_base_commit: { sha: string };
    files?: unknown;
  };
  commit: { sha: string; commit: { verification: { verified: boolean } }; author: { login: string } };
  signature: { oid: string; signature: { isValid: boolean; signer: { login: string } } };
  files: ApiFile[];
};

type VerifierModule = {
  calculateGeneratedDelta(records: CanonicalRecord[]): { count: number; sha256: string };
  evaluateGeneratedArtifactAuthorization(input: unknown): Evaluation;
  validateAuthorizationManifest(manifest: unknown): unknown;
  readDetachedCheckoutHead(repositoryRoot: string): string;
  fetchCompletePullFiles(
    api: { get(path: string): Promise<unknown> },
    repository: string,
    pullNumber: number,
    expectedCount: number,
  ): Promise<unknown[]>;
};


const verifier = (await import(pathToFileURL(VERIFIER_PATH).href)) as unknown as VerifierModule;
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
const exactAuthorization = (() => {
  const authorization = manifest.authorizations.find(entry => entry.pullNumber === PULL_NUMBER);
  if (!authorization) throw new Error('Missing exact #3479 base-owned authorization fixture');
  return authorization;
})();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function apiFiles(records = exactAuthorization.generatedFiles): ApiFile[] {
  return records.map(record => ({
    status: record.status,
    filename: record.filename,
    sha: record.sha,
    ...(record.previousFilename === null ? {} : { previous_filename: record.previousFilename }),
  }));
}

function authorizedInput(): MutableInput {
  const files = apiFiles();
  return {
    environment: {
      githubEventName: 'pull_request_target',
      githubRepository: REPOSITORY,
      githubRef: 'refs/heads/main',
      githubSha: 'a'.repeat(40),
    },
    manifest: clone(manifest),
    repositoryMetadata: {
      full_name: REPOSITORY,
      owner: { login: OWNER },
      default_branch: 'main',
    },
    checkedOutBaseSha: LIVE_BASE_SHA,
    event: {
      action: 'synchronize',
      number: PULL_NUMBER,
      repository: { full_name: REPOSITORY, owner: { login: OWNER } },
      pull_request: {
        base: { ref: 'dev', sha: LIVE_BASE_SHA, repo: { full_name: REPOSITORY } },
        head: { sha: HEAD_SHA, repo: { full_name: REPOSITORY } },
        user: { login: OWNER },
        author_association: 'OWNER',
      },
    },
    livePull: {
      number: PULL_NUMBER,
      base: { ref: 'dev', sha: LIVE_BASE_SHA, repo: { full_name: REPOSITORY } },
      head: { sha: HEAD_SHA, repo: { full_name: REPOSITORY } },
      user: { login: OWNER },
      author_association: 'OWNER',
      changed_files: files.length,
    },
    compare: {
      base_commit: { sha: LIVE_BASE_SHA },
      merge_base_commit: { sha: MERGE_BASE_SHA },
    },
    commit: {
      sha: HEAD_SHA,
      commit: { verification: { verified: true } },
      author: { login: OWNER },
    },
    signature: {
      oid: HEAD_SHA,
      signature: { isValid: true, signer: { login: OWNER } },
    },
    files,
  };
}

function expectDenied(mutate: (input: MutableInput) => void, reason: string) {
  const input = authorizedInput();
  mutate(input);
  const result = verifier.evaluateGeneratedArtifactAuthorization(input);
  expect(result.allowed).toBe(false);
  expect(result.reason).toContain(reason);
}


describe('generated-artifact base trust root workflow', () => {
  it('uses only a base-owned pull_request_target checkout and minimal read-only authority', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

    expect(workflow).toMatch(
      /^on:\n\x20{2}pull_request_target:\n\x20{4}branches: \[dev\]\n\x20{4}types: \[opened, synchronize, reopened\]$/m,
    );
    expect(workflow).not.toMatch(/^\x20{2}pull_request:/m);
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('pull-requests: read');
    expect(workflow).not.toMatch(/\b(?:write|id-token|issues|checks|actions):/);
    expect(workflow).toContain('timeout-minutes: 5');
    expect(workflow).toContain('uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683');
    expect(workflow).toContain('ref: ${{ github.event.pull_request.base.sha }}');
    expect(workflow).toContain('path: trusted-base');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('fetch-depth: 1');
    expect(workflow).toContain('sparse-checkout: |');
    expect(workflow).toContain('.github/generated-artifact-authorizations.json');
    expect(workflow).toContain('scripts/verify-generated-artifact-authorization.mjs');
    expect(workflow).toContain('sparse-checkout-cone-mode: false');
    expect(workflow).toContain('working-directory: trusted-base');
    expect(workflow).toContain('node scripts/verify-generated-artifact-authorization.mjs');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ github.token }}');
    expect(workflow).not.toContain('actions/setup-node');
    expect(workflow).not.toMatch(/\b(?:npm|cache):/);
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toMatch(/github\.event\.pull_request\.head\.(?:sha|ref)/);
    expect(workflow).not.toMatch(/github\.(?:sha|head_ref|ref)/);
    expect(workflow).not.toMatch(/^\s+run: (?!node scripts\/verify-generated-artifact-authorization\.mjs$)/m);
  });

  it('documents that a dev-targeted prerequisite is inert until promotion to default main', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

    expect(workflow).toContain('workflow bytes from the default branch, main');
    expect(workflow).toMatch(/cannot\s*\n# activate or authorize itself until this exact workflow is promoted to main/);
    expect(workflow).toContain('GITHUB_REF is refs/heads/main');
    expect(workflow).toContain('branches: [dev]');
  });

  it('is immune to candidate workflow and checker replacement because the trusted workflow checks out only base bytes', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
    const candidateWorkflow = [
      'on: pull_request',
      'jobs:',
      '  bypass:',
      '    steps:',
      '      - run: node scripts/candidate-checker.mjs',
    ].join('\n');

    expect(candidateWorkflow).toContain('candidate-checker.mjs');
    expect(workflow).not.toContain('candidate-checker.mjs');
    expect(workflow).not.toContain('actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}');
    expect(workflow).toContain('ref: ${{ github.event.pull_request.base.sha }}');
    expect(workflow).toContain('node scripts/verify-generated-artifact-authorization.mjs');
    const verifierSource = readFileSync(VERIFIER_PATH, 'utf8');
    expect(verifierSource).toMatch(/from 'node:/);
    expect(verifierSource).not.toMatch(/from ['"](?!node:)/);
    expect(verifierSource).not.toMatch(/(?:execFile|execSync|spawn|child_process)/);
    expect(verifierSource).toContain('const checkedOutBaseSha = readDetachedCheckoutHead();');
    expect(verifierSource).toContain("const repositoryMetadata = await api.get(apiPath(trustedManifest.repository, ''));");
    expect(verifierSource).toContain('?per_page=1&page=1');
    expect(verifierSource).not.toContain('compare response.files');
  });
});

describe('generated-artifact base-owned authorization decision', () => {
  it('contains the exact independently derived #3479 closure and allows only its exact positive case', () => {
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      repository: REPOSITORY,
      owner: OWNER,
    });
    expect(exactAuthorization).toMatchObject({
      pullNumber: PULL_NUMBER,
      targetRef: 'dev',
      mergeBaseSha: MERGE_BASE_SHA,
      headSha: HEAD_SHA,
      owner: OWNER,
      generatedDelta: {
        count: 55,
        sha256: '71ab926f799a6ad1ae2fc0baf7a41203ee7f6bcfc7973d590e8b7dbfe063823d',
      },
    });
    expect(verifier.calculateGeneratedDelta(exactAuthorization.generatedFiles)).toEqual(exactAuthorization.generatedDelta);
    expect(verifier.validateAuthorizationManifest(manifest)).toBeTruthy();
    expect(LIVE_BASE_SHA).not.toBe(MERGE_BASE_SHA);

    expect(verifier.evaluateGeneratedArtifactAuthorization(authorizedInput())).toEqual({
      allowed: true,
      decision: {
        requiresAuthorization: true,
        pullNumber: PULL_NUMBER,
        generatedDelta: exactAuthorization.generatedDelta,
      },
    });
  });

  it('allows ordinary contributor pull requests with no generated changes and no authorization entry', () => {
    const input = authorizedInput();
    const sourceFile = { status: 'modified', filename: 'src/index.ts', sha: 'a'.repeat(40) };
    input.event.pull_request.head.repo.full_name = 'contributor/oh-my-claudecode';
    input.event.pull_request.user.login = 'contributor';
    input.event.pull_request.author_association = 'CONTRIBUTOR';
    input.livePull.head.repo.full_name = 'contributor/oh-my-claudecode';
    input.livePull.user.login = 'contributor';
    input.livePull.author_association = 'CONTRIBUTOR';
    input.livePull.changed_files = 1;
    input.files = [sourceFile];

    expect(verifier.evaluateGeneratedArtifactAuthorization(input)).toEqual({
      allowed: true,
      decision: {
        requiresAuthorization: false,
        pullNumber: PULL_NUMBER,
        generatedDelta: { count: 0, sha256: null },
      },
    });
  });

  it('requires default-main runtime and live repository provenance before every decision', () => {
    expectDenied(input => {
      input.environment.githubRef = 'refs/heads/dev';
    }, 'runtime GITHUB_REF');
    expectDenied(input => {
      input.environment.githubSha = 'A'.repeat(40);
    }, 'runtime GITHUB_SHA');
    expectDenied(input => {
      input.repositoryMetadata.default_branch = 'dev';
    }, 'default branch is not main');
    expectDenied(input => {
      input.repositoryMetadata.full_name = 'attacker/oh-my-claudecode';
    }, 'metadata repository');
    expectDenied(input => {
      input.repositoryMetadata.owner.login = 'attacker';
    }, 'metadata owner');
  });

  it('rejects symbolic, unreadable, and wrong detached checkout heads', () => {
    const checkoutRoot = mkdtempSync(join(tmpdir(), 'generated-artifact-authorization-'));
    const gitDirectory = join(checkoutRoot, '.git');
    mkdirSync(gitDirectory);
    try {
      writeFileSync(join(gitDirectory, 'HEAD'), `${LIVE_BASE_SHA}\n`);
      const exactCheckedOutBaseSha = verifier.readDetachedCheckoutHead(checkoutRoot);
      expect(exactCheckedOutBaseSha).toBe(LIVE_BASE_SHA);
      const exactCheckoutInput = authorizedInput();
      exactCheckoutInput.checkedOutBaseSha = exactCheckedOutBaseSha;
      expect(verifier.evaluateGeneratedArtifactAuthorization(exactCheckoutInput)).toMatchObject({ allowed: true });

      writeFileSync(join(gitDirectory, 'HEAD'), 'ref: refs/heads/main\n');
      expect(() => verifier.readDetachedCheckoutHead(checkoutRoot)).toThrow('not a detached');
      expect(() => verifier.readDetachedCheckoutHead(join(checkoutRoot, 'missing'))).toThrow('unreadable');

      writeFileSync(join(gitDirectory, 'HEAD'), `${'b'.repeat(40)}\n`);
      const wrongCheckedOutBaseSha = verifier.readDetachedCheckoutHead(checkoutRoot);
      expect(wrongCheckedOutBaseSha).toBe('b'.repeat(40));
      expectDenied(input => {
        input.checkedOutBaseSha = wrongCheckedOutBaseSha;
      }, 'checked-out base SHA does not match');
    } finally {
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it('rejects stale or ref-confused live/event base and head identities', () => {
    expectDenied(input => {
      input.livePull.head.sha = 'b'.repeat(40);
    }, 'stale or ref-confused');
    expectDenied(input => {
      input.livePull.base.sha = 'b'.repeat(40);
    }, 'stale or ref-confused');
    expectDenied(input => {
      input.event.pull_request.base.sha = 'b'.repeat(40);
    }, 'stale or ref-confused');
  });

  it('uses compare only for base and merge-base identity, never its capped files array', () => {
    const omittedCompareFiles = authorizedInput();
    expect(verifier.evaluateGeneratedArtifactAuthorization(omittedCompareFiles)).toMatchObject({ allowed: true });

    const hiddenCompareFiles = authorizedInput();
    hiddenCompareFiles.compare.files = [];
    expect(verifier.evaluateGeneratedArtifactAuthorization(hiddenCompareFiles)).toMatchObject({ allowed: true });
    const injectedCompareFiles = authorizedInput();
    injectedCompareFiles.compare.files = Array.from({ length: 300 }, (_, index) => ({
      status: 'added',
      filename: `dist/compare-only-${index}.js`,
      sha: 'b'.repeat(40),
    }));
    expect(verifier.evaluateGeneratedArtifactAuthorization(injectedCompareFiles)).toMatchObject({
      allowed: true,
      decision: { generatedDelta: exactAuthorization.generatedDelta },
    });
  });

  it('rejects malformed or mismatched compare base and merge-base identities', () => {
    expectDenied(input => {
      input.compare.base_commit = {} as { sha: string };
    }, 'base_commit.sha');
    expectDenied(input => {
      input.compare.base_commit.sha = 'b'.repeat(40);
    }, 'compare base does not match');
    expectDenied(input => {
      input.compare.merge_base_commit = {} as { sha: string };
    }, 'merge_base_commit.sha');
    expectDenied(input => {
      input.compare.merge_base_commit.sha = 'b'.repeat(40);
    }, 'authorized merge base SHA');
  });

  it('rejects generated changes from forks and non-owner contributors', () => {
    expectDenied(input => {
      input.event.pull_request.head.repo.full_name = 'fork/oh-my-claudecode';
      input.livePull.head.repo.full_name = 'fork/oh-my-claudecode';
    }, 'fork');
    expectDenied(input => {
      input.event.pull_request.user.login = 'contributor';
      input.livePull.user.login = 'contributor';
      input.event.pull_request.author_association = 'CONTRIBUTOR';
      input.livePull.author_association = 'CONTRIBUTOR';
    }, 'protected owner');
  });

  it('rejects unsigned, unknown, and wrong-signer exact heads', () => {
    expectDenied(input => {
      input.commit.commit.verification.verified = false;
    }, 'GitHub REST does not verify');
    expectDenied(input => {
      input.signature.signature.isValid = false;
    }, 'GitHub GraphQL does not verify');
    expectDenied(input => {
      input.signature.signature.signer = null as unknown as { login: string };
    }, 'signer must be an object');
    expectDenied(input => {
      input.signature.signature.signer.login = 'attacker';
    }, 'signature signer');
  });

  it('rejects missing base authorization and any generated closure or digest violation', () => {
    expectDenied(input => {
      input.manifest.authorizations = [];
    }, 'no base-owned authorization entry');
    expectDenied(input => {
      input.manifest.authorizations[0].generatedDelta.sha256 = 'b'.repeat(64);
    }, 'count and digest');
    expectDenied(input => {
      input.files[0].sha = 'c'.repeat(40);
    }, 'authorized closure');
    expectDenied(input => {
      input.files.push({ status: 'added', filename: 'dist/extra.js', sha: 'd'.repeat(40) });
      input.livePull.changed_files += 1;
    }, 'authorized closure');
  });

  it('requires exact authorization for generated-path rename, copy, and deletion records', () => {
    const records: Array<{ api: ApiFile; canonical: CanonicalRecord }> = [
      {
        api: {
          status: 'renamed',
          filename: 'src/moved-generated.js',
          sha: 'b'.repeat(40),
          previous_filename: 'dist/moved-generated.js',
        },
        canonical: {
          status: 'renamed',
          filename: 'src/moved-generated.js',
          sha: 'b'.repeat(40),
          previousFilename: 'dist/moved-generated.js',
        },
      },
      {
        api: {
          status: 'copied',
          filename: 'docs/copied-generated.js',
          sha: 'c'.repeat(40),
          previous_filename: 'bridge/copied-generated.cjs',
        },
        canonical: {
          status: 'copied',
          filename: 'docs/copied-generated.js',
          sha: 'c'.repeat(40),
          previousFilename: 'bridge/copied-generated.cjs',
        },
      },
      {
        api: { status: 'removed', filename: 'dist/removed-generated.js', sha: 'd'.repeat(40) },
        canonical: {
          status: 'removed',
          filename: 'dist/removed-generated.js',
          sha: 'd'.repeat(40),
          previousFilename: null,
        },
      },
      {
        api: {
          status: 'renamed',
          filename: 'dist/moved-into-generated.js',
          sha: 'e'.repeat(40),
          previous_filename: 'src/moved-into-generated.js',
        },
        canonical: {
          status: 'renamed',
          filename: 'dist/moved-into-generated.js',
          sha: 'e'.repeat(40),
          previousFilename: 'src/moved-into-generated.js',
        },
      },
      {
        api: {
          status: 'copied',
          filename: 'bridge/copied-into-generated.cjs',
          sha: 'f'.repeat(40),
          previous_filename: 'src/copied-into-generated.ts',
        },
        canonical: {
          status: 'copied',
          filename: 'bridge/copied-into-generated.cjs',
          sha: 'f'.repeat(40),
          previousFilename: 'src/copied-into-generated.ts',
        },
      },
    ];

    for (const record of records) {
      const unauthorized = authorizedInput();
      unauthorized.files = [record.api];
      unauthorized.livePull.changed_files = 1;
      unauthorized.manifest.authorizations = [];
      expect(verifier.evaluateGeneratedArtifactAuthorization(unauthorized)).toMatchObject({
        allowed: false,
        reason: expect.stringContaining('no base-owned authorization entry'),
      });

      const authorized = authorizedInput();
      authorized.files = [record.api];
      authorized.livePull.changed_files = 1;
      authorized.manifest.authorizations[0].generatedFiles = [record.canonical];
      authorized.manifest.authorizations[0].generatedDelta = verifier.calculateGeneratedDelta([record.canonical]);
      expect(verifier.evaluateGeneratedArtifactAuthorization(authorized)).toMatchObject({
        allowed: true,
        decision: { generatedDelta: authorized.manifest.authorizations[0].generatedDelta },
      });

      const outsideClosure = authorizedInput();
      outsideClosure.files = [record.api];
      outsideClosure.livePull.changed_files = 1;
      expect(verifier.evaluateGeneratedArtifactAuthorization(outsideClosure)).toMatchObject({
        allowed: false,
        reason: expect.stringContaining('authorized closure'),
      });
    }
  });

  it('rejects malformed, missing, and inapplicable previous filenames before scope classification', () => {
    const malformedRecords: Array<{ file: unknown; reason: string }> = [
      {
        file: { status: 'renamed', filename: 'src/missing.js', sha: 'b'.repeat(40) },
        reason: 'previousFilename must be a non-empty string',
      },
      {
        file: {
          status: 'copied',
          filename: 'src/null.js',
          sha: 'b'.repeat(40),
          previous_filename: null,
        },
        reason: 'previousFilename must be a non-empty string',
      },
      {
        file: {
          status: 'renamed',
          filename: 'src/empty.js',
          sha: 'b'.repeat(40),
          previous_filename: '',
        },
        reason: 'previousFilename must be a non-empty string',
      },
      {
        file: {
          status: 'copied',
          filename: 'src/absolute.js',
          sha: 'b'.repeat(40),
          previous_filename: '/dist/source.js',
        },
        reason: 'previousFilename is not a canonical repository path',
      },
      {
        file: {
          status: 'renamed',
          filename: 'src/dot-segment.js',
          sha: 'b'.repeat(40),
          previous_filename: 'dist/../source.js',
        },
        reason: 'previousFilename is not a canonical repository path',
      },
      {
        file: {
          status: 'copied',
          filename: 'src/double-separator.js',
          sha: 'b'.repeat(40),
          previous_filename: 'bridge//source.cjs',
        },
        reason: 'previousFilename is not a canonical repository path',
      },
      {
        file: {
          status: 'modified',
          filename: 'src/inapplicable.js',
          sha: 'b'.repeat(40),
          previous_filename: 'dist/source.js',
        },
        reason: 'previousFilename is only allowed for renamed or copied files',
      },
    ];

    for (const record of malformedRecords) {
      const input = authorizedInput();
      input.files = [record.file as ApiFile];
      input.livePull.changed_files = 1;
      expect(verifier.evaluateGeneratedArtifactAuthorization(input)).toMatchObject({
        allowed: false,
        reason: expect.stringContaining(record.reason),
      });
    }
  });

  it('treats fully paginated pull files, including an empty overflow page, as the sole file-set authority', async () => {
    const requestedPaths: string[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ index }));
    const api = {
      get: async (path: string): Promise<unknown> => {
        requestedPaths.push(path);
        if (path.endsWith('page=1')) return firstPage;
        if (path.endsWith('page=2')) return [{ index: 100 }];
        if (path.endsWith('page=3')) return [];
        throw new Error(`Unexpected path ${path}`);
      },
    };

    await expect(verifier.fetchCompletePullFiles(api, REPOSITORY, PULL_NUMBER, 101)).resolves.toHaveLength(101);
    expect(requestedPaths).toEqual([
      `/repos/${REPOSITORY}/pulls/${PULL_NUMBER}/files?per_page=100&page=1`,
      `/repos/${REPOSITORY}/pulls/${PULL_NUMBER}/files?per_page=100&page=2`,
      `/repos/${REPOSITORY}/pulls/${PULL_NUMBER}/files?per_page=100&page=3`,
    ]);
    await expect(
      verifier.fetchCompletePullFiles(
        { get: async (path: string): Promise<unknown> => (path.endsWith('page=1') ? firstPage : [{ extra: true }]) },
        REPOSITORY,
        PULL_NUMBER,
        100,
      ),
    ).rejects.toThrow('pagination is truncated or inconsistent');
    await expect(verifier.fetchCompletePullFiles(api, REPOSITORY, PULL_NUMBER, 3001)).rejects.toThrow('fully enumerable');
  });

  it('rejects malformed or truncated live pull-file evidence', () => {
    expectDenied(input => {
      input.livePull.changed_files += 1;
    }, 'malformed or truncated');
    expectDenied(input => {
      input.files = input.files.slice(1);
    }, 'malformed or truncated');
  });
});
