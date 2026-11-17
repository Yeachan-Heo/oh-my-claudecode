import { describe, expect, it } from 'vitest';
import { FEATURED_CONTRIBUTORS_END_MARKER, FEATURED_CONTRIBUTORS_START_MARKER, FEATURED_CONTRIBUTORS_TITLE, formatStarCount, parseCliOptions, pickTopPersonalRepo, renderFeaturedContributorsSection, upsertFeaturedContributorsSection, } from '../lib/featured-contributors.js';
describe('featured contributors generator', () => {
    it('picks the top personal non-fork non-archived repo for a contributor', () => {
        const repo = pickTopPersonalRepo('alice', [
            {
                name: 'forked-hit',
                full_name: 'alice/forked-hit',
                html_url: 'https://github.com/alice/forked-hit',
                stargazers_count: 500,
                fork: true,
                owner: { login: 'alice', type: 'User' },
            },
            {
                name: 'archived-hit',
                full_name: 'alice/archived-hit',
                html_url: 'https://github.com/alice/archived-hit',
                stargazers_count: 450,
                fork: false,
                archived: true,
                owner: { login: 'alice', type: 'User' },
            },
            {
                name: 'org-owned',
                full_name: 'acme/org-owned',
                html_url: 'https://github.com/acme/org-owned',
                stargazers_count: 400,
                fork: false,
                owner: { login: 'acme', type: 'Organization' },
            },
            {
                name: 'personal-top',
                full_name: 'alice/personal-top',
                html_url: 'https://github.com/alice/personal-top',
                stargazers_count: 250,
                fork: false,
                owner: { login: 'alice', type: 'User' },
            },
            {
                name: 'personal-low',
                full_name: 'alice/personal-low',
                html_url: 'https://github.com/alice/personal-low',
                stargazers_count: 150,
                fork: false,
                owner: { login: 'alice', type: 'User' },
            },
        ]);
        expect(repo?.full_name).toBe('alice/personal-top');
    });
    it('renders a compact featured contributors block sorted by stars', () => {
        const block = renderFeaturedContributorsSection([
            {
                login: 'charlie',
                profileUrl: 'https://github.com/charlie',
                repoName: 'small-hit',
                repoFullName: 'charlie/small-hit',
                repoUrl: 'https://github.com/charlie/small-hit',
                stars: 150,
            },
            {
                login: 'alice',
                profileUrl: 'https://github.com/alice',
                repoName: 'big-hit',
                repoFullName: 'alice/big-hit',
                repoUrl: 'https://github.com/alice/big-hit',
                stars: 2400,
            },
        ]);
        expect(block).toContain(FEATURED_CONTRIBUTORS_START_MARKER);
        expect(block).toContain(FEATURED_CONTRIBUTORS_END_MARKER);
        expect(block).toContain(FEATURED_CONTRIBUTORS_TITLE);
        expect(block).toContain('Top personal non-fork, non-archived repos');
        expect(block.indexOf('@alice')).toBeLessThan(block.indexOf('@charlie'));
        expect(block).toContain('(⭐ 2.4k)');
        expect(block).toContain('(⭐ 150)');
    });
    it('inserts the generated block before star history when markers are absent', () => {
        const updated = upsertFeaturedContributorsSection('# README\n\nIntro\n\n## Star History\n\nChart\n', `${FEATURED_CONTRIBUTORS_START_MARKER}\nGenerated\n${FEATURED_CONTRIBUTORS_END_MARKER}\n`);
        expect(updated).toContain(`${FEATURED_CONTRIBUTORS_END_MARKER}\n\n## Star History`);
    });
    it('replaces an existing marker block without disturbing surrounding content', () => {
        const updated = upsertFeaturedContributorsSection([
            '# README',
            '',
            FEATURED_CONTRIBUTORS_START_MARKER,
            'Old block',
            FEATURED_CONTRIBUTORS_END_MARKER,
            '',
            '## Star History',
        ].join('\n'), `${FEATURED_CONTRIBUTORS_START_MARKER}\nNew block\n${FEATURED_CONTRIBUTORS_END_MARKER}\n`);
        expect(updated).toContain('New block');
        expect(updated).not.toContain('Old block');
        expect(updated).toContain('## Star History');
    });
    it('replacing an existing marker block stays idempotent around trailing spacing', () => {
        const featuredSection = `${FEATURED_CONTRIBUTORS_START_MARKER}\nNew block\n${FEATURED_CONTRIBUTORS_END_MARKER}\n`;
        const original = [
            '# README',
            '',
            FEATURED_CONTRIBUTORS_START_MARKER,
            'Old block',
            FEATURED_CONTRIBUTORS_END_MARKER,
            '',
            '',
            '## Star History',
        ].join('\n');
        const once = upsertFeaturedContributorsSection(original, featuredSection);
        const twice = upsertFeaturedContributorsSection(once, featuredSection);
        expect(once).toBe(twice);
        expect(once).toContain(`${FEATURED_CONTRIBUTORS_END_MARKER}\n\n## Star History`);
    });
    it('formats star counts compactly for README output', () => {
        expect(formatStarCount(100)).toBe('100');
        expect(formatStarCount(1500)).toBe('1.5k');
        expect(formatStarCount(12500)).toBe('13k');
    });
    it('parses a valid --min-stars value', () => {
        expect(parseCliOptions(['--min-stars=250']).minStars).toBe(250);
        expect(parseCliOptions(['--min-stars=0']).minStars).toBe(0);
    });
    it.each(['abc', '', '-5', '1.5', '10x', 'Infinity', '1e-324', '9007199254740993'])('rejects invalid --min-stars=%s instead of silently disabling the threshold', (value) => {
        expect(() => parseCliOptions([`--min-stars=${value}`])).toThrow(/Invalid --min-stars/);
    });
});
//# sourceMappingURL=featured-contributors-generator.test.js.map