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
  {
    ignores: ['dist/**', 'node_modules/**', '*.js', '*.mjs'],
  }
);
