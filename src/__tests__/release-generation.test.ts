import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  extractPullRequestNumbers,
  isReleasePullRequest,
  deriveContributorLogins,
  buildReleaseNoteEntriesFromPullRequests,
  categorizeReleaseNoteEntries,
  generateChangelog,
  generateReleaseBody,
} from '../lib/release-generation.js';

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
    const contributors = deriveContributorLogins(
      [
        { author: 'Yeachan-Heo' },
        { author: 'blue-int' },
        { author: 'EthanJStark' },
        { author: 'blue-int' },
      ],
      ['tjsingleton', 'DdangJin', 'Yeachan-Heo', 'EthanJStark', null],
    );

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

    const categories = categorizeReleaseNoteEntries(
      buildReleaseNoteEntriesFromPullRequests(pullRequests),
    );
    const changelog = generateChangelog('4.10.2', categories, pullRequests.length);

    expect(changelog).toContain('across **10 merged PRs**.');
    expect(changelog).toContain('### Other Changes');
    expect(changelog).toContain('Fix team tmux pane geometry collapse and bundled agent path resolution');
    expect(changelog).not.toContain('1+ PRs merged');
  });

  it('assembles a single custom release body with compare link and contributors', () => {
    const body = generateReleaseBody(
      '4.10.2',
      '# oh-my-claudecode v4.10.2: Bug Fixes',
      ['blue-int', 'DdangJin', 'Yeachan-Heo'],
      'v4.10.1',
    );

    expect(body).toContain('npm install -g oh-my-claude-sisyphus@4.10.2');
    expect(body).toContain('https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.10.1...v4.10.2');
    expect(body).toContain('@blue-int @DdangJin @Yeachan-Heo');
    expect(body.match(/## Contributors/g)).toHaveLength(1);
  });

  it('configures the workflow to use one custom release body source with github auth', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/release.yml'),
      'utf-8',
    );

    expect(workflow).toContain('body_path: release-notes.md');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(workflow).not.toContain('generate_release_notes: true');
  });
});
