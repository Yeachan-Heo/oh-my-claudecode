/**
 * Ultrapilot Types
 *
 * Type definitions for the ultrapilot coordinator - manages parallel worker spawning
 * and coordination with file ownership to avoid conflicts.
 *
 * Ultrapilot decomposes tasks into parallelizable subtasks, spawns workers (max 5),
 * tracks progress, and integrates results while managing shared file access.
 */
/**
 * Default configuration for ultrapilot
 */
export const DEFAULT_CONFIG = {
    maxWorkers: 5,
    maxIterations: 3,
    workerTimeout: 300000, // 5 minutes
    workerModel: 'sonnet',
    sharedFiles: [
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'jest.config.js',
        '.gitignore',
        'README.md',
        'Makefile',
        'go.mod',
        'go.sum',
        'Cargo.toml',
        'Cargo.lock',
        'pyproject.toml',
        'requirements.txt',
        'setup.py'
    ],
    verbose: false
};
//# sourceMappingURL=types.js.map