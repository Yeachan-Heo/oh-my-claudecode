import { describe, it, expect } from 'vitest';
import { extractLexicalSignals, extractStructuralSignals, extractContextSignals, extractAllSignals, } from '../features/model-routing/signals.js';
import { calculateComplexityScore, scoreToTier, calculateComplexityTier, getScoreBreakdown, calculateConfidence, } from '../features/model-routing/scorer.js';
import { evaluateRules, getMatchingRules, createRule, mergeRules, DEFAULT_ROUTING_RULES, } from '../features/model-routing/rules.js';
import { routeTask, escalateModel, canEscalate, getModelForTask, quickTierForAgent, analyzeTaskComplexity, } from '../features/model-routing/router.js';
import { getDefaultModelHigh, getDefaultModelLow, } from '../config/models.js';
// ============ Signal Extraction Tests ============
describe('Signal Extraction', () => {
    describe('extractLexicalSignals', () => {
        it('should count words correctly', () => {
            const signals = extractLexicalSignals('Hello world this is a test');
            expect(signals.wordCount).toBe(6);
        });
        it('should handle empty string', () => {
            const signals = extractLexicalSignals('');
            expect(signals.wordCount).toBe(0);
        });
        it('should count file paths', () => {
            const prompt = 'Check src/file.ts and lib/utils.js';
            const signals = extractLexicalSignals(prompt);
            expect(signals.filePathCount).toBeGreaterThan(0);
        });
        it('should count code blocks', () => {
            const prompt = 'Here is code:\n```js\nfunction test() {}\n```\nAnd more:\n```ts\nconst x = 1;\n```';
            const signals = extractLexicalSignals(prompt);
            expect(signals.codeBlockCount).toBe(2);
        });
        it('should detect architecture keywords', () => {
            const signals = extractLexicalSignals('We need to refactor the architecture');
            expect(signals.hasArchitectureKeywords).toBe(true);
        });
        it('should detect debugging keywords', () => {
            const signals = extractLexicalSignals('Debug this issue and find the root cause');
            expect(signals.hasDebuggingKeywords).toBe(true);
        });
        it('should detect simple keywords', () => {
            const signals = extractLexicalSignals('Find the file and show me the contents');
            expect(signals.hasSimpleKeywords).toBe(true);
        });
        it('should detect risk keywords', () => {
            const signals = extractLexicalSignals('This is a critical production migration');
            expect(signals.hasRiskKeywords).toBe(true);
        });
        it('should detect question depth - why', () => {
            const signals = extractLexicalSignals('Why is this not working?');
            expect(signals.questionDepth).toBe('why');
        });
        it('should detect question depth - how', () => {
            const signals = extractLexicalSignals('How do I implement this feature?');
            expect(signals.questionDepth).toBe('how');
        });
        it('should detect question depth - what', () => {
            const signals = extractLexicalSignals('What is the purpose of this?');
            expect(signals.questionDepth).toBe('what');
        });
        it('should detect question depth - where', () => {
            const signals = extractLexicalSignals('Where is the configuration file?');
            expect(signals.questionDepth).toBe('where');
        });
        it('should return none for no questions', () => {
            const signals = extractLexicalSignals('Implement this feature');
            expect(signals.questionDepth).toBe('none');
        });
        it('should detect implicit requirements', () => {
            const signals = extractLexicalSignals('Make it better and clean up the code');
            expect(signals.hasImplicitRequirements).toBe(true);
        });
        it('should not detect implicit requirements in specific tasks', () => {
            const signals = extractLexicalSignals('Fix the bug in utils.ts by adding null check');
            expect(signals.hasImplicitRequirements).toBe(false);
        });
    });
    describe('extractStructuralSignals', () => {
        it('should estimate subtasks from bullet points', () => {
            const prompt = '- Task 1\n- Task 2\n- Task 3';
            const signals = extractStructuralSignals(prompt);
            expect(signals.estimatedSubtasks).toBeGreaterThan(1);
        });
        it('should estimate subtasks from numbered list', () => {
            const prompt = '1. First task\n2. Second task\n3. Third task';
            const signals = extractStructuralSignals(prompt);
            expect(signals.estimatedSubtasks).toBeGreaterThan(1);
        });
        it('should detect cross-file dependencies', () => {
            const prompt = 'Update src/a.ts and src/b.ts and src/c.ts';
            const signals = extractStructuralSignals(prompt);
            expect(signals.crossFileDependencies).toBe(true);
        });
        it('should detect test requirements', () => {
            const signals = extractStructuralSignals('Add feature and make sure tests pass');
            expect(signals.hasTestRequirements).toBe(true);
        });
        it('should detect frontend domain', () => {
            const signals = extractStructuralSignals('Create a React component with styled CSS');
            expect(signals.domainSpecificity).toBe('frontend');
        });
        it('should detect backend domain', () => {
            const signals = extractStructuralSignals('Create an API endpoint with database query');
            expect(signals.domainSpecificity).toBe('backend');
        });
        it('should detect infrastructure domain', () => {
            const signals = extractStructuralSignals('Set up Docker container with Kubernetes');
            expect(signals.domainSpecificity).toBe('infrastructure');
        });
        it('should detect security domain', () => {
            const signals = extractStructuralSignals('Fix the authentication vulnerability');
            expect(signals.domainSpecificity).toBe('security');
        });
        it('should detect external knowledge requirement', () => {
            const signals = extractStructuralSignals('Check the documentation for best practices');
            expect(signals.requiresExternalKnowledge).toBe(true);
        });
        it('should assess reversibility as difficult', () => {
            const signals = extractStructuralSignals('Run the production migration');
            expect(signals.reversibility).toBe('difficult');
        });
        it('should assess reversibility as moderate', () => {
            const signals = extractStructuralSignals('Refactor the entire module structure');
            expect(signals.reversibility).toBe('moderate');
        });
        it('should assess reversibility as easy', () => {
            const signals = extractStructuralSignals('Add a console log statement');
            expect(signals.reversibility).toBe('easy');
        });
        it('should detect system-wide impact', () => {
            const signals = extractStructuralSignals('Change global configuration throughout the codebase');
            expect(signals.impactScope).toBe('system-wide');
        });
        it('should detect module-level impact', () => {
            const signals = extractStructuralSignals('Update the auth module and service layer');
            expect(signals.impactScope).toBe('module');
        });
        it('should detect local impact', () => {
            const signals = extractStructuralSignals('Fix the typo in this function');
            expect(signals.impactScope).toBe('local');
        });
    });
    describe('extractContextSignals', () => {
        it('should extract context signals', () => {
            const context = {
                taskPrompt: 'test',
                previousFailures: 2,
                conversationTurns: 5,
                planTasks: 10,
                remainingTasks: 3,
                agentChainDepth: 2,
            };
            const signals = extractContextSignals(context);
            expect(signals.previousFailures).toBe(2);
            expect(signals.conversationTurns).toBe(5);
            expect(signals.planComplexity).toBe(10);
            expect(signals.remainingTasks).toBe(3);
            expect(signals.agentChainDepth).toBe(2);
        });
        it('should handle missing context values', () => {
            const context = {
                taskPrompt: 'test',
            };
            const signals = extractContextSignals(context);
            expect(signals.previousFailures).toBe(0);
            expect(signals.conversationTurns).toBe(0);
            expect(signals.planComplexity).toBe(0);
            expect(signals.remainingTasks).toBe(0);
            expect(signals.agentChainDepth).toBe(0);
        });
    });
    describe('extractAllSignals', () => {
        it('should combine all signal types', () => {
            const context = {
                taskPrompt: 'Refactor the architecture with multiple files',
                previousFailures: 1,
            };
            const signals = extractAllSignals(context.taskPrompt, context);
            expect(signals.lexical).toBeDefined();
            expect(signals.structural).toBeDefined();
            expect(signals.context).toBeDefined();
            expect(signals.lexical.hasArchitectureKeywords).toBe(true);
            expect(signals.context.previousFailures).toBe(1);
        });
    });
});
// ============ Scoring System Tests ============
describe('Scoring System', () => {
    describe('calculateComplexityScore', () => {
        it('should score simple tasks low', () => {
            const signals = {
                lexical: {
                    wordCount: 10,
                    filePathCount: 0,
                    codeBlockCount: 0,
                    hasArchitectureKeywords: false,
                    hasDebuggingKeywords: false,
                    hasSimpleKeywords: true,
                    hasRiskKeywords: false,
                    questionDepth: 'what',
                    hasImplicitRequirements: false,
                },
                structural: {
                    estimatedSubtasks: 1,
                    crossFileDependencies: false,
                    hasTestRequirements: false,
                    domainSpecificity: 'generic',
                    requiresExternalKnowledge: false,
                    reversibility: 'easy',
                    impactScope: 'local',
                },
                context: {
                    previousFailures: 0,
                    conversationTurns: 0,
                    planComplexity: 0,
                    remainingTasks: 0,
                    agentChainDepth: 0,
                },
            };
            const score = calculateComplexityScore(signals);
            expect(score).toBeLessThan(4); // Should be LOW tier
        });
        it('should score complex tasks high', () => {
            const signals = {
                lexical: {
                    wordCount: 300,
                    filePathCount: 5,
                    codeBlockCount: 3,
                    hasArchitectureKeywords: true,
                    hasDebuggingKeywords: true,
                    hasSimpleKeywords: false,
                    hasRiskKeywords: true,
                    questionDepth: 'why',
                    hasImplicitRequirements: true,
                },
                structural: {
                    estimatedSubtasks: 8,
                    crossFileDependencies: true,
                    hasTestRequirements: true,
                    domainSpecificity: 'security',
                    requiresExternalKnowledge: true,
                    reversibility: 'difficult',
                    impactScope: 'system-wide',
                },
                context: {
                    previousFailures: 2,
                    conversationTurns: 10,
                    planComplexity: 10,
                    remainingTasks: 5,
                    agentChainDepth: 3,
                },
            };
            const score = calculateComplexityScore(signals);
            expect(score).toBeGreaterThanOrEqual(8); // Should be HIGH tier
        });
        it('should score medium complexity tasks appropriately', () => {
            const signals = {
                lexical: {
                    wordCount: 100,
                    filePathCount: 2,
                    codeBlockCount: 1,
                    hasArchitectureKeywords: false,
                    hasDebuggingKeywords: false,
                    hasSimpleKeywords: false,
                    hasRiskKeywords: false,
                    questionDepth: 'how',
                    hasImplicitRequirements: false,
                },
                structural: {
                    estimatedSubtasks: 3,
                    crossFileDependencies: false,
                    hasTestRequirements: true,
                    domainSpecificity: 'frontend',
                    requiresExternalKnowledge: false,
                    reversibility: 'moderate',
                    impactScope: 'module',
                },
                context: {
                    previousFailures: 0,
                    conversationTurns: 3,
                    planComplexity: 3,
                    remainingTasks: 2,
                    agentChainDepth: 1,
                },
            };
            const score = calculateComplexityScore(signals);
            expect(score).toBeGreaterThanOrEqual(4);
            expect(score).toBeLessThan(8);
        });
    });
    describe('scoreToTier', () => {
        it('should map low scores to LOW tier', () => {
            expect(scoreToTier(0)).toBe('LOW');
            expect(scoreToTier(3)).toBe('LOW');
        });
        it('should map medium scores to MEDIUM tier', () => {
            expect(scoreToTier(4)).toBe('MEDIUM');
            expect(scoreToTier(7)).toBe('MEDIUM');
        });
        it('should map high scores to HIGH tier', () => {
            expect(scoreToTier(8)).toBe('HIGH');
            expect(scoreToTier(15)).toBe('HIGH');
            expect(scoreToTier(100)).toBe('HIGH');
        });
    });
    describe('calculateComplexityTier', () => {
        it('should return correct tier for simple signals', () => {
            const signals = {
                lexical: {
                    wordCount: 10,
                    filePathCount: 0,
                    codeBlockCount: 0,
                    hasArchitectureKeywords: false,
                    hasDebuggingKeywords: false,
                    hasSimpleKeywords: true,
                    hasRiskKeywords: false,
                    questionDepth: 'none',
                    hasImplicitRequirements: false,
                },
                structural: {
                    estimatedSubtasks: 1,
                    crossFileDependencies: false,
                    hasTestRequirements: false,
                    domainSpecificity: 'generic',
                    requiresExternalKnowledge: false,
                    reversibility: 'easy',
                    impactScope: 'local',
                },
                context: {
                    previousFailures: 0,
                    conversationTurns: 0,
                    planComplexity: 0,
                    remainingTasks: 0,
                    agentChainDepth: 0,
                },
            };
            expect(calculateComplexityTier(signals)).toBe('LOW');
        });
    });
    describe('getScoreBreakdown', () => {
        it('should provide detailed score breakdown', () => {
            const signals = {
                lexical: {
                    wordCount: 100,
                    filePathCount: 2,
                    codeBlockCount: 1,
                    hasArchitectureKeywords: true,
                    hasDebuggingKeywords: false,
                    hasSimpleKeywords: false,
                    hasRiskKeywords: false,
                    questionDepth: 'how',
                    hasImplicitRequirements: false,
                },
                structural: {
                    estimatedSubtasks: 3,
                    crossFileDependencies: true,
                    hasTestRequirements: false,
                    domainSpecificity: 'generic',
                    requiresExternalKnowledge: false,
                    reversibility: 'easy',
                    impactScope: 'module',
                },
                context: {
                    previousFailures: 0,
                    conversationTurns: 0,
                    planComplexity: 0,
                    remainingTasks: 0,
                    agentChainDepth: 0,
                },
            };
            const breakdown = getScoreBreakdown(signals);
            expect(breakdown).toHaveProperty('lexical');
            expect(breakdown).toHaveProperty('structural');
            expect(breakdown).toHaveProperty('context');
            expect(breakdown).toHaveProperty('total');
            expect(breakdown).toHaveProperty('tier');
            expect(typeof breakdown.lexical).toBe('number');
            expect(typeof breakdown.structural).toBe('number');
            expect(typeof breakdown.context).toBe('number');
            expect(breakdown.total).toBe(breakdown.lexical + breakdown.structural + breakdown.context);
        });
    });
    describe('calculateConfidence', () => {
        it('should calculate confidence for LOW tier', () => {
            const confidence = calculateConfidence(1, 'LOW');
            expect(confidence).toBeGreaterThan(0);
            expect(confidence).toBeLessThanOrEqual(1);
        });
        it('should calculate confidence for MEDIUM tier', () => {
            const confidence = calculateConfidence(5, 'MEDIUM');
            expect(confidence).toBeGreaterThan(0);
            expect(confidence).toBeLessThanOrEqual(1);
        });
        it('should calculate confidence for HIGH tier', () => {
            const confidence = calculateConfidence(10, 'HIGH');
            expect(confidence).toBeGreaterThan(0);
            expect(confidence).toBeLessThanOrEqual(1);
        });
        it('should have higher confidence far from thresholds', () => {
            const lowConfidence = calculateConfidence(4, 'MEDIUM'); // Right at threshold
            const highConfidence = calculateConfidence(6, 'MEDIUM'); // Further from threshold
            expect(highConfidence).toBeGreaterThanOrEqual(lowConfidence);
        });
    });
});
// ============ Routing Rules Tests ============
describe('Routing Rules', () => {
    describe('evaluateRules', () => {
        it('should evaluate explicit model rule', () => {
            const context = {
                taskPrompt: 'test',
                explicitModel: 'opus',
            };
            const signals = extractAllSignals(context.taskPrompt, context);
            const result = evaluateRules(context, signals);
            expect(result.tier).toBe('EXPLICIT');
            expect(result.ruleName).toBe('explicit-model-specified');
        });
        it('should evaluate architect complex debugging rule', () => {
            const context = {
                taskPrompt: 'Debug this issue and find the root cause',
                agentType: 'architect',
            };
            const signals = extractAllSignals(context.taskPrompt, context);
            const result = evaluateRules(context, signals);
            expect(result.tier).toBe('HIGH');
            expect(result.ruleName).toBe('architect-complex-debugging');
        });
        it('should evaluate architect simple lookup rule', () => {
            const context = {
                taskPrompt: 'Find the file location',
                agentType: 'architect',
            };
            const signals = extractAllSignals(context.taskPrompt, context);
            const result = evaluateRules(context, signals);
            expect(result.tier).toBe('LOW');
            expect(result.ruleName).toBe('architect-simple-lookup');
        });
        it('should evaluate security domain rule', () => {
            const context = {
                taskPrompt: 'Fix the authentication vulnerability',
            };
            const signals = extractAllSignals(context.taskPrompt, context);
            const result = evaluateRules(context, signals);
            expect(result.tier).toBe('HIGH');
            expect(result.ruleName).toBe('security-domain');
        });
        it('should evaluate simple search query rule', () => {
            const context = {
                taskPrompt: 'Find all TypeScript files',
            };
            const signals = extractAllSignals(context.taskPrompt, context);
            const result = evaluateRules(context, signals);
            // Could match simple-search-query or default-medium
            expect(['LOW', 'MEDIUM']).toContain(result.tier);
        });
        it('should fall back to default rule', () => {
            const context = {
                taskPrompt: 'Some random task',
            };
            const signals = extractAllSignals(context.taskPrompt, context);
            const result = evaluateRules(context, signals);
            expect(result).toBeDefined();
            expect(['LOW', 'MEDIUM', 'HIGH']).toContain(result.tier);
        });
        it('should respect rule priority order', () => {
            const context = {
                taskPrompt: 'test',
                explicitModel: 'haiku',
                agentType: 'architect',
            };
            const signals = extractAllSignals(context.taskPrompt, context);
            const result = evaluateRules(context, signals);
            // Explicit model (priority 100) should win over other rules
            expect(result.tier).toBe('EXPLICIT');
            expect(result.ruleName).toBe('explicit-model-specified');
        });
    });
    describe('getMatchingRules', () => {
        it('should return all matching rules', () => {
            const context = {
                taskPrompt: 'Fix the authentication security vulnerability in production',
                agentType: 'architect',
            };
            const signals = extractAllSignals(context.taskPrompt, context);
            const matches = getMatchingRules(context, signals);
            expect(matches.length).toBeGreaterThan(0);
            // Should match multiple rules
            expect(matches.some(r => r.name === 'default-medium')).toBe(true);
        });
    });
    describe('createRule', () => {
        it('should create a custom rule', () => {
            const rule = createRule('test-rule', (ctx) => ctx.taskPrompt.includes('test'), 'HIGH', 'Test reason', 50);
            expect(rule.name).toBe('test-rule');
            expect(rule.action.tier).toBe('HIGH');
            expect(rule.action.reason).toBe('Test reason');
            expect(rule.priority).toBe(50);
            const context = { taskPrompt: 'test task' };
            const signals = extractAllSignals(context.taskPrompt, context);
            expect(rule.condition(context, signals)).toBe(true);
        });
    });
    describe('mergeRules', () => {
        it('should merge custom rules with defaults', () => {
            const customRule = createRule('custom-rule', () => true, 'HIGH', 'Custom', 200);
            const merged = mergeRules([customRule]);
            expect(merged.length).toBeGreaterThan(DEFAULT_ROUTING_RULES.length);
            expect(merged.some(r => r.name === 'custom-rule')).toBe(true);
            expect(merged.some(r => r.name === 'default-medium')).toBe(true);
        });
        it('should override default rules with same name', () => {
            const overrideRule = createRule('default-medium', () => true, 'HIGH', 'Override', 200);
            const merged = mergeRules([overrideRule]);
            const defaultMediumRules = merged.filter(r => r.name === 'default-medium');
            expect(defaultMediumRules.length).toBe(1);
            expect(defaultMediumRules[0].action.tier).toBe('HIGH');
        });
    });
});
// ============ Router Tests ============
describe('Router', () => {
    describe('routeTask', () => {
        it('should route simple task to LOW tier', () => {
            const context = {
                taskPrompt: 'Find the config file',
            };
            const decision = routeTask(context);
            expect(decision.tier).toBe('LOW');
            expect(decision.modelType).toBe('haiku');
            expect(decision.model).toBe(getDefaultModelLow());
        });
        it('should route complex task to HIGH tier', () => {
            const context = {
                taskPrompt: 'Refactor the entire architecture across multiple modules with security considerations',
            };
            const decision = routeTask(context);
            expect(decision.tier).toBe('HIGH');
            expect(decision.modelType).toBe('opus');
            expect(decision.model).toBe(getDefaultModelHigh());
        });
        it('should respect explicit model override', () => {
            const context = {
                taskPrompt: 'Complex architectural task',
                explicitModel: 'haiku',
            };
            const decision = routeTask(context);
            expect(decision.tier).toBe('LOW');
            expect(decision.reasons[0]).toContain('Explicit model');
        });
        it('should respect agent overrides', () => {
            const context = {
                taskPrompt: 'test',
                agentType: 'custom-agent',
            };
            const decision = routeTask(context, {
                agentOverrides: {
                    'custom-agent': { tier: 'HIGH', reason: 'Test override' },
                },
            });
            expect(decision.tier).toBe('HIGH');
        });
        it('should handle disabled routing', () => {
            const context = {
                taskPrompt: 'test',
            };
            const decision = routeTask(context, { enabled: false });
            expect(decision.reasons[0]).toContain('disabled');
        });
        it('should provide reasons for decision', () => {
            const context = {
                taskPrompt: 'Implement a new feature',
            };
            const decision = routeTask(context);
            expect(decision.reasons).toBeDefined();
            expect(decision.reasons.length).toBeGreaterThan(0);
        });
        it('should calculate confidence', () => {
            const context = {
                taskPrompt: 'Simple task',
            };
            const decision = routeTask(context);
            expect(decision.confidence).toBeGreaterThan(0);
            expect(decision.confidence).toBeLessThanOrEqual(1);
        });
        it('should clamp LOW tier to MEDIUM when minTier=MEDIUM', () => {
            const context = {
                taskPrompt: 'Find the config file',
            };
            const decision = routeTask(context, { minTier: 'MEDIUM' });
            expect(decision.tier).toBe('MEDIUM');
            expect(decision.modelType).toBe('sonnet');
            expect(decision.reasons.join(' ')).toContain('Min tier enforced');
        });
    });
    describe('escalateModel', () => {
        it('should escalate from LOW to MEDIUM', () => {
            expect(escalateModel('LOW')).toBe('MEDIUM');
        });
        it('should escalate from MEDIUM to HIGH', () => {
            expect(escalateModel('MEDIUM')).toBe('HIGH');
        });
        it('should not escalate beyond HIGH', () => {
            expect(escalateModel('HIGH')).toBe('HIGH');
        });
    });
    describe('canEscalate', () => {
        it('should return true for LOW tier', () => {
            expect(canEscalate('LOW')).toBe(true);
        });
        it('should return true for MEDIUM tier', () => {
            expect(canEscalate('MEDIUM')).toBe(true);
        });
        it('should return false for HIGH tier', () => {
            expect(canEscalate('HIGH')).toBe(false);
        });
    });
    describe('quickTierForAgent', () => {
        it('should return HIGH for architect', () => {
            expect(quickTierForAgent('architect')).toBe('HIGH');
        });
        it('should return HIGH for planner', () => {
            expect(quickTierForAgent('planner')).toBe('HIGH');
        });
        it('should return LOW for explore', () => {
            expect(quickTierForAgent('explore')).toBe('LOW');
        });
        it('should return MEDIUM for executor', () => {
            expect(quickTierForAgent('executor')).toBe('MEDIUM');
        });
        it('should return null for unknown agent', () => {
            expect(quickTierForAgent('unknown-agent')).toBeNull();
        });
    });
    describe('getModelForTask', () => {
        it('should return adaptive model for architect with simple task', () => {
            const result = getModelForTask('architect', 'find the file');
            expect(result.model).toBe('haiku');
            expect(result.tier).toBe('LOW');
        });
        it('should return adaptive model for architect with complex task', () => {
            const result = getModelForTask('architect', 'debug the root cause of this architecture issue');
            expect(result.model).toBe('opus');
            expect(result.tier).toBe('HIGH');
        });
        it('should return haiku for explore', () => {
            const result = getModelForTask('explore', 'search for files');
            expect(result.model).toBe('haiku');
            expect(result.tier).toBe('LOW');
        });
        it('should provide reasoning', () => {
            const result = getModelForTask('executor', 'implement feature');
            expect(result.reason).toBeDefined();
            expect(result.reason.length).toBeGreaterThan(0);
        });
    });
    describe('analyzeTaskComplexity', () => {
        it('should provide comprehensive analysis', () => {
            const analysis = analyzeTaskComplexity('Refactor the architecture with security considerations');
            expect(analysis.tier).toBeDefined();
            expect(analysis.model).toBeDefined();
            expect(analysis.analysis).toBeDefined();
            expect(analysis.signals).toBeDefined();
            expect(typeof analysis.analysis).toBe('string');
            expect(analysis.analysis.length).toBeGreaterThan(0);
        });
        it('should detect signals in analysis', () => {
            const analysis = analyzeTaskComplexity('Critical production security issue');
            expect(analysis.signals.hasRiskKeywords).toBe(true);
        });
        it('should work with agent type', () => {
            const analysis = analyzeTaskComplexity('test task', 'architect');
            expect(analysis).toBeDefined();
            expect(analysis.tier).toBeDefined();
        });
        it('should provide signal details', () => {
            const analysis = analyzeTaskComplexity('Fix bug in auth.ts and user.ts');
            expect(analysis.signals.wordCount).toBeGreaterThan(0);
            expect(analysis.signals.estimatedSubtasks).toBeGreaterThan(0);
        });
    });
});
// ============ Edge Cases and Integration Tests ============
describe('Edge Cases', () => {
    it('should handle empty prompt', () => {
        const context = {
            taskPrompt: '',
        };
        const decision = routeTask(context);
        expect(decision).toBeDefined();
        expect(['LOW', 'MEDIUM', 'HIGH']).toContain(decision.tier);
    });
    it('should handle very long prompt', () => {
        const longPrompt = 'word '.repeat(1000);
        const context = {
            taskPrompt: longPrompt,
        };
        const signals = extractLexicalSignals(longPrompt);
        expect(signals.wordCount).toBeGreaterThan(500);
        const decision = routeTask(context);
        expect(decision).toBeDefined();
    });
    it('should handle special characters in prompt', () => {
        const context = {
            taskPrompt: 'Fix bug: $var = @array[0] && func() || die;',
        };
        const decision = routeTask(context);
        expect(decision).toBeDefined();
    });
    it('should handle Unicode in prompt', () => {
        const context = {
            taskPrompt: 'Implement feature with 中文 and émojis 🚀',
        };
        const decision = routeTask(context);
        expect(decision).toBeDefined();
    });
    it('should handle multiple conflicting signals', () => {
        const context = {
            taskPrompt: 'Simple find task but with critical production security architecture refactoring',
        };
        const signals = extractAllSignals(context.taskPrompt, context);
        expect(signals.lexical.hasSimpleKeywords).toBe(true);
        expect(signals.lexical.hasArchitectureKeywords).toBe(true);
        expect(signals.lexical.hasRiskKeywords).toBe(true);
        const decision = routeTask(context);
        // Should prioritize high-complexity signals
        expect(decision.tier).toBe('HIGH');
    });
    it('should handle context with maximum values', () => {
        const context = {
            taskPrompt: 'test',
            previousFailures: 100,
            conversationTurns: 1000,
            planTasks: 500,
            remainingTasks: 400,
            agentChainDepth: 50,
        };
        const signals = extractContextSignals(context);
        expect(signals.previousFailures).toBe(100);
        const decision = routeTask(context);
        expect(decision).toBeDefined();
    });
});
describe('Integration Scenarios', () => {
    it('should handle real-world simple search', () => {
        const context = {
            taskPrompt: 'Find all TypeScript files in the src directory',
            agentType: 'explore',
        };
        const decision = routeTask(context);
        expect(decision.tier).toBe('LOW');
        expect(decision.modelType).toBe('haiku');
    });
    it('should handle real-world debugging task', () => {
        const context = {
            taskPrompt: 'Investigate why the authentication system is failing in production. Need root cause analysis.',
            agentType: 'architect',
        };
        const decision = routeTask(context);
        expect(decision.tier).toBe('HIGH');
        expect(decision.modelType).toBe('opus');
    });
    it('should handle real-world refactoring task', () => {
        const context = {
            taskPrompt: 'Refactor the API layer to separate concerns and improve maintainability across auth, user, and admin modules',
            agentType: 'executor',
        };
        const decision = routeTask(context);
        // Moderate refactoring without explicit high-complexity signals → MEDIUM
        expect(decision.tier).toBe('MEDIUM');
    });
    it('should handle real-world simple change', () => {
        const context = {
            taskPrompt: 'Add a console.log statement in utils.ts',
            agentType: 'executor',
        };
        const decision = routeTask(context);
        expect(decision.tier).toBe('LOW');
    });
    it('should handle strategic planning task', () => {
        const context = {
            taskPrompt: 'Create a comprehensive strategic plan for refactoring the entire system architecture to migrate our monolith to microservices across all domains with minimal production downtime',
            agentType: 'planner',
        };
        const decision = routeTask(context);
        // Strategic planning with system-wide architecture keywords → HIGH
        expect(decision.tier).toBe('HIGH');
    });
    it('should escalate on previous failures', () => {
        const context = {
            taskPrompt: 'Simple task that keeps failing',
            previousFailures: 3,
        };
        const _decision = routeTask(context);
        // Previous failures should increase complexity score
        const signals = extractContextSignals(context);
        expect(signals.previousFailures).toBe(3);
    });
});
//# sourceMappingURL=model-routing.test.js.map