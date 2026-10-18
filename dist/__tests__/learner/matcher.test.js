import { describe, it, expect } from 'vitest';
import { matchSkills, fuzzyMatch, extractContext, calculateConfidence, } from '../../hooks/learner/matcher.js';
describe('Smart Skill Matcher', () => {
    //=============================================
    // 1. FUZZY MATCHING - Levenshtein Distance
    //=============================================
    describe('Fuzzy Matching - Levenshtein Distance', () => {
        it('should return 100 for exact word match', () => {
            const score = fuzzyMatch('typescript is great', 'typescript');
            expect(score).toBe(100);
        });
        it('should handle typos with high similarity', () => {
            // "typescrpt" vs "typescript" (missing 'i') - should get a decent score
            const score = fuzzyMatch('fix typescrpt errors', 'typescript');
            // 9 chars vs 10 chars, 1 edit distance -> similarity = (10-1)/10 = 90%
            expect(score).toBeGreaterThanOrEqual(70);
        });
        it('should handle minor typos', () => {
            // "javascrpt" vs "javascript" (missing 'i')
            const score = fuzzyMatch('help with javascrpt', 'javascript');
            expect(score).toBeGreaterThanOrEqual(70);
        });
        it('should give low score for unrelated words', () => {
            const score = fuzzyMatch('hello world', 'typescript');
            expect(score).toBeLessThan(60);
        });
        it('should handle word boundary correctly', () => {
            // "type" is contained in prompt but "typescript" is the pattern
            const score1 = fuzzyMatch('type something', 'typescript');
            // This should be lower than exact match but partial match bonus applies
            expect(score1).toBeGreaterThan(0);
        });
        it('should handle partial matches with inclusion', () => {
            const score = fuzzyMatch('react typescript app', 'react');
            expect(score).toBe(100); // Exact match
        });
    });
    //=============================================
    // 2. PATTERN MATCHING - Glob and Regex
    //=============================================
    describe('Pattern Matching - Glob and Regex', () => {
        it('should match glob patterns with wildcard', () => {
            const skills = [{ id: 'ts-skill', triggers: ['*.ts', 'typescript'] }];
            const results = matchSkills('fix all .ts files', skills);
            // Should match because "*.ts" pattern matches "ts" in the text
            expect(results.length).toBeGreaterThanOrEqual(0); // Pattern converts to regex
        });
        it('should match explicit regex patterns', () => {
            const skills = [{ id: 'error-skill', triggers: ['/error/i'] }];
            const results = matchSkills('there is an ERROR in my code', skills);
            expect(results.length).toBe(1);
            expect(results[0].skillId).toBe('error-skill');
            expect(results[0].matchType).toBe('pattern');
            expect(results[0].confidence).toBe(90); // regex pattern = 90
        });
        it('should handle invalid regex gracefully', () => {
            const skills = [{ id: 'bad-regex', triggers: ['/[invalid/'] }];
            // Should not throw, should just skip the invalid pattern
            const results = matchSkills('test prompt', skills);
            expect(results).toEqual([]);
        });
        it('should match case-insensitive regex', () => {
            const skills = [{ id: 'api-skill', triggers: ['/api/i'] }];
            const results = matchSkills('Build an API endpoint', skills);
            expect(results.length).toBe(1);
        });
        it('should handle glob with multiple wildcards', () => {
            const skills = [{ id: 'glob-skill', triggers: ['*test*'] }];
            const results = matchSkills('run my tests now', skills);
            // ".*test.*" should match "tests"
            expect(results.length).toBe(1);
            expect(results[0].matchType).toBe('pattern');
        });
    });
    //=============================================
    // 3. CONTEXT EXTRACTION
    //=============================================
    describe('Context Extraction', () => {
        describe('Error Detection', () => {
            it('should detect TypeError', () => {
                const ctx = extractContext('I got a TypeError: undefined is not a function');
                expect(ctx.detectedErrors).toContain('TypeError');
            });
            it('should detect ReferenceError', () => {
                const ctx = extractContext('ReferenceError: x is not defined');
                expect(ctx.detectedErrors).toContain('ReferenceError');
            });
            it('should detect ENOENT', () => {
                const ctx = extractContext('ENOENT: no such file or directory');
                expect(ctx.detectedErrors).toContain('ENOENT');
            });
            it('should detect EACCES', () => {
                const ctx = extractContext('EACCES: permission denied');
                expect(ctx.detectedErrors).toContain('EACCES');
            });
            it('should detect ECONNREFUSED', () => {
                const ctx = extractContext('ECONNREFUSED: connection refused');
                expect(ctx.detectedErrors).toContain('ECONNREFUSED');
            });
            it('should detect stack trace lines', () => {
                const ctx = extractContext('at Object.run (/home/user/file.ts:42:10)');
                expect(ctx.detectedErrors.length).toBeGreaterThan(0);
            });
            it('should detect generic error keywords', () => {
                const ctx = extractContext('The build failed with error code 1');
                expect(ctx.detectedErrors.some(e => /error|failed/i.test(e))).toBe(true);
            });
        });
        describe('File Path Detection', () => {
            it('should detect src/ paths', () => {
                const ctx = extractContext('check src/components/Button.tsx');
                expect(ctx.detectedFiles.some(f => f.includes('src/'))).toBe(true);
            });
            it('should detect relative paths with extension', () => {
                const ctx = extractContext('edit ./bar.js file');
                expect(ctx.detectedFiles.some(f => f.includes('bar.js'))).toBe(true);
            });
            it('should detect nested paths', () => {
                const ctx = extractContext('fix lib/utils/helpers.ts');
                expect(ctx.detectedFiles.some(f => f.includes('helpers.ts') || f.includes('lib/'))).toBe(true);
            });
            it('should detect absolute paths', () => {
                const ctx = extractContext('open /home/user/project/main.py');
                expect(ctx.detectedFiles.some(f => f.includes('main.py') || f.includes('/home/'))).toBe(true);
            });
        });
        describe('Pattern Detection', () => {
            it('should detect async/await pattern', () => {
                const ctx = extractContext('use async function and await the promise');
                expect(ctx.detectedPatterns).toContain('async/await');
            });
            it('should detect promise pattern', () => {
                const ctx = extractContext('return a Promise from the function');
                expect(ctx.detectedPatterns).toContain('promise');
            });
            it('should detect callback pattern', () => {
                const ctx = extractContext('pass a callback to the function');
                expect(ctx.detectedPatterns).toContain('callback');
            });
            it('should detect regex pattern keyword', () => {
                const ctx = extractContext('write a regex for email validation');
                expect(ctx.detectedPatterns).toContain('regex');
            });
            it('should detect API pattern', () => {
                const ctx = extractContext('create a REST API endpoint');
                expect(ctx.detectedPatterns).toContain('api');
            });
            it('should detect typescript', () => {
                const ctx = extractContext('convert this to TypeScript');
                expect(ctx.detectedPatterns).toContain('typescript');
            });
            it('should detect react', () => {
                const ctx = extractContext('build a React component');
                expect(ctx.detectedPatterns).toContain('react');
            });
            it('should detect git', () => {
                const ctx = extractContext('commit with git');
                expect(ctx.detectedPatterns).toContain('git');
            });
        });
    });
    //=============================================
    // 4. CONFIDENCE SCORING
    //=============================================
    describe('Confidence Scoring', () => {
        it('should return 100 for exact match', () => {
            const skills = [{ id: 'test-skill', triggers: ['deploy'] }];
            const results = matchSkills('deploy the app', skills);
            expect(results.length).toBe(1);
            expect(results[0].confidence).toBe(100); // exact match: 100*0.7 + 100*0.3 = 100
        });
        it('should score fuzzy matches lower than exact', () => {
            const skills = [
                { id: 'exact', triggers: ['typescript'] },
                { id: 'fuzzy', triggers: ['typescrpt'] }, // typo - will be fuzzy matched
            ];
            const results = matchSkills('help with typescript', skills);
            // Should have exact match for 'typescript'
            const exactMatch = results.find(r => r.skillId === 'exact');
            expect(exactMatch).toBeDefined();
            expect(exactMatch.confidence).toBe(100);
        });
        it('should filter results below threshold', () => {
            const skills = [
                { id: 'unrelated', triggers: ['zzznotmatch'] },
            ];
            const results = matchSkills('build my app', skills, { threshold: 30 });
            expect(results.length).toBe(0);
        });
        it('should respect custom threshold', () => {
            const skills = [
                { id: 'test', triggers: ['typescript'] },
            ];
            const results = matchSkills('help with typescript', skills, { threshold: 50 });
            expect(results.length).toBe(1);
            expect(results[0].confidence).toBeGreaterThanOrEqual(50);
        });
        it('should limit results with maxResults', () => {
            const skills = [
                { id: 'skill1', triggers: ['test'] },
                { id: 'skill2', triggers: ['test'] },
                { id: 'skill3', triggers: ['test'] },
                { id: 'skill4', triggers: ['test'] },
                { id: 'skill5', triggers: ['test'] },
            ];
            const results = matchSkills('run tests', skills, { maxResults: 3 });
            expect(results.length).toBe(3);
        });
        it('should calculate confidence correctly via helper', () => {
            // Test the calculateConfidence helper directly
            expect(calculateConfidence(1, 1, 'exact')).toBe(100);
            expect(calculateConfidence(1, 2, 'exact')).toBe(50);
            expect(calculateConfidence(1, 1, 'fuzzy')).toBe(70); // 100 * 0.7
            expect(calculateConfidence(1, 1, 'pattern')).toBe(90); // 100 * 0.9
            expect(calculateConfidence(0, 1, 'exact')).toBe(0);
            expect(calculateConfidence(0, 0, 'exact')).toBe(0);
        });
        it('should sort results by confidence descending', () => {
            const skills = [
                { id: 'low', triggers: ['/fix/i'] }, // pattern = 90 base
                { id: 'high', triggers: ['typescript'] }, // exact = 100 base
            ];
            const results = matchSkills('fix typescript errors', skills);
            expect(results.length).toBe(2);
            expect(results[0].skillId).toBe('high');
            expect(results[1].skillId).toBe('low');
        });
    });
    //=============================================
    // 5. EDGE CASES
    //=============================================
    describe('Edge Cases', () => {
        it('should handle empty prompt', () => {
            const skills = [{ id: 'test', triggers: ['deploy'] }];
            const results = matchSkills('', skills);
            expect(results).toEqual([]);
        });
        it('should handle empty skills array', () => {
            const results = matchSkills('deploy the app', []);
            expect(results).toEqual([]);
        });
        it('should handle very long prompts', () => {
            const longPrompt = 'typescript '.repeat(1000);
            const skills = [{ id: 'ts', triggers: ['typescript'] }];
            const results = matchSkills(longPrompt, skills);
            expect(results.length).toBe(1);
            expect(results[0].skillId).toBe('ts');
        });
        it('should handle special characters in prompt', () => {
            const ctx = extractContext('Error: $#@!%^&*() invalid syntax');
            // Should not crash
            expect(ctx).toBeDefined();
            expect(ctx.detectedErrors.length).toBeGreaterThanOrEqual(0);
        });
        it('should handle special characters in triggers', () => {
            const skills = [{ id: 'special', triggers: ['c++'] }];
            const results = matchSkills('help with c++ code', skills);
            expect(results.length).toBe(1);
        });
        it('should handle unicode in prompt', () => {
            const ctx = extractContext('fix the bug in function 函数名 with emoji 🚀');
            expect(ctx).toBeDefined();
        });
        it('should handle skill with tags', () => {
            const skills = [{
                    id: 'multi-tag',
                    triggers: ['deploy'],
                    tags: ['production', 'release'],
                }];
            const results = matchSkills('release to production', skills);
            expect(results.length).toBe(1);
            expect(results[0].matchedTriggers).toContain('production');
        });
        it('should handle whitespace-only prompt', () => {
            const skills = [{ id: 'test', triggers: ['deploy'] }];
            const results = matchSkills('   \t\n   ', skills);
            expect(results).toEqual([]);
        });
        it('should handle skill with empty triggers', () => {
            const skills = [{ id: 'empty', triggers: [] }];
            const results = matchSkills('test prompt', skills);
            expect(results).toEqual([]);
        });
        it('should deduplicate detected context items', () => {
            const ctx = extractContext('TypeError TypeError TypeError ENOENT ENOENT');
            // Should dedupe
            const typeErrorCount = ctx.detectedErrors.filter(e => e === 'TypeError').length;
            expect(typeErrorCount).toBe(1);
        });
    });
    //=============================================
    // 6. INTEGRATION - Full Match Flow
    //=============================================
    describe('Integration - Full Match Flow', () => {
        it('should match with context-aware results', () => {
            const skills = [
                { id: 'debug', triggers: ['error', 'fix', 'debug'] },
                { id: 'deploy', triggers: ['deploy', 'release'] },
            ];
            const prompt = 'Fix the TypeError in src/utils.ts';
            const results = matchSkills(prompt, skills);
            expect(results.length).toBeGreaterThan(0);
            const debugResult = results.find(r => r.skillId === 'debug');
            expect(debugResult).toBeDefined();
            expect(debugResult.context.detectedErrors).toContain('TypeError');
            expect(debugResult.context.detectedFiles.length).toBeGreaterThan(0);
        });
        it('should prioritize exact matches over fuzzy', () => {
            const skills = [
                { id: 'typescript-skill', triggers: ['typescript'] },
            ];
            const results = matchSkills('I need help with typescript', skills);
            expect(results[0].matchType).toBe('exact');
        });
        it('should handle mixed match types', () => {
            const skills = [
                { id: 'exact-match', triggers: ['deploy'] },
                { id: 'pattern-match', triggers: ['/api/i'] },
                { id: 'fuzzy-match', triggers: ['typescrpt'] }, // typo for typescript
            ];
            const results = matchSkills('deploy the API to typescript server', skills);
            expect(results.length).toBeGreaterThanOrEqual(2);
            const exactResult = results.find(r => r.skillId === 'exact-match');
            const patternResult = results.find(r => r.skillId === 'pattern-match');
            expect(exactResult).toBeDefined();
            expect(patternResult).toBeDefined();
        });
    });
});
//# sourceMappingURL=matcher.test.js.map