import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(process.cwd());
const CI_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/ci.yml');
const RECOVERY_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/release.yml');
const RELEASE_BOUNDARY_PATH = join(REPO_ROOT, 'scripts/release-boundary.mjs');
const CI_JOB_IF = "if: github.event_name != 'push' || github.ref_type != 'tag'";
const RELEASE_JOB_IF = "if: github.event_name == 'push' && github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v')";

function extractJob(workflow: string, jobName: string): string {
  const jobs = workflow.match(/^jobs:\s*$/m);
  expect(jobs, 'workflow must define jobs').toBeTruthy();
  const start = workflow.indexOf(`  ${jobName}:`, jobs?.index);
  expect(start, `workflow must define the ${jobName} job`).toBeGreaterThanOrEqual(0);
  const remainder = workflow.slice(start);
  const nextJob = remainder.slice(1).search(/^  [\w-]+:\s*$/m);
  return nextJob < 0 ? remainder : remainder.slice(0, nextJob + 1);
}

function stepIndex(workflow: string, name: string): number {
  const index = workflow.indexOf(`- name: ${name}`);
  expect(index, `missing workflow step: ${name}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('npm trusted publishing contract', () => {
  const ci = readFileSync(CI_WORKFLOW_PATH, 'utf-8');
  const recovery = readFileSync(RECOVERY_WORKFLOW_PATH, 'utf-8');
  const releaseBoundary = readFileSync(RELEASE_BOUNDARY_PATH, 'utf-8');
  const releaseJob = extractJob(ci, 'release');
  const recoveryJob = extractJob(recovery, 'recover');

  it('binds OIDC provenance to ci.yml on annotated v* tags from this repository', () => {
    expect(ci).toMatch(/^name: CI$/m);
    expect(ci).toContain('    tags:\n      - "v*"');
    expect(ci).toContain("  cancel-in-progress: ${{ github.ref_type != 'tag' }}");
    expect(ci).toMatch(/^permissions:\n  contents: read$/m);
    expect(releaseJob).toContain(RELEASE_JOB_IF);
    expect(releaseJob).toContain('permissions:\n      contents: write\n      id-token: write');
    expect(releaseJob).toContain('runs-on: ubuntu-latest');
    expect(releaseJob).toContain('group: npm-trusted-publish-${{ github.ref_name }}');
    expect(releaseJob).toContain('cancel-in-progress: false');
    expect(releaseJob).toContain('node-version: "24"');
    expect(releaseJob).toContain('npm install --global npm@11.17.0');
    expect(releaseJob).toContain('test "$(npm --version)" = "11.17.0"');
    expect(releaseBoundary).toContain("const WORKFLOW_PATH = '.github/workflows/ci.yml'");
    expect(releaseBoundary).toContain("const REPOSITORY_URL = 'https://github.com/Yeachan-Heo/oh-my-claudecode'");
    expect(releaseBoundary).not.toContain("const WORKFLOW_PATH = '.github/workflows/release.yml'");
  });

  it('excludes duplicate tag triggers so only the ci.yml release job publishes', () => {
    expect(extractJob(ci, 'lint-and-typecheck')).toContain(CI_JOB_IF);
    expect(extractJob(ci, 'test')).toContain(CI_JOB_IF);
    expect(extractJob(ci, 'test-windows')).toContain(CI_JOB_IF);
    expect(extractJob(ci, 'test-precompact-restore')).toContain(CI_JOB_IF);
    expect(extractJob(ci, 'build')).toContain(CI_JOB_IF);
    expect(extractJob(ci, 'multirepo-paths-gate')).toContain(CI_JOB_IF);
    expect(extractJob(ci, 'version-check')).toContain(CI_JOB_IF);
    expect(extractJob(ci, 'npm-pack-test')).toContain(CI_JOB_IF);
    expect(extractJob(ci, 'no-committed-build-artifacts')).toContain("if: github.event_name == 'pull_request'");
    expect(extractJob(ci, 'no-committed-build-artifacts')).not.toContain(RELEASE_JOB_IF);
    expect(recovery).not.toMatch(/^\s+tags:\s*$/m);
    expect(recovery).not.toContain('- "v*"');
    expect(recovery).toContain('workflow_dispatch:');
    expect(recoveryJob).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(ci).not.toContain('  recover:');
  });

  it('publishes once with required provenance and no token or fallback route', () => {
    expect(releaseJob).not.toContain('NODE_AUTH_TOKEN');
    expect(releaseJob).not.toContain('NPM_TOKEN');
    expect(releaseJob).not.toContain('secrets.NPM_TOKEN');
    expect(releaseJob).not.toContain('sigstore-fallback');
    expect(releaseJob).not.toContain('assert-sigstore-fallback');
    expect(ci).not.toContain('NODE_AUTH_TOKEN');
    expect(ci).not.toContain('NPM_TOKEN');
    expect(recoveryJob).not.toContain('npm publish');
    expect(recovery).not.toContain('NODE_AUTH_TOKEN');
    expect(recovery).not.toContain('NPM_TOKEN');
    expect(releaseBoundary).not.toContain('sigstore-fallback');
    expect(releaseBoundary).not.toContain('assert-sigstore-fallback');
    expect(releaseBoundary).not.toContain('classifySigstoreRekorFailure');

    const publishCommands = [...releaseJob.matchAll(/npm publish [^\n]+/g)].map((match) => match[0]);
    expect(publishCommands).toEqual([
      'npm publish "$FINAL_TARBALL" --ignore-scripts --access public --provenance 2>&1 | tee npm-publish.log',
    ]);
    expect(releaseJob).not.toMatch(/npm publish\s+\.(?:\s|$)/);
    expect(releaseJob).not.toContain('skipping publish');

    const workflowFiles = readdirSync(join(REPO_ROOT, '.github/workflows')).filter((name) => name.endsWith('.yml'));
    const publishers = workflowFiles.filter((name) => {
      const text = readFileSync(join(REPO_ROOT, '.github/workflows', name), 'utf-8');
      return /npm publish /.test(text);
    });
    expect(publishers).toEqual(['ci.yml']);
  });

  it('preserves the annotated-tag archive, smoke, registry, and GitHub Release boundary', () => {
    const setupNode = stepIndex(releaseJob, 'Setup Node.js');
    const npmPin = stepIndex(releaseJob, 'Pin npm for attestation verification');
    const install = stepIndex(releaseJob, 'Install dependencies');
    const trigger = stepIndex(releaseJob, 'Assert release trigger and npm availability');
    const notes = stepIndex(releaseJob, 'Validate release notes');
    const pluginShipping = stepIndex(releaseJob, 'Verify plugin shipping surface');
    const build = stepIndex(releaseJob, 'Build');
    const functional = stepIndex(releaseJob, 'Run functional tests');
    const performance = stepIndex(releaseJob, 'Run subagent-lock performance test');
    const hooks = stepIndex(releaseJob, 'Restore hooks.json before publish');
    const archive = stepIndex(releaseJob, 'Create staged release archive');
    const smoke = stepIndex(releaseJob, 'Smoke test staged archive');
    const evidence = stepIndex(releaseJob, 'Upload release archive evidence');
    const publish = stepIndex(releaseJob, 'Publish exact archive and verify registry');
    const finalizedEvidence = stepIndex(releaseJob, 'Upload finalized release evidence');
    const githubRelease = stepIndex(releaseJob, 'Create GitHub Release');

    expect(setupNode).toBeLessThan(npmPin);
    expect(npmPin).toBeLessThan(install);
    expect(install).toBeLessThan(trigger);
    expect(trigger).toBeLessThan(notes);
    expect(notes).toBeLessThan(pluginShipping);
    expect(pluginShipping).toBeLessThan(build);
    expect(build).toBeLessThan(functional);
    expect(functional).toBeLessThan(performance);
    expect(performance).toBeLessThan(hooks);
    expect(hooks).toBeLessThan(archive);
    expect(archive).toBeLessThan(smoke);
    expect(smoke).toBeLessThan(evidence);
    expect(evidence).toBeLessThan(publish);
    expect(publish).toBeLessThan(finalizedEvidence);
    expect(finalizedEvidence).toBeLessThan(githubRelease);

    expect(releaseJob).toContain('test "$(git cat-file -t "$TAG_OBJECT")" = "tag"');
    expect(releaseJob).toContain('test "$RELEASE_SHA" = "$GITHUB_SHA"');
    expect(releaseJob).toContain(
      'node scripts/release-boundary.mjs assert-trigger --tag "$GITHUB_REF_NAME" --sha "$RELEASE_SHA"',
    );
    expect(releaseJob).toContain(
      'node scripts/release-boundary.mjs assert-npm-absent --package oh-my-claude-sisyphus --version "$VERSION"',
    );
    expect(releaseJob).toContain('git cat-file -e HEAD:.github/release-body.md');
    expect(releaseJob).toContain('cp .github/release-body.md "$RUNNER_TEMP/release-notes.md"');
    expect(releaseJob).toContain(
      'node scripts/release-boundary.mjs prepare-stage --seed-tarball "$SEED_TARBALL" --stage "$STAGE" --git-head "$GITHUB_SHA"',
    );
    expect(releaseJob).toContain(
      'node scripts/release-boundary.mjs assert-archive --tarball "$FINAL_TARBALL" --version "$VERSION" --git-head "$GITHUB_SHA"',
    );
    expect(releaseJob).toContain(
      'node scripts/release-boundary.mjs write-evidence --tarball "$FINAL_TARBALL" --output "$EVIDENCE_JSON"',
    );
    expect(releaseJob).toContain('require(process.argv[1]).gitHead');
    expect(releaseJob).toContain('require(process.argv[1]).sourceSha');
    expect(releaseJob).toContain(
      'node scripts/release-boundary.mjs verify-registry --package oh-my-claude-sisyphus --version "$VERSION" --tag "$GITHUB_REF_NAME" --sha "$GITHUB_SHA" --evidence "$EVIDENCE_JSON" --tarball "$FINAL_TARBALL" --provenance required --audit "$AUDIT_JSON"',
    );
    expect(releaseJob).toContain('body_path: ${{ runner.temp }}/release-notes.md');
    expect(releaseJob).toContain('Assert clean deterministic tracked tree before archive');
    expect(releaseJob).toContain('git restore --worktree dist bridge hooks/hooks.json');
    expect(releaseJob).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(releaseJob).not.toContain('generate_release_notes: true');
    expect(releaseJob).not.toMatch(/(?:^|[^A-Z_])GH_TOKEN(?:[^A-Z_]|$)/m);
    expect(releaseJob).not.toContain('gh api');
  });

  it('keeps recovery strictly non-publishing and workflow_dispatch-only', () => {
    expect(recoveryJob).toContain('permissions:\n      contents: write');
    expect(recoveryJob).not.toContain('id-token: write');
    expect(recoveryJob).not.toContain('npm publish');
    expect(recoveryJob).toContain(
      'RECOVERY_TAG: v4.15.4\n      RECOVERY_SHA: cb6932311ac956687e3c66bb6a48d52a8df14d56\n      RECOVERY_INPUT_TAG: ${{ inputs.tag }}\n      RECOVERY_INPUT_SHA: ${{ inputs.sha }}',
    );
    expect(recoveryJob).toContain(
      'node scripts/release-boundary.mjs verify-registry --package oh-my-claude-sisyphus --version "$VERSION" --tag "$RECOVERY_TAG" --sha "$RECOVERY_SHA" --evidence "$RECOVERY_EVIDENCE_JSON" --tarball "$RECOVERY_TARBALL" --provenance required --audit "$RECOVERY_AUDIT_JSON"',
    );
    expect(recovery).toContain(
      'workflow_dispatch:\n    inputs:\n      tag:\n        description: Exact annotated release tag to recover\n        required: true\n        type: string\n      sha:\n        description: Exact 40-character hexadecimal commit SHA to recover\n        required: true\n        type: string',
    );
  });
});
