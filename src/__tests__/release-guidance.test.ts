import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const CI_WORKFLOW = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8');
const CONTRIBUTING = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf-8');
const RELEASE_SCRIPT = readFileSync(join(REPO_ROOT, 'scripts', 'release.ts'), 'utf-8');
const SHIPPING_SCRIPT = readFileSync(
  join(REPO_ROOT, 'scripts', 'plugin-shipping-surface.mjs'),
  'utf-8',
);
const PACKAGE_JSON = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
) as { scripts?: Record<string, string> };

describe('plugin shipping release guidance', () => {
  it('verifies the committed shipping surface before CI can build it', () => {
    expect(PACKAGE_JSON.scripts?.['plugin:shipping:verify']).toBe(
      'node scripts/plugin-shipping-surface.mjs verify',
    );
    expect(CI_WORKFLOW).toMatch(
      /- name: Verify committed plugin shipping surface\n\s+run: npm run plugin:shipping:verify\n\n\s+- name: Build\n\s+run: npm run build/,
    );
  });

  it('keeps candidate artifact containment non-authoritative and credential-free', () => {
    expect(PACKAGE_JSON.scripts?.['plugin:shipping:check-pr']).toBe(
      'node scripts/plugin-shipping-surface.mjs check-pr',
    );
    expect(CI_WORKFLOW).toMatch(/permissions:\n\s+contents: read/);
    expect(CI_WORKFLOW).not.toMatch(/pull-requests:\s*write/);
    expect(CI_WORKFLOW).toContain('ref: ${{ github.event.pull_request.head.sha }}');
    expect(CI_WORKFLOW).toContain(
      'node scripts/ci/check-no-committed-build-artifacts.mjs --base "$BASE_SHA" --head "$HEAD_SHA"',
    );
    expect(CI_WORKFLOW).not.toContain('npm ci --ignore-scripts');
    expect(CI_WORKFLOW).not.toContain('GH_TOKEN');
    expect(CI_WORKFLOW).not.toContain('gh api');
    expect(CI_WORKFLOW).not.toContain('PR_AUTHOR_ASSOCIATION');
    expect(CI_WORKFLOW).not.toContain('plugin:shipping:check-pr');
    expect(CI_WORKFLOW).not.toContain('claude-md-coordinator');
    expect(CONTRIBUTING).toContain('credential-free, candidate-side classifier');
    expect(CONTRIBUTING).toContain('non-authoritative for every contributor and maintainer');
    expect(CONTRIBUTING).toContain('workflow root **W**');
    expect(CONTRIBUTING).toContain('verifier/manifest root **B**');
    expect(CONTRIBUTING).toContain('final PR head **H**');
    expect(CONTRIBUTING).toContain('fresh eligible event');
    expect(CONTRIBUTING).toContain('remove this ordinary candidate check from required checks or supersede it');
    expect(CONTRIBUTING).not.toContain('cryptographically signed by that owner');
    expect(CONTRIBUTING).not.toContain('plugin:shipping:stage');
  });

  it('uses the narrow signed maintainer transaction instead of broad staging or protected pushes', () => {
    expect(PACKAGE_JSON.scripts?.['plugin:shipping:stage']).toBe(
      'node scripts/plugin-shipping-surface.mjs stage',
    );
    expect(RELEASE_SCRIPT).toMatch(
      /npm run plugin:shipping:verify\n\s+npm run plugin:shipping:stage\n\s+git add --/,
    );
    expect(RELEASE_SCRIPT).toContain('git commit -S');
    expect(RELEASE_SCRIPT).toContain('git push origin HEAD:release/v${version}');
    expect(RELEASE_SCRIPT).not.toMatch(/git add -A\b/);
    expect(RELEASE_SCRIPT).not.toMatch(/git add -f(?:\s+--)?\s+(?:dist|bridge)\/?\b/);
    expect(SHIPPING_SCRIPT).toContain("return ['add', '-f', '--', ...normalized];");
    expect(SHIPPING_SCRIPT).not.toContain("['add', '-f', 'dist', 'bridge']");
    expect(RELEASE_SCRIPT).not.toMatch(/git push origin (?:dev|main)\b/);
    expect(RELEASE_SCRIPT).not.toMatch(/git (?:checkout|switch) main\b/);
    expect(RELEASE_SCRIPT).not.toMatch(/git merge (?:dev|main)\b/);
  });
});
