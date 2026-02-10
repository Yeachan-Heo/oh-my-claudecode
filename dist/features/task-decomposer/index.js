/**
 * Task Decomposition Engine
 *
 * Analyzes tasks and splits them into parallelizable components
 * with non-overlapping file ownership.
 */
/**
 * Main entry point: decompose a task into parallelizable subtasks
 */
export async function decomposeTask(task, projectContext = { rootDir: process.cwd() }) {
    // Step 1: Analyze the task
    const analysis = analyzeTask(task, projectContext);
    // Step 2: Identify parallelizable components
    const components = identifyComponents(analysis, projectContext);
    // Step 3: Identify shared files
    const sharedFiles = identifySharedFiles(components, projectContext);
    // Step 4: Generate subtasks with file ownership
    const subtasks = generateSubtasks(components, analysis, projectContext);
    // Step 5: Assign non-overlapping file ownership
    assignFileOwnership(subtasks, sharedFiles, projectContext);
    // Step 6: Determine execution order
    const executionOrder = calculateExecutionOrder(subtasks);
    // Step 7: Validate decomposition
    const warnings = validateDecomposition(subtasks, sharedFiles);
    return {
        analysis,
        components,
        subtasks,
        sharedFiles,
        executionOrder,
        strategy: explainStrategy(analysis, components),
        warnings
    };
}
/**
 * Analyze task to understand structure and requirements
 */
export function analyzeTask(task, context) {
    const lower = task.toLowerCase();
    // Detect task type
    const type = detectTaskType(lower);
    // Detect complexity signals
    const complexity = estimateComplexity(lower, type);
    // Extract areas and technologies
    const areas = extractAreas(lower, type);
    const technologies = extractTechnologies(lower, context);
    const filePatterns = extractFilePatterns(lower, context);
    // Detect dependencies
    const dependencies = analyzeDependencies(areas, type);
    // Determine if parallelizable
    const isParallelizable = complexity > 0.3 && areas.length >= 2;
    const estimatedComponents = isParallelizable
        ? Math.max(2, Math.min(areas.length, 6))
        : 1;
    return {
        task,
        type,
        complexity,
        isParallelizable,
        estimatedComponents,
        areas,
        technologies,
        filePatterns,
        dependencies
    };
}
/**
 * Identify parallelizable components from analysis
 */
export function identifyComponents(analysis, context) {
    if (!analysis.isParallelizable) {
        // Single component for non-parallelizable tasks
        return [
            {
                id: 'main',
                name: 'Main Task',
                role: 'module',
                description: analysis.task,
                canParallelize: false,
                dependencies: [],
                effort: analysis.complexity,
                technologies: analysis.technologies
            }
        ];
    }
    // Select appropriate strategy
    const strategy = selectStrategy(analysis);
    const result = strategy.decompose(analysis, context);
    return result.components;
}
/**
 * Generate subtasks from components
 */
export function generateSubtasks(components, analysis, context) {
    return components.map((component) => {
        const subtask = {
            id: component.id,
            name: component.name,
            component,
            prompt: generatePromptForComponent(component, analysis, context),
            ownership: {
                componentId: component.id,
                patterns: [],
                files: [],
                potentialConflicts: []
            },
            blockedBy: component.dependencies,
            agentType: selectAgentType(component),
            modelTier: selectModelTier(component),
            acceptanceCriteria: generateAcceptanceCriteria(component, analysis),
            verification: generateVerificationSteps(component, analysis)
        };
        return subtask;
    });
}
/**
 * Assign non-overlapping file ownership to subtasks
 */
export function assignFileOwnership(subtasks, sharedFiles, context) {
    const assignments = new Map();
    for (const subtask of subtasks) {
        const patterns = inferFilePatterns(subtask.component, context);
        const files = inferSpecificFiles(subtask.component, context);
        subtask.ownership.patterns = patterns;
        subtask.ownership.files = files;
        // Track assignments for conflict detection
        for (const pattern of patterns) {
            if (!assignments.has(pattern)) {
                assignments.set(pattern, new Set());
            }
            assignments.get(pattern).add(subtask.id);
        }
    }
    // Detect conflicts
    for (const subtask of subtasks) {
        const conflicts = [];
        for (const pattern of subtask.ownership.patterns) {
            const owners = assignments.get(pattern);
            if (owners && owners.size > 1) {
                // Check if it's a shared file
                const isShared = sharedFiles.some((sf) => sf.pattern === pattern);
                if (!isShared) {
                    conflicts.push(pattern);
                }
            }
        }
        subtask.ownership.potentialConflicts = conflicts;
    }
}
/**
 * Identify files that require orchestration (shared across components)
 */
export function identifySharedFiles(components, context) {
    const sharedFiles = [];
    // Common shared files
    const commonShared = [
        'package.json',
        'tsconfig.json',
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'README.md',
        '.gitignore',
        '.env',
        '.env.example',
        'docker-compose.yml',
        'Dockerfile'
    ];
    for (const file of commonShared) {
        const sharedBy = components.map((c) => c.id);
        if (sharedBy.length > 0) {
            sharedFiles.push({
                pattern: file,
                reason: 'Common configuration file',
                sharedBy,
                requiresOrchestration: true
            });
        }
    }
    // Detect framework-specific shared files
    if (context.technologies?.includes('react') || context.technologies?.includes('next')) {
        sharedFiles.push({
            pattern: 'src/types/**',
            reason: 'Shared TypeScript types',
            sharedBy: components.map((c) => c.id),
            requiresOrchestration: false
        });
    }
    return sharedFiles;
}
// ============================================================================
// Helper Functions
// ============================================================================
function detectTaskType(task) {
    if (task.includes('fullstack') ||
        task.includes('full stack') ||
        (task.includes('frontend') && task.includes('backend'))) {
        return 'fullstack-app';
    }
    if (task.includes('refactor') || task.includes('restructure')) {
        return 'refactoring';
    }
    if (task.includes('fix') ||
        task.includes('bug') ||
        task.includes('error') ||
        task.includes('issue')) {
        return 'bug-fix';
    }
    if (task.includes('feature') ||
        task.includes('add') ||
        task.includes('implement')) {
        return 'feature';
    }
    if (task.includes('test') || task.includes('testing')) {
        return 'testing';
    }
    if (task.includes('document') || task.includes('docs')) {
        return 'documentation';
    }
    if (task.includes('deploy') ||
        task.includes('infra') ||
        task.includes('ci/cd')) {
        return 'infrastructure';
    }
    if (task.includes('migrate') || task.includes('migration')) {
        return 'migration';
    }
    if (task.includes('optimize') || task.includes('performance')) {
        return 'optimization';
    }
    return 'unknown';
}
function estimateComplexity(task, type) {
    let score = 0.3; // Base complexity
    // Task type complexity
    const typeComplexity = {
        'fullstack-app': 0.9,
        refactoring: 0.7,
        'bug-fix': 0.4,
        feature: 0.6,
        testing: 0.5,
        documentation: 0.3,
        infrastructure: 0.8,
        migration: 0.8,
        optimization: 0.7,
        unknown: 0.5
    };
    score = typeComplexity[type];
    // Length factor
    if (task.length > 200)
        score += 0.1;
    if (task.length > 500)
        score += 0.1;
    // Complexity keywords
    const complexKeywords = [
        'multiple',
        'complex',
        'advanced',
        'integrate',
        'system',
        'architecture',
        'scalable',
        'real-time',
        'distributed'
    ];
    for (const keyword of complexKeywords) {
        if (task.includes(keyword)) {
            score += 0.05;
        }
    }
    return Math.min(1, score);
}
function extractAreas(task, type) {
    const areas = [];
    const areaKeywords = {
        frontend: ['frontend', 'ui', 'react', 'vue', 'angular', 'component'],
        backend: ['backend', 'server', 'api', 'endpoint', 'service'],
        database: ['database', 'db', 'schema', 'migration', 'model'],
        auth: ['auth', 'authentication', 'login', 'user'],
        testing: ['test', 'testing', 'spec', 'unit test'],
        docs: ['document', 'docs', 'readme', 'guide'],
        config: ['config', 'setup', 'environment']
    };
    for (const [area, keywords] of Object.entries(areaKeywords)) {
        if (keywords.some((kw) => task.includes(kw))) {
            areas.push(area);
        }
    }
    return areas.length > 0 ? areas : ['main'];
}
function extractTechnologies(task, context) {
    const techs = [];
    const techKeywords = [
        'react',
        'vue',
        'angular',
        'next',
        'nuxt',
        'express',
        'fastify',
        'nest',
        'typescript',
        'javascript',
        'node',
        'postgres',
        'mysql',
        'mongodb',
        'redis',
        'docker',
        'kubernetes'
    ];
    for (const tech of techKeywords) {
        if (task.includes(tech)) {
            techs.push(tech);
        }
    }
    // Add from context
    if (context.technologies) {
        techs.push(...context.technologies);
    }
    return Array.from(new Set(techs));
}
function extractFilePatterns(task, context) {
    const patterns = [];
    // Look for explicit paths
    const pathRegex = /(?:^|\s)([\w\-/]+\.[\w]+)/g;
    let match;
    while ((match = pathRegex.exec(task)) !== null) {
        patterns.push(match[1]);
    }
    // Common directory patterns
    if (task.includes('src'))
        patterns.push('src/**');
    if (task.includes('test'))
        patterns.push('**/*.test.ts');
    if (task.includes('component'))
        patterns.push('**/components/**');
    return patterns;
}
function analyzeDependencies(areas, type) {
    const deps = [];
    // Common dependencies
    if (areas.includes('frontend') && areas.includes('backend')) {
        deps.push({ from: 'frontend', to: 'backend' });
    }
    if (areas.includes('backend') && areas.includes('database')) {
        deps.push({ from: 'backend', to: 'database' });
    }
    if (areas.includes('testing')) {
        // Testing depends on everything else
        for (const area of areas) {
            if (area !== 'testing') {
                deps.push({ from: 'testing', to: area });
            }
        }
    }
    return deps;
}
function selectStrategy(analysis) {
    switch (analysis.type) {
        case 'fullstack-app':
            return fullstackStrategy;
        case 'refactoring':
            return refactoringStrategy;
        case 'bug-fix':
            return bugFixStrategy;
        case 'feature':
            return featureStrategy;
        default:
            return defaultStrategy;
    }
}
// ============================================================================
// Decomposition Strategies
// ============================================================================
const fullstackStrategy = {
    name: 'Fullstack App',
    applicableTypes: ['fullstack-app'],
    decompose: (analysis, context) => {
        const components = [];
        // Frontend component
        if (analysis.areas.includes('frontend') || analysis.areas.includes('ui')) {
            components.push({
                id: 'frontend',
                name: 'Frontend',
                role: 'frontend',
                description: 'Frontend UI and components',
                canParallelize: true,
                dependencies: ['backend'],
                effort: 0.4,
                technologies: analysis.technologies.filter((t) => ['react', 'vue', 'angular', 'next'].includes(t))
            });
        }
        // Backend component
        if (analysis.areas.includes('backend') || analysis.areas.includes('api')) {
            components.push({
                id: 'backend',
                name: 'Backend',
                role: 'backend',
                description: 'Backend API and business logic',
                canParallelize: true,
                dependencies: analysis.areas.includes('database') ? ['database'] : [],
                effort: 0.4,
                technologies: analysis.technologies.filter((t) => ['express', 'fastify', 'nest', 'node'].includes(t))
            });
        }
        // Database component
        if (analysis.areas.includes('database')) {
            components.push({
                id: 'database',
                name: 'Database',
                role: 'database',
                description: 'Database schema and migrations',
                canParallelize: true,
                dependencies: [],
                effort: 0.2,
                technologies: analysis.technologies.filter((t) => ['postgres', 'mysql', 'mongodb'].includes(t))
            });
        }
        // Shared component
        components.push({
            id: 'shared',
            name: 'Shared',
            role: 'shared',
            description: 'Shared types, utilities, and configuration',
            canParallelize: true,
            dependencies: [],
            effort: 0.2,
            technologies: []
        });
        return { components, sharedFiles: [] };
    }
};
const refactoringStrategy = {
    name: 'Refactoring',
    applicableTypes: ['refactoring'],
    decompose: (analysis, context) => {
        const components = [];
        // Group by module/directory
        for (const area of analysis.areas) {
            components.push({
                id: area,
                name: `Refactor ${area}`,
                role: 'module',
                description: `Refactor ${area} module`,
                canParallelize: true,
                dependencies: [],
                effort: analysis.complexity / analysis.areas.length,
                technologies: []
            });
        }
        return { components, sharedFiles: [] };
    }
};
const bugFixStrategy = {
    name: 'Bug Fix',
    applicableTypes: ['bug-fix'],
    decompose: (analysis, context) => {
        // Bug fixes usually not parallelizable
        const components = [
            {
                id: 'bugfix',
                name: 'Fix Bug',
                role: 'module',
                description: analysis.task,
                canParallelize: false,
                dependencies: [],
                effort: analysis.complexity,
                technologies: []
            }
        ];
        return { components, sharedFiles: [] };
    }
};
const featureStrategy = {
    name: 'Feature',
    applicableTypes: ['feature'],
    decompose: (analysis, context) => {
        const components = [];
        // Break down by feature area
        for (const area of analysis.areas) {
            components.push({
                id: area,
                name: `Implement ${area}`,
                role: area,
                description: `Implement ${area} for the feature`,
                canParallelize: true,
                dependencies: [],
                effort: analysis.complexity / analysis.areas.length,
                technologies: []
            });
        }
        return { components, sharedFiles: [] };
    }
};
const defaultStrategy = {
    name: 'Default',
    applicableTypes: [],
    decompose: (analysis, context) => {
        const components = [
            {
                id: 'main',
                name: 'Main Task',
                role: 'module',
                description: analysis.task,
                canParallelize: false,
                dependencies: [],
                effort: analysis.complexity,
                technologies: []
            }
        ];
        return { components, sharedFiles: [] };
    }
};
// ============================================================================
// Subtask Generation Helpers
// ============================================================================
function generatePromptForComponent(component, analysis, context) {
    let prompt = `${component.description}\n\n`;
    prompt += `CONTEXT:\n`;
    prompt += `- Task Type: ${analysis.type}\n`;
    prompt += `- Component Role: ${component.role}\n`;
    if (component.technologies.length > 0) {
        prompt += `- Technologies: ${component.technologies.join(', ')}\n`;
    }
    prompt += `\nYour responsibilities:\n`;
    prompt += `1. ${component.description}\n`;
    prompt += `2. Ensure code quality and follow best practices\n`;
    prompt += `3. Write tests for your changes\n`;
    prompt += `4. Update documentation as needed\n`;
    if (component.dependencies.length > 0) {
        prompt += `\nDependencies: This component depends on ${component.dependencies.join(', ')} completing first.\n`;
    }
    return prompt;
}
function selectAgentType(component) {
    const roleToAgent = {
        frontend: 'oh-my-claudecode:designer',
        backend: 'oh-my-claudecode:executor',
        database: 'oh-my-claudecode:executor',
        api: 'oh-my-claudecode:executor',
        ui: 'oh-my-claudecode:designer',
        shared: 'oh-my-claudecode:executor',
        testing: 'oh-my-claudecode:qa-tester',
        docs: 'oh-my-claudecode:writer',
        config: 'oh-my-claudecode:executor',
        module: 'oh-my-claudecode:executor'
    };
    return roleToAgent[component.role] || 'oh-my-claudecode:executor';
}
function selectModelTier(component) {
    if (component.effort < 0.3)
        return 'low';
    if (component.effort < 0.7)
        return 'medium';
    return 'high';
}
function generateAcceptanceCriteria(component, analysis) {
    const criteria = [];
    criteria.push(`${component.name} implementation is complete`);
    criteria.push('Code compiles without errors');
    criteria.push('Tests pass');
    if (component.role === 'frontend' || component.role === 'ui') {
        criteria.push('UI components render correctly');
        criteria.push('Responsive design works on all screen sizes');
    }
    if (component.role === 'backend' || component.role === 'api') {
        criteria.push('API endpoints return expected responses');
        criteria.push('Error handling is implemented');
    }
    if (component.role === 'database') {
        criteria.push('Database schema is correct');
        criteria.push('Migrations run successfully');
    }
    return criteria;
}
function generateVerificationSteps(component, analysis) {
    const steps = [];
    steps.push('Run the project type check command');
    steps.push('Run the project lint command');
    steps.push('Run the project test command');
    if (component.role === 'frontend' || component.role === 'ui') {
        steps.push('Visual inspection of UI components');
    }
    if (component.role === 'backend' || component.role === 'api') {
        steps.push('Test API endpoints with curl or Postman');
    }
    return steps;
}
function inferFilePatterns(component, context) {
    const patterns = [];
    switch (component.role) {
        case 'frontend':
        case 'ui':
            patterns.push('src/components/**', 'src/pages/**', 'src/styles/**');
            break;
        case 'backend':
        case 'api':
            patterns.push('src/api/**', 'src/routes/**', 'src/controllers/**');
            break;
        case 'database':
            patterns.push('src/db/**', 'src/models/**', 'migrations/**');
            break;
        case 'shared':
            patterns.push('src/types/**', 'src/utils/**', 'src/lib/**');
            break;
        case 'testing':
            patterns.push('**/*.test.ts', '**/*.spec.ts', 'tests/**');
            break;
        case 'docs':
            patterns.push('docs/**', '*.md');
            break;
        default:
            patterns.push(`src/${component.id}/**`);
    }
    return patterns;
}
function inferSpecificFiles(component, context) {
    const files = [];
    // Component-specific files can be added here
    return files;
}
function calculateExecutionOrder(subtasks) {
    const order = [];
    const completed = new Set();
    const remaining = new Set(subtasks.map((st) => st.id));
    while (remaining.size > 0) {
        const batch = [];
        for (const subtask of subtasks) {
            if (remaining.has(subtask.id)) {
                // Check if all dependencies are completed
                const canRun = subtask.blockedBy.every((dep) => completed.has(dep));
                if (canRun) {
                    batch.push(subtask.id);
                }
            }
        }
        if (batch.length === 0) {
            // Circular dependency or error
            order.push(Array.from(remaining));
            break;
        }
        order.push(batch);
        for (const id of batch) {
            remaining.delete(id);
            completed.add(id);
        }
    }
    return order;
}
function validateDecomposition(subtasks, sharedFiles) {
    const warnings = [];
    // Check for ownership overlaps
    const patternOwners = new Map();
    for (const subtask of subtasks) {
        for (const pattern of subtask.ownership.patterns) {
            if (!patternOwners.has(pattern)) {
                patternOwners.set(pattern, []);
            }
            patternOwners.get(pattern).push(subtask.id);
        }
    }
    for (const [pattern, owners] of Array.from(patternOwners.entries())) {
        if (owners.length > 1) {
            const isShared = sharedFiles.some((sf) => sf.pattern === pattern);
            if (!isShared) {
                warnings.push(`Pattern "${pattern}" is owned by multiple subtasks: ${owners.join(', ')}`);
            }
        }
    }
    // Check for subtasks with no file ownership
    for (const subtask of subtasks) {
        if (subtask.ownership.patterns.length === 0 &&
            subtask.ownership.files.length === 0) {
            warnings.push(`Subtask "${subtask.id}" has no file ownership assigned`);
        }
    }
    return warnings;
}
function explainStrategy(analysis, components) {
    let explanation = `Task Type: ${analysis.type}\n`;
    explanation += `Parallelizable: ${analysis.isParallelizable ? 'Yes' : 'No'}\n`;
    explanation += `Components: ${components.length}\n\n`;
    if (analysis.isParallelizable) {
        explanation += `This task has been decomposed into ${components.length} parallel components:\n`;
        for (const component of components) {
            explanation += `- ${component.name} (${component.role})\n`;
        }
    }
    else {
        explanation += `This task is not suitable for parallelization and will be executed as a single component.\n`;
    }
    return explanation;
}
//# sourceMappingURL=index.js.map