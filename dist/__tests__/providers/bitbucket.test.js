import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BitbucketProvider } from '../../providers/bitbucket.js';
describe('BitbucketProvider', () => {
    let provider;
    let originalEnv;
    let mockFetch;
    beforeEach(() => {
        provider = new BitbucketProvider();
        originalEnv = { ...process.env };
        mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);
    });
    afterEach(() => {
        process.env = originalEnv;
        vi.unstubAllGlobals();
    });
    describe('static properties', () => {
        it('has correct name', () => {
            expect(provider.name).toBe('bitbucket');
        });
        it('has correct displayName', () => {
            expect(provider.displayName).toBe('Bitbucket');
        });
        it('uses PR terminology', () => {
            expect(provider.prTerminology).toBe('PR');
        });
        it('has null prRefspec', () => {
            expect(provider.prRefspec).toBeNull();
        });
        it('requires no CLI', () => {
            expect(provider.getRequiredCLI()).toBeNull();
        });
    });
    describe('detectFromRemote', () => {
        it('returns true for bitbucket.org HTTPS URLs', () => {
            expect(provider.detectFromRemote('https://bitbucket.org/user/repo')).toBe(true);
        });
        it('returns true for bitbucket.org SSH URLs', () => {
            expect(provider.detectFromRemote('git@bitbucket.org:user/repo.git')).toBe(true);
        });
        it('returns false for non-Bitbucket URLs', () => {
            expect(provider.detectFromRemote('https://github.com/user/repo')).toBe(false);
        });
        it('returns false for GitLab URLs', () => {
            expect(provider.detectFromRemote('https://gitlab.com/user/repo')).toBe(false);
        });
    });
    describe('viewPR', () => {
        it('fetches PR via fetch and parses response', async () => {
            process.env.BITBUCKET_TOKEN = 'test-token';
            const mockData = {
                title: 'Add feature',
                source: { branch: { name: 'feature/new' } },
                destination: { branch: { name: 'main' } },
                links: { html: { href: 'https://bitbucket.org/user/repo/pull-requests/5' } },
                description: 'Adds a new feature',
                author: { display_name: 'Test User' },
            };
            mockFetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(mockData),
            });
            const result = await provider.viewPR(5, 'user', 'repo');
            expect(mockFetch).toHaveBeenCalledWith('https://api.bitbucket.org/2.0/repositories/user/repo/pullrequests/5', expect.objectContaining({
                headers: { Authorization: 'Bearer test-token' },
            }));
            expect(result).toEqual({
                title: 'Add feature',
                headBranch: 'feature/new',
                baseBranch: 'main',
                url: 'https://bitbucket.org/user/repo/pull-requests/5',
                body: 'Adds a new feature',
                author: 'Test User',
            });
        });
        it('uses Basic auth when username and app password are set', async () => {
            delete process.env.BITBUCKET_TOKEN;
            process.env.BITBUCKET_USERNAME = 'myuser';
            process.env.BITBUCKET_APP_PASSWORD = 'mypass';
            mockFetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    title: 'PR',
                    source: { branch: { name: 'feat' } },
                    destination: { branch: { name: 'main' } },
                    links: { html: { href: '' } },
                    description: '',
                    author: { display_name: 'u' },
                }),
            });
            await provider.viewPR(1, 'owner', 'repo');
            const expectedAuth = `Basic ${Buffer.from('myuser:mypass').toString('base64')}`;
            expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('pullrequests/1'), expect.objectContaining({
                headers: { Authorization: expectedAuth },
            }));
        });
        it('returns null when owner or repo is missing', async () => {
            process.env.BITBUCKET_TOKEN = 'test-token';
            expect(await provider.viewPR(1)).toBeNull();
            expect(await provider.viewPR(1, 'owner')).toBeNull();
            expect(mockFetch).not.toHaveBeenCalled();
        });
        it('returns null when no auth is configured', async () => {
            delete process.env.BITBUCKET_TOKEN;
            delete process.env.BITBUCKET_USERNAME;
            delete process.env.BITBUCKET_APP_PASSWORD;
            expect(await provider.viewPR(1, 'owner', 'repo')).toBeNull();
            expect(mockFetch).not.toHaveBeenCalled();
        });
        it('returns null when fetch throws', async () => {
            process.env.BITBUCKET_TOKEN = 'test-token';
            mockFetch.mockRejectedValue(new Error('network error'));
            expect(await provider.viewPR(1, 'owner', 'repo')).toBeNull();
        });
        it('returns null when response is not ok', async () => {
            process.env.BITBUCKET_TOKEN = 'test-token';
            mockFetch.mockResolvedValue({ ok: false });
            expect(await provider.viewPR(1, 'owner', 'repo')).toBeNull();
        });
        it('returns null for invalid number', async () => {
            expect(await provider.viewPR(-1, 'owner', 'repo')).toBeNull();
            expect(await provider.viewPR(0, 'owner', 'repo')).toBeNull();
            expect(await provider.viewPR(1.5, 'owner', 'repo')).toBeNull();
            expect(mockFetch).not.toHaveBeenCalled();
        });
    });
    describe('viewIssue', () => {
        it('fetches issue via fetch and parses response', async () => {
            process.env.BITBUCKET_TOKEN = 'test-token';
            const mockData = {
                title: 'Bug report',
                content: { raw: 'Something is broken' },
                links: { html: { href: 'https://bitbucket.org/user/repo/issues/3' } },
            };
            mockFetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(mockData),
            });
            const result = await provider.viewIssue(3, 'user', 'repo');
            expect(mockFetch).toHaveBeenCalledWith('https://api.bitbucket.org/2.0/repositories/user/repo/issues/3', expect.objectContaining({
                headers: { Authorization: 'Bearer test-token' },
            }));
            expect(result).toEqual({
                title: 'Bug report',
                body: 'Something is broken',
                url: 'https://bitbucket.org/user/repo/issues/3',
            });
        });
        it('returns null when owner or repo is missing', async () => {
            process.env.BITBUCKET_TOKEN = 'test-token';
            expect(await provider.viewIssue(1)).toBeNull();
            expect(mockFetch).not.toHaveBeenCalled();
        });
        it('returns null when fetch throws', async () => {
            process.env.BITBUCKET_TOKEN = 'test-token';
            mockFetch.mockRejectedValue(new Error('network error'));
            expect(await provider.viewIssue(1, 'owner', 'repo')).toBeNull();
        });
        it('returns null for invalid number', async () => {
            expect(await provider.viewIssue(-1, 'owner', 'repo')).toBeNull();
            expect(await provider.viewIssue(0, 'owner', 'repo')).toBeNull();
            expect(mockFetch).not.toHaveBeenCalled();
        });
    });
    describe('checkAuth', () => {
        it('returns true when BITBUCKET_TOKEN is set', () => {
            process.env.BITBUCKET_TOKEN = 'test-token';
            expect(provider.checkAuth()).toBe(true);
        });
        it('returns true when BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD are set', () => {
            delete process.env.BITBUCKET_TOKEN;
            process.env.BITBUCKET_USERNAME = 'user';
            process.env.BITBUCKET_APP_PASSWORD = 'pass';
            expect(provider.checkAuth()).toBe(true);
        });
        it('returns false when no auth is configured', () => {
            delete process.env.BITBUCKET_TOKEN;
            delete process.env.BITBUCKET_USERNAME;
            delete process.env.BITBUCKET_APP_PASSWORD;
            expect(provider.checkAuth()).toBe(false);
        });
    });
});
//# sourceMappingURL=bitbucket.test.js.map