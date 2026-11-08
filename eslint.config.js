import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused vars: warn only (many pre-existing in codebase)
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Allow any for flexibility in agent system
      '@typescript-eslint/no-explicit-any': 'off',
      // Allow require imports for dynamic loading
      '@typescript-eslint/no-require-imports': 'off',
      // Template strings have many escaped quotes - disable
      'no-useless-escape': 'off',
      // Minor style issues - warn only
      'prefer-const': 'warn',
      'no-regex-spaces': 'warn',
      // Pre-existing code patterns - disable
      'no-useless-catch': 'off',
      // Allow ANSI escape codes in regexes (used for terminal output stripping)
      'no-control-regex': 'off',
    },
  },
  // Guard against bypassing the canonical session-state path constructor.
  // Code outside src/lib/worktree-paths.ts and its own __tests__ must use
  // `resolveSessionStatePaths()` (struct + branded paths). The legacy
  // string-returning `resolveSessionStatePath` is still allowed for back-compat
  // but new writers should prefer the canonical helper.
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/lib/worktree-paths.ts',
      'src/lib/__tests__/worktree-paths.test.ts',
      'src/lib/__tests__/session-state-paths.type-test.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          // Disallow `as ReadPath` / `as WritePath` casts outside worktree-paths.ts —
          // brands must be produced only by resolveSessionStatePaths.
          selector: "TSAsExpression[typeAnnotation.type='TSTypeReference'][typeAnnotation.typeName.name=/^(ReadPath|WritePath)$/]",
          message: 'Do not cast to ReadPath/WritePath outside worktree-paths.ts. Use resolveSessionStatePaths() to obtain branded paths.',
        },
      ],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.js', '*.mjs', 'src/__tests__/fixtures/**', 'src/__tests__/benchmark-scoring.test.ts'],
  }
);
