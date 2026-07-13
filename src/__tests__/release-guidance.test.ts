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

  it('keeps contributor artifact denial fail closed and limits the exception to a signed maintainer closure', () => {
    expect(PACKAGE_JSON.scripts?.['plugin:shipping:check-pr']).toBe(
      'node scripts/plugin-shipping-surface.mjs check-pr',
    );
    expect(CI_WORKFLOW).toMatch(/permissions:\n\s+contents: read/);
    expect(CI_WORKFLOW).not.toMatch(/pull-requests:\s*write/);
    expect(CI_WORKFLOW).toContain('ref: ${{ github.event.pull_request.head.sha }}');
    expect(CI_WORKFLOW).toContain('run: npm ci --ignore-scripts');
    expect(CI_WORKFLOW).toContain('set -euo pipefail');
    expect(CI_WORKFLOW).toContain(
      'CHANGED=$(git diff --name-only "$BASE_SHA" HEAD -- dist/ bridge/)',
    );
    expect(CI_WORKFLOW).not.toContain(
      'git diff --name-only "$BASE_SHA" HEAD -- dist/ bridge/ || true',
    );
    expect(CI_WORKFLOW).toMatch(
      /if \[ -z "\$CHANGED" \]; then[\s\S]*?exit 0[\s\S]*?\[\[ "\$HEAD_REPOSITORY" == "\$REPOSITORY" \]\]/,
    );
    expect(CI_WORKFLOW).toContain('[[ "$PR_AUTHOR_ASSOCIATION" == "OWNER" ]]');
    expect(CI_WORKFLOW).toContain('[[ "$PR_AUTHOR_LOGIN" == "Yeachan-Heo" ]]');
    expect(CI_WORKFLOW).toContain('[[ "$(git rev-parse HEAD)" == "$HEAD_SHA" ]]');
    expect(CI_WORKFLOW).toContain('gh api "repos/$REPOSITORY/pulls/$PR_NUMBER"');
    expect(CI_WORKFLOW).toContain('Pull-request base or head changed during authorization.');
    expect(CI_WORKFLOW).toContain('gh api graphql');
    expect(CI_WORKFLOW).toContain('signature{isValid signer{login}}');
    expect(CI_WORKFLOW).toContain('"$SIGNER_LOGIN" == "Yeachan-Heo"');
    expect(CI_WORKFLOW).toContain('[[ "$API_SHA" == "$HEAD_SHA" && "$SIGNATURE_VERIFIED" == "true" && "$SIGNER_LOGIN" == "Yeachan-Heo" ]]');
    expect(CI_WORKFLOW).toContain('npm run plugin:shipping:check-pr -- --base "$BASE_SHA"');
    expect(CONTRIBUTING).toContain('### Do NOT commit `dist/` or `bridge/` in contributor PRs');
    expect(CONTRIBUTING).toContain('fails every contributor PR whose diff touches `dist/` or `bridge/`');
    expect(CONTRIBUTING).toContain('cryptographically signed by that owner');
    expect(CONTRIBUTING).toContain('This is not available to contributors.');
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
