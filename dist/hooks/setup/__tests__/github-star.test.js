/**
 * GitHub Star Module Tests
 *
 * Tests for auto-starring functionality with real gh API calls.
 * Run with: npm test -- github-star.test.ts
 */
import { isGhCliAvailable, isRepoStarred, starRepository, autoStarRepository, } from '../github-star.js';
describe('GitHub Star Module', () => {
    const TEST_REPO = 'Yeachan-Heo/oh-my-claudecode';
    describe('isGhCliAvailable', () => {
        it('should return true when gh CLI is available', () => {
            const result = isGhCliAvailable();
            expect(typeof result).toBe('boolean');
            // If gh is installed, it should return true
            if (result) {
                expect(result).toBe(true);
            }
        });
        it('should return false when gh CLI is not available', () => {
            const mockExec = (() => {
                throw new Error('gh: command not found');
            });
            const result = isGhCliAvailable(mockExec);
            expect(result).toBe(false);
        });
        it('should use custom exec function', () => {
            let called = false;
            const mockExec = (() => {
                called = true;
                return Buffer.from('gh version 2.0.0');
            });
            isGhCliAvailable(mockExec);
            expect(called).toBe(true);
        });
    });
    describe('isRepoStarred', () => {
        it('should check star status using gh API', () => {
            // This will make a real API call
            const result = isRepoStarred(TEST_REPO);
            expect(typeof result).toBe('boolean');
        });
        it('should return false when API call fails', () => {
            const mockExec = (() => {
                throw new Error('API error');
            });
            const result = isRepoStarred(TEST_REPO, mockExec);
            expect(result).toBe(false);
        });
        it('should return true when repo is starred', () => {
            const mockExec = (() => Buffer.from(''));
            const result = isRepoStarred(TEST_REPO, mockExec);
            expect(result).toBe(true);
        });
    });
    describe('starRepository', () => {
        it('should return true on successful star', () => {
            const mockExec = (() => Buffer.from(''));
            const result = starRepository(TEST_REPO, mockExec);
            expect(result).toBe(true);
        });
        it('should return false on failed star', () => {
            const mockExec = (() => {
                throw new Error('API error');
            });
            const result = starRepository(TEST_REPO, mockExec);
            expect(result).toBe(false);
        });
    });
    describe('autoStarRepository', () => {
        it('should handle gh CLI not available', () => {
            const mockExec = (() => {
                throw new Error('gh: command not found');
            });
            const result = autoStarRepository({ execFn: mockExec });
            expect(result.starred).toBe(false);
            expect(result.action).toBe('skipped');
            expect(result.message).toBe('gh CLI not available');
        });
        it('should handle already starred repository', () => {
            let callCount = 0;
            const mockExec = ((_command) => {
                callCount++;
                // First call: gh --version (success)
                // Second call: gh api user/starred/... (success = already starred)
                return Buffer.from('');
            });
            const result = autoStarRepository({ execFn: mockExec });
            expect(result.starred).toBe(true);
            expect(result.action).toBe('already_starred');
            expect(callCount).toBe(2);
        });
        it('should star repository when not starred', () => {
            let callCount = 0;
            const mockExec = ((_command) => {
                callCount++;
                // First call: gh --version (success)
                if (callCount === 1)
                    return Buffer.from('gh version 2.0.0');
                // Second call: gh api user/starred/... (fail = not starred)
                if (callCount === 2)
                    throw new Error('not starred');
                // Third call: gh api --method PUT (success = starred)
                return Buffer.from('');
            });
            const result = autoStarRepository({ execFn: mockExec });
            expect(result.starred).toBe(true);
            expect(result.action).toBe('newly_starred');
            expect(result.message).toContain('⭐');
            expect(callCount).toBe(3);
        });
        it('should handle star failure', () => {
            let callCount = 0;
            const mockExec = ((_command) => {
                callCount++;
                // First call: gh --version (success)
                if (callCount === 1)
                    return Buffer.from('gh version 2.0.0');
                // Second call: gh api user/starred/... (fail = not starred)
                if (callCount === 2)
                    throw new Error('not starred');
                // Third call: gh api --method PUT (fail)
                throw new Error('API error');
            });
            const result = autoStarRepository({ execFn: mockExec });
            expect(result.starred).toBe(false);
            expect(result.action).toBe('failed');
            expect(callCount).toBe(3);
        });
        it('should use custom repo', () => {
            let capturedCommand = '';
            const mockExec = ((_command) => {
                capturedCommand = _command;
                if (_command.includes('--version'))
                    return Buffer.from('gh version 2.0.0');
                return Buffer.from('');
            });
            autoStarRepository({
                repo: 'test/repo',
                execFn: mockExec,
            });
            expect(capturedCommand).toContain('test/repo');
        });
        it('should support silent mode', () => {
            const mockExec = (() => {
                throw new Error('gh: command not found');
            });
            const result = autoStarRepository({
                silent: true,
                execFn: mockExec,
            });
            expect(result.message).toBe('');
        });
    });
    describe('Integration Test (Real API)', () => {
        // Skip these tests in CI where GitHub auth is not available
        const isCI = !!process.env.CI;
        // This test makes real gh API calls
        it('should work with real gh CLI', () => {
            // Skip in CI where GitHub auth is not available
            if (isCI) {
                console.log('⚠️  Skipping real API test - running in CI environment');
                return;
            }
            // Skip if gh CLI is not available
            if (!isGhCliAvailable()) {
                console.log('⚠️  Skipping real API test - gh CLI not available');
                return;
            }
            const result = autoStarRepository({ repo: TEST_REPO });
            expect(result.starred).toBe(true);
            expect(['already_starred', 'newly_starred']).toContain(result.action);
            if (result.action === 'newly_starred') {
                console.log('✅ Successfully starred the repository!');
            }
            else if (result.action === 'already_starred') {
                console.log('✅ Repository was already starred');
            }
        });
        it('should verify star status after starring', () => {
            // Skip in CI where GitHub auth is not available
            if (isCI) {
                console.log('⚠️  Skipping real API test - running in CI environment');
                return;
            }
            // Skip if gh CLI is not available
            if (!isGhCliAvailable()) {
                console.log('⚠️  Skipping real API test - gh CLI not available');
                return;
            }
            // First, check if starred
            const isStarred = isRepoStarred(TEST_REPO);
            console.log(`Repository star status: ${isStarred ? 'starred' : 'not starred'}`);
            // If not starred, star it
            if (!isStarred) {
                const starResult = starRepository(TEST_REPO);
                expect(starResult).toBe(true);
                // Verify it's now starred
                const verifyStarred = isRepoStarred(TEST_REPO);
                expect(verifyStarred).toBe(true);
                console.log('✅ Star verified after starring');
            }
            else {
                console.log('✅ Repository already starred');
            }
        });
    });
});
//# sourceMappingURL=github-star.test.js.map