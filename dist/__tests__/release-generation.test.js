import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { extractPullRequestNumbers, isReleasePullRequest, deriveContributorLogins, buildReleaseNoteEntriesFromPullRequests, categorizeReleaseNoteEntries, generateChangelog, generateReleaseBody, getLatestTag, } from '../lib/release-generation.js';
describe('release generation', () => {
    it('extracts a deduped PR set from squash and merge subjects', () => {
        const prNumbers = extractPullRequestNumbers([
            'feat(hud): add configurable call count icon format (#2151)',
            'fix(hud): replace misleading CLI error with installation diagnostic (#2129)',
            'Merge pull request #2146 from Yeachan-Heo/issue-2143-omc-launch-followup',
            'Merge pull request #2162 from Yeachan-Heo/release/4.10.2',
            'feat(hud): add configurable call count icon format (#2151)',
        ]);
        expect(prNumbers).toEqual(['2151', '2129', '2146', '2162']);
    });
    it('identifies release PRs by release branch or release title', () => {
        expect(isReleasePullRequest({
            title: 'release: 4.10.2',
            headRefName: 'release/4.10.2',
        })).toBe(true);
        expect(isReleasePullRequest({
            title: 'chore(release): bump version to v4.10.2',
            headRefName: null,
        })).toBe(true);
        expect(isReleasePullRequest({
            title: 'fix(hud): replace misleading CLI error with installation diagnostic',
            headRefName: 'fix/hud-cli-diagnostic',
        })).toBe(false);
    });
    it('derives sorted deduped contributor handles from PR and compare metadata', () => {
        const contributors = deriveContributorLogins([
            { author: 'Yeachan-Heo' },
            { author: 'blue-int' },
            { author: 'EthanJStark' },
            { author: 'blue-int' },
        ], ['tjsingleton', 'DdangJin', 'Yeachan-Heo', 'EthanJStark', null]);
        expect(contributors).toEqual([
            'blue-int',
            'DdangJin',
            'EthanJStark',
            'tjsingleton',
            'Yeachan-Heo',
        ]);
    });
    it('keeps non-conventional PRs in other changes and renders exact PR counts', () => {
        const pullRequests = [
            { number: '2107', title: 'fix(pre-tool-enforcer): deny subagent_type calls whose agent definition has a bare Anthropic model ID on Bedrock', author: 'EthanJStark', headRefName: 'fix/agent-def-model-routing-bedrock' },
            { number: '2108', title: 'chore: enforce dev base branch and gitignore build artifacts', author: 'EthanJStark', headRefName: 'fix/contributor-guardrails' },
            { number: '2122', title: 'fix(state-tools): add skill-active to STATE_TOOL_MODES so cancel can clear it', author: 'tjsingleton', headRefName: 'fix/cancel-clear-skill-active-state' },
            { number: '2127', title: 'fix(hud): show worktree name instead of volatile main repo HEAD', author: 'blue-int', headRefName: 'fix/hud-worktree-name' },
            { number: '2129', title: 'fix(hud): replace misleading CLI error with installation diagnostic', author: 'DdangJin', headRefName: 'fix/hud-cli-diagnostic' },
            { number: '2137', title: 'Fix team tmux pane geometry collapse and bundled agent path resolution', author: 'Yeachan-Heo', headRefName: 'fix-issue-2135-pane-geometry' },
            { number: '2144', title: 'fix: preserve existing global CLAUDE.md during setup', author: 'Yeachan-Heo', headRefName: 'issue-2143-safe-setup-config' },
            { number: '2146', title: 'fix: follow up #2143 with explicit overwrite choice + omc launch profile', author: 'Yeachan-Heo', headRefName: 'issue-2143-omc-launch-followup' },
            { number: '2149', title: 'fix: resolve global HUD npm package lookup outside Node projects', author: 'Yeachan-Heo', headRefName: 'fix/issue-2148-hud-global-npm' },
            { number: '2151', title: 'feat(hud): make call-count icon rendering configurable', author: 'Yeachan-Heo', headRefName: 'issue-2150-hud-call-count-icons' },
        ];
        const categories = categorizeReleaseNoteEntries(buildReleaseNoteEntriesFromPullRequests(pullRequests));
        const changelog = generateChangelog('4.10.2', categories, pullRequests.length);
        expect(changelog).toContain('across **10 merged PRs**.');
        expect(changelog).toContain('### Other Changes');
        expect(changelog).toContain('Fix team tmux pane geometry collapse and bundled agent path resolution');
        expect(changelog).not.toContain('1+ PRs merged');
    });
    it('excludes the current release tag when resolving the previous tag', () => {
        const repoDir = mkdtempSync(join(tmpdir(), 'release-tag-test-'));
        try {
            execSync('git init', { cwd: repoDir, stdio: 'ignore' });
            execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });
            execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });
            writeFileSync(join(repoDir, 'notes.txt'), 'first\n');
            execSync('git add notes.txt', { cwd: repoDir, stdio: 'ignore' });
            execSync('git commit -m "first"', { cwd: repoDir, stdio: 'ignore' });
            execSync('git tag v4.10.2', { cwd: repoDir, stdio: 'ignore' });
            writeFileSync(join(repoDir, 'notes.txt'), 'second\n');
            execSync('git add notes.txt', { cwd: repoDir, stdio: 'ignore' });
            execSync('git commit -m "second"', { cwd: repoDir, stdio: 'ignore' });
            execSync('git tag v4.11.0', { cwd: repoDir, stdio: 'ignore' });
            expect(getLatestTag({ cwd: repoDir })).toBe('v4.11.0');
            expect(getLatestTag({ cwd: repoDir, excludeTag: 'v4.11.0' })).toBe('v4.10.2');
        }
        finally {
            rmSync(repoDir, { recursive: true, force: true });
        }
    });
    it('assembles a single custom release body with compare link and contributors', () => {
        const body = generateReleaseBody('4.10.2', '# oh-my-claudecode v4.10.2: Bug Fixes', ['blue-int', 'DdangJin', 'Yeachan-Heo'], 'v4.10.1');
        expect(body).toContain('The npm CLI and the Claude Code marketplace/plugin are separate install tracks');
        expect(body).toContain('if you have both installed, update both');
        expect(body).toContain('CLI-dependent skill paths such as `ask`, `ccg`, and CLI-backed `team` require the `omc` CLI');
        expect(body).toContain('npm install -g oh-my-claude-sisyphus@4.10.2');
        expect(body).toContain('/plugin marketplace update omc');
        expect(body).toContain('https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.10.1...v4.10.2');
        expect(body).toContain('@blue-int @DdangJin @Yeachan-Heo');
        expect(body.match(/## Contributors/g)).toHaveLength(1);
    });
    it('enforces the release publication boundary around one exact archive', () => {
        const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf-8');
        const stepIndex = (name) => {
            const index = workflow.indexOf(`- name: ${name}`);
            expect(index, `missing workflow step: ${name}`).toBeGreaterThanOrEqual(0);
            return index;
        };
        expect(workflow).toContain('group: release-${{ github.event.inputs.tag || github.ref_name }}');
        expect(workflow).toContain('cancel-in-progress: false');
        expect(workflow).toContain('body_path: release-notes.md');
        expect(workflow).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
        expect(workflow).not.toContain('generate_release_notes: true');
        expect(workflow).not.toContain('grep');
        expect(workflow).toContain('uses: actions/checkout@v4\n        with:\n          fetch-depth: 0');
        expect(workflow).toContain('npm install --global npm@11.17.0');
        expect(workflow).toContain('test "$(npm --version)" = "11.17.0"');
        expect(workflow).not.toContain('\npermissions:\n');
        const setupNode = stepIndex('Setup Node.js');
        const npmPin = stepIndex('Pin npm for attestation verification');
        const install = stepIndex('Install dependencies');
        const trigger = stepIndex('Assert release trigger and npm availability');
        const notes = stepIndex('Validate release notes');
        const pluginShipping = stepIndex('Verify plugin shipping surface');
        const build = stepIndex('Build');
        const functional = stepIndex('Run functional tests');
        const performance = stepIndex('Run subagent-lock performance test');
        const hooks = stepIndex('Restore hooks.json before publish');
        const archive = stepIndex('Create staged release archive');
        const smoke = stepIndex('Smoke test staged archive');
        const evidence = stepIndex('Upload release archive evidence');
        const publish = stepIndex('Publish exact archive and verify registry');
        const finalizedEvidence = stepIndex('Upload finalized release evidence');
        const githubRelease = stepIndex('Create GitHub Release');
        expect(setupNode).toBeLessThan(npmPin);
        expect(npmPin).toBeLessThan(install);
        expect(install).toBeLessThan(trigger);
        expect(trigger).toBeLessThan(notes);
        expect(notes).toBeLessThan(build);
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
        expect(workflow).toContain('git fetch --no-tags --force origin "refs/tags/$GITHUB_REF_NAME:refs/tags/$GITHUB_REF_NAME"');
        expect(workflow).toContain('TAG_OBJECT=$(git rev-parse --verify "refs/tags/$GITHUB_REF_NAME")');
        expect(workflow).toContain('test "$(git cat-file -t "$TAG_OBJECT")" = "tag"');
        expect(workflow).toContain('RELEASE_SHA=$(git rev-parse --verify "refs/tags/$GITHUB_REF_NAME^{}")');
        expect(workflow).toContain('test "$RELEASE_SHA" = "$GITHUB_SHA"');
        expect(workflow).toContain('node scripts/release-boundary.mjs assert-trigger --tag "$GITHUB_REF_NAME" --sha "$RELEASE_SHA"');
        const tagFetch = workflow.indexOf('git fetch --no-tags --force origin "refs/tags/$GITHUB_REF_NAME:refs/tags/$GITHUB_REF_NAME"');
        const tagObject = workflow.indexOf('TAG_OBJECT=$(git rev-parse --verify "refs/tags/$GITHUB_REF_NAME")');
        const tagType = workflow.indexOf('test "$(git cat-file -t "$TAG_OBJECT")" = "tag"');
        const peeledReleaseSha = workflow.indexOf('RELEASE_SHA=$(git rev-parse --verify "refs/tags/$GITHUB_REF_NAME^{}")');
        const shaBinding = workflow.indexOf('test "$RELEASE_SHA" = "$GITHUB_SHA"');
        const triggerAssertion = workflow.indexOf('node scripts/release-boundary.mjs assert-trigger --tag "$GITHUB_REF_NAME" --sha "$RELEASE_SHA"');
        expect(tagFetch).toBeLessThan(tagObject);
        expect(tagObject).toBeLessThan(tagType);
        expect(tagType).toBeLessThan(peeledReleaseSha);
        expect(peeledReleaseSha).toBeLessThan(shaBinding);
        expect(shaBinding).toBeLessThan(triggerAssertion);
        expect(workflow).toContain('node scripts/release-boundary.mjs assert-npm-absent --package oh-my-claude-sisyphus --version "$VERSION"');
        expect(workflow).toContain('git cat-file -e HEAD:.github/release-body.md');
        expect(workflow).toContain('test -s .github/release-body.md');
        expect(workflow).toContain('cp .github/release-body.md release-notes.md');
        expect(workflow).not.toContain('Falling back to minimal release notes');
        expect(workflow).not.toContain('npm view');
        expect(workflow).not.toContain('skipping publish');
        expect(workflow).toContain('npm run build');
        expect(workflow).toContain('npm run plugin:shipping:verify');
        expect(workflow).toContain('- name: Verify plugin shipping surface\n        run: npm run plugin:shipping:verify\n\n      - name: Build');
        expect(workflow).toContain('npm test -- --run');
        expect(workflow).toContain('npm exec vitest -- run tests/perf/subagent-lock.bench.ts --fileParallelism=false --maxWorkers=1');
        expect(workflow).toContain('git checkout -- hooks/hooks.json');
        expect(workflow).toContain('npm pack --ignore-scripts --pack-destination "$SEED_DIR" --silent');
        expect(workflow).toContain('node scripts/release-boundary.mjs prepare-stage --seed-tarball "$SEED_TARBALL" --stage "$STAGE" --git-head "$GITHUB_SHA"');
        expect(workflow).toContain('npm pack "$STAGE/package" --ignore-scripts --pack-destination "$FINAL_DIR" --silent');
        expect(workflow).toContain('node scripts/release-boundary.mjs assert-archive --tarball "$FINAL_TARBALL" --version "$VERSION" --git-head "$GITHUB_SHA"');
        expect(workflow).toContain('node scripts/release-boundary.mjs write-evidence --tarball "$FINAL_TARBALL" --output "$EVIDENCE_JSON"');
        expect(workflow).toContain('FINAL_TARBALL_SHA256=$(sha256sum "$FINAL_TARBALL" | cut -d \' \' -f 1)');
        expect(workflow).toContain("printf 'FINAL_TARBALL_SHA256=%s\\n' \"$FINAL_TARBALL_SHA256\" >> \"$GITHUB_ENV\"");
        expect(workflow).toContain('npm install --ignore-scripts --prefix "$SMOKE_PREFIX" "$FINAL_TARBALL"');
        expect(workflow).toContain('"$SMOKE_PREFIX/node_modules/.bin/omc" --help');
        expect(workflow).toContain('"$SMOKE_PREFIX/node_modules/.bin/omc-cli" team api --help');
        expect(workflow).toContain('*recover-worker*write-task-checkpoint*read-recovery-result*');
        expect(workflow).toContain('SMOKE_HOME="$SMOKE_ROOT/home"');
        expect(workflow).toContain('SMOKE_CLAUDE_CONFIG_DIR="$SMOKE_HOME/.claude"');
        expect(workflow).toContain('SMOKE_GJC_CONFIG_DIR="$SMOKE_HOME/.gjc"');
        expect(workflow).toContain('SMOKE_PACKAGE_ROOT="$SMOKE_PREFIX/node_modules/oh-my-claude-sisyphus"');
        expect(workflow).toContain('OMC_SETUP_PLUGIN_ROOT="$SMOKE_PACKAGE_ROOT" CLAUDE_PLUGIN_ROOT="$SMOKE_PACKAGE_ROOT"');
        expect(workflow).toContain('test -f "$SMOKE_PACKAGE_ROOT/skills/setup/SKILL.md"');
        expect(workflow).toContain('test -f "$SMOKE_PACKAGE_ROOT/skills/omc-setup/SKILL.md"');
        expect(workflow).toContain('test -f "$SMOKE_PACKAGE_ROOT/skills/omc-setup/phases/01-install-claude-md.md"');
        expect(workflow).toContain('cd "$SMOKE_PROJECT"');
        expect(workflow).not.toContain('working-directory: "$SMOKE_PROJECT"');
        expect(workflow).toContain('bash -c \'bash "${OMC_SETUP_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/setup-claude-md.sh" local\'');
        expect(workflow).toContain('cmp "$SMOKE_PACKAGE_ROOT/docs/CLAUDE.md" "$SMOKE_PROJECT/.claude/CLAUDE.md"');
        expect(workflow).toContain('cmp "$SMOKE_PACKAGE_ROOT/skills/omc-reference/SKILL.md" "$SMOKE_PROJECT/.claude/skills/omc-reference/SKILL.md"');
        expect(workflow).toContain('test "$FINAL_TARBALL_SHA256" = "$(sha256sum "$FINAL_TARBALL" | cut -d \' \' -f 1)"');
        expect(workflow).toContain('package/bridge/claude-md-coordinator.cjs');
        expect(workflow).toContain('require(process.argv[1]).gitHead');
        expect(workflow).toContain('require(process.argv[1]).sourceSha');
        expect(workflow).toContain('require(process.argv[1]).sha256');
        expect(workflow).toContain('archiveManifest.files.find(({ path }) => path === "package/bridge/claude-md-coordinator.cjs")');
        expect(workflow).toContain('env -i PATH="$PATH" HOME="$SMOKE_HOME" CLAUDE_CONFIG_DIR="$SMOKE_CLAUDE_CONFIG_DIR" GJC_CONFIG_DIR="$SMOKE_GJC_CONFIG_DIR"');
        expect(workflow).toContain('env -i PATH="$PATH" HOME="$SMOKE_HOME" CLAUDE_CONFIG_DIR="$SMOKE_CLAUDE_CONFIG_DIR" GJC_CONFIG_DIR="$SMOKE_GJC_CONFIG_DIR" OMC_SETUP_PLUGIN_ROOT="$SMOKE_PACKAGE_ROOT" CLAUDE_PLUGIN_ROOT="$SMOKE_PACKAGE_ROOT" "$SMOKE_PREFIX/node_modules/.bin/omc" --version');
        expect(workflow).toContain('uses: actions/upload-artifact@v4');
        expect(workflow).toContain('${{ runner.temp }}/final/*.tgz');
        expect(workflow).toContain('${{ runner.temp }}/release-evidence.json');
        expect(workflow).toContain('name: npm-release-boundary-final-${{ github.ref_name }}');
        const seedPack = workflow.indexOf('npm pack --ignore-scripts --pack-destination "$SEED_DIR" --silent');
        const stagePreparation = workflow.indexOf('node scripts/release-boundary.mjs prepare-stage');
        const finalPack = workflow.indexOf('npm pack "$STAGE/package" --ignore-scripts --pack-destination "$FINAL_DIR" --silent');
        const archiveAssertion = workflow.indexOf('node scripts/release-boundary.mjs assert-archive');
        const evidenceWrite = workflow.indexOf('node scripts/release-boundary.mjs write-evidence');
        expect(seedPack).toBeLessThan(stagePreparation);
        expect(stagePreparation).toBeLessThan(finalPack);
        expect(finalPack).toBeLessThan(archiveAssertion);
        expect(archiveAssertion).toBeLessThan(evidenceWrite);
        expect(evidenceWrite).toBeLessThan(smoke);
        const publishCommands = [...workflow.matchAll(/npm publish [^\n]+/g)].map((match) => match[0]);
        expect(publishCommands).toHaveLength(2);
        expect(publishCommands[0]).toContain('npm publish "$FINAL_TARBALL" --ignore-scripts --access public --provenance');
        expect(publishCommands[1]).toBe('npm publish "$FINAL_TARBALL" --ignore-scripts --access public');
        expect(workflow).not.toMatch(/npm publish\s+\.(?:\s|$)/);
        expect(workflow).not.toMatch(/npm publish\s+--/);
        expect(workflow).toContain('node scripts/release-boundary.mjs assert-sigstore-fallback --publish-log npm-publish.log');
        expect(workflow).toContain('node scripts/release-boundary.mjs assert-evidence --tarball "$FINAL_TARBALL" --evidence "$EVIDENCE_JSON"');
        expect(workflow).toContain('VERIFICATION_PREFIX="$RUNNER_TEMP/npm-provenance-verification"');
        expect(workflow).toContain('AUDIT_JSON="$VERIFICATION_PREFIX/audit-signatures.json"');
        expect(workflow).toContain('npm install --ignore-scripts --no-audit --no-fund --prefix "$VERIFICATION_PREFIX" "oh-my-claude-sisyphus@$VERSION"');
        expect(workflow).toContain('npm audit signatures --json --include-attestations --prefix "$VERIFICATION_PREFIX" > "$AUDIT_JSON"');
        expect(workflow).toContain('node scripts/release-boundary.mjs verify-registry --package oh-my-claude-sisyphus --version "$VERSION" --tag "$GITHUB_REF_NAME" --sha "$GITHUB_SHA" --evidence "$EVIDENCE_JSON" --tarball "$FINAL_TARBALL" --provenance required --audit "$AUDIT_JSON"');
        expect(workflow).toContain('node scripts/release-boundary.mjs verify-registry --package oh-my-claude-sisyphus --version "$VERSION" --tag "$GITHUB_REF_NAME" --sha "$GITHUB_SHA" --evidence "$EVIDENCE_JSON" --tarball "$FINAL_TARBALL" --provenance sigstore-fallback --publish-log npm-publish.log');
        const fallbackVerificationCommands = [
            ...workflow.matchAll(/node scripts\/release-boundary\.mjs verify-registry[^\n]*--provenance sigstore-fallback[^\n]*/g),
        ].map((match) => match[0]);
        expect(fallbackVerificationCommands).toHaveLength(1);
        expect(fallbackVerificationCommands[0]).not.toContain('--audit');
        const provenancePublish = workflow.indexOf('npm publish "$FINAL_TARBALL" --ignore-scripts --access public --provenance');
        const verificationPrefix = workflow.indexOf('VERIFICATION_PREFIX="$RUNNER_TEMP/npm-provenance-verification"');
        const auditJson = workflow.indexOf('AUDIT_JSON="$VERIFICATION_PREFIX/audit-signatures.json"');
        const verificationInstall = workflow.indexOf('npm install --ignore-scripts --no-audit --no-fund --prefix "$VERIFICATION_PREFIX" "oh-my-claude-sisyphus@$VERSION"');
        const signatureAudit = workflow.indexOf('npm audit signatures --json --include-attestations --prefix "$VERIFICATION_PREFIX" > "$AUDIT_JSON"');
        const requiredVerification = workflow.indexOf('node scripts/release-boundary.mjs verify-registry --package oh-my-claude-sisyphus --version "$VERSION" --tag "$GITHUB_REF_NAME" --sha "$GITHUB_SHA" --evidence "$EVIDENCE_JSON" --tarball "$FINAL_TARBALL" --provenance required --audit "$AUDIT_JSON"');
        const fallbackClassification = workflow.indexOf('node scripts/release-boundary.mjs assert-sigstore-fallback');
        const evidenceAssertion = workflow.indexOf('node scripts/release-boundary.mjs assert-evidence');
        const fallbackPublish = workflow.indexOf('npm publish "$FINAL_TARBALL" --ignore-scripts --access public', fallbackClassification);
        const fallbackVerification = workflow.indexOf('node scripts/release-boundary.mjs verify-registry --package oh-my-claude-sisyphus --version "$VERSION" --tag "$GITHUB_REF_NAME" --sha "$GITHUB_SHA" --evidence "$EVIDENCE_JSON" --tarball "$FINAL_TARBALL" --provenance sigstore-fallback');
        expect(provenancePublish).toBeLessThan(verificationPrefix);
        expect(verificationPrefix).toBeLessThan(auditJson);
        expect(auditJson).toBeLessThan(verificationInstall);
        expect(verificationInstall).toBeLessThan(signatureAudit);
        expect(signatureAudit).toBeLessThan(requiredVerification);
        expect(requiredVerification).toBeLessThan(fallbackClassification);
        expect(fallbackClassification).toBeLessThan(evidenceAssertion);
        expect(evidenceAssertion).toBeLessThan(fallbackPublish);
        expect(fallbackPublish).toBeLessThan(fallbackVerification);
        const fallbackPropagationLimit = workflow.indexOf('MAX_FALLBACK_PROPAGATION_ATTEMPTS=6');
        const fallbackPropagationLoop = workflow.indexOf('while [ "$FALLBACK_ATTEMPT" -le "$MAX_FALLBACK_PROPAGATION_ATTEMPTS" ]; do');
        const fallbackPropagationExhaustion = workflow.indexOf('if [ "$FALLBACK_ATTEMPT" -eq "$MAX_FALLBACK_PROPAGATION_ATTEMPTS" ]; then');
        const fallbackPropagationFailure = workflow.indexOf('npm registry propagation did not complete after $MAX_FALLBACK_PROPAGATION_ATTEMPTS fallback attempts');
        const fallbackPropagationExit = workflow.indexOf('exit 1', fallbackPropagationExhaustion);
        expect(fallbackPublish).toBeLessThan(fallbackPropagationLimit);
        expect(fallbackPropagationLimit).toBeLessThan(fallbackPropagationLoop);
        expect(fallbackPropagationLoop).toBeLessThan(fallbackVerification);
        expect(fallbackVerification).toBeLessThan(fallbackPropagationExhaustion);
        expect(fallbackPropagationExhaustion).toBeLessThan(fallbackPropagationFailure);
        expect(fallbackPropagationFailure).toBeLessThan(fallbackPropagationExit);
        expect(workflow).toContain('workflow_dispatch:\n    inputs:\n      tag:\n        description: Exact annotated release tag to recover\n        required: true\n        type: string\n      sha:\n        description: Exact 40-character hexadecimal commit SHA to recover\n        required: true\n        type: string');
        const releaseJob = workflow.slice(workflow.indexOf('  release:'), workflow.indexOf('  recover:'));
        const recoveryJob = workflow.slice(workflow.indexOf('  recover:'));
        expect(releaseJob).toContain('if: github.event_name == \'push\'');
        expect(releaseJob).toContain('permissions:\n      contents: write\n      id-token: write');
        expect(recoveryJob).toContain('if: github.event_name == \'workflow_dispatch\'');
        expect(recoveryJob).toContain('permissions:\n      contents: write');
        expect(recoveryJob).not.toContain('id-token: write');
        expect(recoveryJob).not.toContain('npm publish');
        expect(releaseJob).toContain('MAX_PROPAGATION_ATTEMPTS=6');
        expect(releaseJob).toContain('while [ "$ATTEMPT" -le "$MAX_PROPAGATION_ATTEMPTS" ]; do');
        expect(releaseJob).toContain('rm -rf "$VERIFICATION_PREFIX"');
        expect(releaseJob).toContain('test -s "$AUDIT_JSON"; then');
        expect(releaseJob).toContain('if [ "$ATTEMPT" -eq "$MAX_PROPAGATION_ATTEMPTS" ]; then');
        expect(releaseJob).toContain('npm registry propagation did not complete after $MAX_PROPAGATION_ATTEMPTS attempts');
        expect(releaseJob).toContain('ATTEMPT=$((ATTEMPT + 1))');
        const propagationLimit = releaseJob.indexOf('MAX_PROPAGATION_ATTEMPTS=6');
        const propagationLoop = releaseJob.indexOf('while [ "$ATTEMPT" -le "$MAX_PROPAGATION_ATTEMPTS" ]; do');
        const propagationCleanup = releaseJob.indexOf('rm -rf "$VERIFICATION_PREFIX"');
        const propagationInstall = releaseJob.indexOf('npm install --ignore-scripts --no-audit --no-fund --prefix "$VERIFICATION_PREFIX" "oh-my-claude-sisyphus@$VERSION"');
        const propagationAudit = releaseJob.indexOf('npm audit signatures --json --include-attestations --prefix "$VERIFICATION_PREFIX" > "$AUDIT_JSON"');
        const nonemptyAudit = releaseJob.indexOf('test -s "$AUDIT_JSON"; then');
        const propagationExhaustion = releaseJob.indexOf('if [ "$ATTEMPT" -eq "$MAX_PROPAGATION_ATTEMPTS" ]; then');
        const propagationFailure = releaseJob.indexOf('npm registry propagation did not complete after $MAX_PROPAGATION_ATTEMPTS attempts');
        const propagationExit = releaseJob.indexOf('exit 1', propagationExhaustion);
        const requiredRegistryVerifications = [
            ...releaseJob.matchAll(/node scripts\/release-boundary\.mjs verify-registry[^\n]*--provenance required[^\n]*/g),
        ].map((match) => match[0]);
        const requiredRegistryVerification = releaseJob.indexOf('node scripts/release-boundary.mjs verify-registry --package oh-my-claude-sisyphus --version "$VERSION" --tag "$GITHUB_REF_NAME" --sha "$GITHUB_SHA" --evidence "$EVIDENCE_JSON" --tarball "$FINAL_TARBALL" --provenance required --audit "$AUDIT_JSON"');
        expect(requiredRegistryVerifications).toHaveLength(1);
        expect(propagationLimit).toBeLessThan(propagationLoop);
        expect(propagationLoop).toBeLessThan(propagationCleanup);
        expect(propagationCleanup).toBeLessThan(propagationInstall);
        expect(propagationInstall).toBeLessThan(propagationAudit);
        expect(propagationAudit).toBeLessThan(nonemptyAudit);
        expect(nonemptyAudit).toBeLessThan(propagationExhaustion);
        expect(propagationExhaustion).toBeLessThan(propagationFailure);
        expect(propagationFailure).toBeLessThan(propagationExit);
        expect(propagationExit).toBeLessThan(requiredRegistryVerification);
        expect(recoveryJob).toContain('RECOVERY_TAG: v4.15.4\n      RECOVERY_SHA: cb6932311ac956687e3c66bb6a48d52a8df14d56\n      RECOVERY_INPUT_TAG: ${{ inputs.tag }}\n      RECOVERY_INPUT_SHA: ${{ inputs.sha }}');
        expect(recoveryJob).toContain('uses: actions/checkout@v4\n        with:\n          ref: cb6932311ac956687e3c66bb6a48d52a8df14d56\n          fetch-depth: 0\n          persist-credentials: false');
        expect(recoveryJob).toContain('git fetch --no-tags --force origin "refs/tags/$RECOVERY_TAG:refs/tags/$RECOVERY_TAG"');
        expect(recoveryJob).toContain('TAG_OBJECT=$(git rev-parse --verify "refs/tags/$RECOVERY_TAG")');
        expect(recoveryJob).toContain('test "$(git cat-file -t "$TAG_OBJECT")" = "tag"');
        expect(recoveryJob).toContain('TAG_SHA=$(git rev-parse --verify "refs/tags/$RECOVERY_TAG^{}")');
        expect(recoveryJob).toContain('test "$TAG_SHA" = "$RECOVERY_SHA"');
        expect(recoveryJob).toContain('test "$(git rev-parse HEAD)" = "$RECOVERY_SHA"');
        expect(recoveryJob).toContain('node scripts/release-boundary.mjs assert-trigger --tag "$RECOVERY_TAG" --sha "$RECOVERY_SHA"');
        expect(recoveryJob).not.toContain('cache: "npm"');
        expect(recoveryJob).not.toContain('npm ci');
        expect(recoveryJob).not.toContain("printf 'RECOVERY_AUDIT_JSON=%s\\n'");
        expect(recoveryJob).not.toContain('[[ "$RECOVERY_TAG" =~');
        expect(recoveryJob).toContain('- name: Validate recovery inputs\n        run: |\n          test "$RECOVERY_INPUT_TAG" = "v4.15.4"\n          test "$RECOVERY_INPUT_SHA" = "cb6932311ac956687e3c66bb6a48d52a8df14d56"');
        const recoveryTagFetch = recoveryJob.indexOf('git fetch --no-tags --force origin "refs/tags/$RECOVERY_TAG:refs/tags/$RECOVERY_TAG"');
        const recoveryTagObject = recoveryJob.indexOf('TAG_OBJECT=$(git rev-parse --verify "refs/tags/$RECOVERY_TAG")');
        const recoveryTagType = recoveryJob.indexOf('test "$(git cat-file -t "$TAG_OBJECT")" = "tag"');
        const recoveryPeeledSha = recoveryJob.indexOf('TAG_SHA=$(git rev-parse --verify "refs/tags/$RECOVERY_TAG^{}")');
        const recoveryShaBinding = recoveryJob.indexOf('test "$TAG_SHA" = "$RECOVERY_SHA"');
        const recoveryHeadBinding = recoveryJob.indexOf('test "$(git rev-parse HEAD)" = "$RECOVERY_SHA"');
        const recoveryTriggerAssertion = recoveryJob.indexOf('node scripts/release-boundary.mjs assert-trigger --tag "$RECOVERY_TAG" --sha "$RECOVERY_SHA"');
        expect(recoveryTagFetch).toBeLessThan(recoveryTagObject);
        expect(recoveryTagObject).toBeLessThan(recoveryTagType);
        expect(recoveryTagType).toBeLessThan(recoveryPeeledSha);
        expect(recoveryPeeledSha).toBeLessThan(recoveryShaBinding);
        expect(recoveryShaBinding).toBeLessThan(recoveryHeadBinding);
        expect(recoveryHeadBinding).toBeLessThan(recoveryTriggerAssertion);
        const recoveryPack = recoveryJob.indexOf('npm pack --ignore-scripts --pack-destination "$RECOVERY_ARCHIVE_DIR" --silent "oh-my-claude-sisyphus@$VERSION"');
        const recoveryArchiveAssertion = recoveryJob.indexOf('node scripts/release-boundary.mjs assert-archive --tarball "$RECOVERY_TARBALL" --version "$VERSION" --git-head "$RECOVERY_SHA"');
        const recoveryEvidenceWrite = recoveryJob.indexOf('node scripts/release-boundary.mjs write-evidence --tarball "$RECOVERY_TARBALL" --output "$RECOVERY_EVIDENCE_JSON"');
        const recoveryInstall = recoveryJob.indexOf('npm install --ignore-scripts --no-audit --no-fund --prefix "$RECOVERY_PREFIX" "oh-my-claude-sisyphus@$VERSION"');
        const recoveryAudit = recoveryJob.indexOf('npm audit signatures --json --include-attestations --prefix "$RECOVERY_PREFIX" > "$RECOVERY_AUDIT_JSON"');
        const recoveryRequiredVerification = recoveryJob.indexOf('node scripts/release-boundary.mjs verify-registry --package oh-my-claude-sisyphus --version "$VERSION" --tag "$RECOVERY_TAG" --sha "$RECOVERY_SHA" --evidence "$RECOVERY_EVIDENCE_JSON" --tarball "$RECOVERY_TARBALL" --provenance required --audit "$RECOVERY_AUDIT_JSON"');
        expect(recoveryPack).toBeGreaterThanOrEqual(0);
        expect(recoveryArchiveAssertion).toBeGreaterThanOrEqual(0);
        expect(recoveryEvidenceWrite).toBeGreaterThanOrEqual(0);
        expect(recoveryInstall).toBeGreaterThanOrEqual(0);
        expect(recoveryAudit).toBeGreaterThanOrEqual(0);
        expect(recoveryRequiredVerification).toBeGreaterThanOrEqual(0);
        expect(recoveryPack).toBeLessThan(recoveryArchiveAssertion);
        expect(recoveryArchiveAssertion).toBeLessThan(recoveryEvidenceWrite);
        expect(recoveryEvidenceWrite).toBeLessThan(recoveryInstall);
        expect(recoveryInstall).toBeLessThan(recoveryAudit);
        expect(recoveryAudit).toBeLessThan(recoveryRequiredVerification);
        const recoveryInputValidation = stepIndex('Validate recovery inputs');
        const recoveryCheckout = stepIndex('Checkout recovery source');
        const recoveryTagIdentity = stepIndex('Assert recovered tag identity');
        const recoverySetup = stepIndex('Setup recovery Node.js');
        const recoveryNpmPin = stepIndex('Pin npm for recovery attestation verification');
        const recoveryTrigger = stepIndex('Assert recovery trigger');
        expect(recoveryInputValidation).toBeLessThan(recoveryCheckout);
        expect(recoveryCheckout).toBeLessThan(recoveryTagIdentity);
        expect(recoveryTagIdentity).toBeLessThan(recoverySetup);
        expect(recoverySetup).toBeLessThan(recoveryNpmPin);
        expect(recoveryNpmPin).toBeLessThan(recoveryTrigger);
        const recoveryStepNames = [...recoveryJob.matchAll(/- name: ([^\n]+)/g)].map((match) => match[1]);
        expect(recoveryStepNames.slice(0, 3)).toEqual([
            'Validate recovery inputs',
            'Checkout recovery source',
            'Assert recovered tag identity',
        ]);
        const recoveryArchive = stepIndex('Download published archive and generate recovery evidence');
        const recoveryProvenance = stepIndex('Verify recovered package provenance');
        const recoveryArtifact = stepIndex('Upload recovered release evidence');
        const recoveryAbsence = stepIndex('Assert GitHub Release is absent');
        const recoveredRelease = stepIndex('Create recovered GitHub Release');
        const recoveryReleaseVerification = stepIndex('Verify recovered GitHub Release');
        const recoveryArtifactStep = recoveryJob.slice(recoveryJob.indexOf('- name: Upload recovered release evidence'), recoveryJob.indexOf('- name: Assert GitHub Release is absent'));
        const recoveryAbsenceStep = recoveryJob.slice(recoveryJob.indexOf('- name: Assert GitHub Release is absent'), recoveryJob.indexOf('- name: Create recovered GitHub Release'));
        const recoveredReleaseStep = recoveryJob.slice(recoveryJob.indexOf('- name: Create recovered GitHub Release'), recoveryJob.indexOf('- name: Verify recovered GitHub Release'));
        const recoveryVerificationStep = recoveryJob.slice(recoveryJob.indexOf('- name: Verify recovered GitHub Release'));
        expect(recoveryArtifactStep).toContain('${{ runner.temp }}/recovery-archive/*.tgz');
        expect(recoveryArtifactStep).toContain('${{ runner.temp }}/recovery-evidence.json');
        expect(recoveryArtifactStep).toContain('${{ runner.temp }}/recovery-provenance-verification/audit-signatures.json');
        expect(recoveryArtifactStep).toContain('uses: actions/upload-artifact@v4');
        expect(recoveryArtifactStep).toContain('name: npm-release-boundary-recovery-v4.15.4');
        expect(recoveryArtifactStep).toContain('if-no-files-found: error');
        expect(recoveryArtifactStep).toContain('retention-days: 30');
        expect(recoveryArtifact).toBeLessThan(recoveredRelease);
        expect(recoveryArchive).toBeLessThan(recoveryProvenance);
        expect(recoveryProvenance).toBeLessThan(recoveryArtifact);
        expect(recoveryAbsenceStep).toContain('if gh api --include "repos/$GITHUB_REPOSITORY/releases/tags/$RECOVERY_TAG" > "$RECOVERY_RELEASE_HTTP"; then');
        expect(recoveryAbsenceStep).toContain('case "$GH_STATUS:$HTTP_STATUS" in\n            1:404) ;;');
        expect(recoveryAbsenceStep).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
        expect(recoveryAbsence).toBeLessThan(recoveredRelease);
        expect(recoveredReleaseStep).toContain('uses: softprops/action-gh-release@v1\n        with:\n          tag_name: v4.15.4\n          body_path: release-notes.md\n          draft: false\n          prerelease: false\n        env:\n          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
        expect(recoveredRelease).toBeLessThan(recoveryReleaseVerification);
        expect(recoveryVerificationStep).toContain('if gh api --include "repos/$GITHUB_REPOSITORY/releases/tags/$RECOVERY_TAG" > "$RECOVERY_RELEASE_HTTP"; then');
        expect(recoveryVerificationStep).toContain('case "$GH_STATUS:$HTTP_STATUS" in\n            0:200) ;;');
        expect(recoveryVerificationStep).toContain('git fetch --no-tags --force origin "refs/tags/$RECOVERY_TAG:refs/tags/$RECOVERY_TAG"');
        expect(recoveryVerificationStep).toContain('POST_CREATE_TAG_OBJECT=$(git rev-parse --verify "refs/tags/$RECOVERY_TAG")');
        expect(recoveryVerificationStep).toContain('test "$(git cat-file -t "$POST_CREATE_TAG_OBJECT")" = "tag"');
        expect(recoveryVerificationStep).toContain('POST_CREATE_TAG_SHA=$(git rev-parse --verify "refs/tags/$RECOVERY_TAG^{}")');
        expect(recoveryVerificationStep).toContain('test "$POST_CREATE_TAG_SHA" = "$RECOVERY_SHA"');
        const postCreateTagFetch = recoveryVerificationStep.indexOf('git fetch --no-tags --force origin "refs/tags/$RECOVERY_TAG:refs/tags/$RECOVERY_TAG"');
        const postCreateTagObject = recoveryVerificationStep.indexOf('POST_CREATE_TAG_OBJECT=$(git rev-parse --verify "refs/tags/$RECOVERY_TAG")');
        const postCreateTagType = recoveryVerificationStep.indexOf('test "$(git cat-file -t "$POST_CREATE_TAG_OBJECT")" = "tag"');
        const postCreateTagSha = recoveryVerificationStep.indexOf('POST_CREATE_TAG_SHA=$(git rev-parse --verify "refs/tags/$RECOVERY_TAG^{}")');
        const postCreateTagBinding = recoveryVerificationStep.indexOf('test "$POST_CREATE_TAG_SHA" = "$RECOVERY_SHA"');
        const postCreateReleaseApi = recoveryVerificationStep.indexOf('gh api --include');
        expect(postCreateTagFetch).toBeLessThan(postCreateTagObject);
        expect(postCreateTagObject).toBeLessThan(postCreateTagType);
        expect(postCreateTagType).toBeLessThan(postCreateTagSha);
        expect(postCreateTagSha).toBeLessThan(postCreateTagBinding);
        expect(postCreateTagBinding).toBeLessThan(postCreateReleaseApi);
        expect(recoveryVerificationStep).toContain('const expectedBody = readFileSync(\'.github/release-body.md\', \'utf8\');');
        expect(recoveryVerificationStep).toContain('if (release.tag_name !== process.env.RECOVERY_TAG)');
        expect(recoveryVerificationStep).toContain('if (release.draft !== false || release.prerelease !== false)');
        expect(recoveryVerificationStep).toContain('if (release.body !== expectedBody)');
        expect(recoveryVerificationStep).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
        expect(recoveryVerificationStep.indexOf('- name:', 1)).toBe(-1);
    });
});
//# sourceMappingURL=release-generation.test.js.map