/**
 * Project Memory Constants
 */

export const MEMORY_FILE = 'project-memory.json';
export const MEMORY_DIR = '.omc';
export const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
export const SCHEMA_VERSION = '1.0.0';

export const CONFIG_PATTERNS = [
  // JavaScript/TypeScript
  { file: 'package.json', indicates: { language: 'JavaScript/TypeScript', packageManager: 'npm' } },
  { file: 'tsconfig.json', indicates: { language: 'TypeScript' } },
  { file: 'jsconfig.json', indicates: { language: 'JavaScript' } },
  { file: 'pnpm-lock.yaml', indicates: { packageManager: 'pnpm' } },
  { file: 'yarn.lock', indicates: { packageManager: 'yarn' } },
  { file: 'package-lock.json', indicates: { packageManager: 'npm' } },
  { file: 'bun.lockb', indicates: { packageManager: 'bun' } },

  // Rust
  { file: 'Cargo.toml', indicates: { language: 'Rust', packageManager: 'cargo' } },
  { file: 'Cargo.lock', indicates: { packageManager: 'cargo' } },

  // Python
  { file: 'pyproject.toml', indicates: { language: 'Python' } },
  { file: 'requirements.txt', indicates: { language: 'Python', packageManager: 'pip' } },
  { file: 'poetry.lock', indicates: { packageManager: 'poetry' } },
  { file: 'Pipfile', indicates: { packageManager: 'pipenv' } },

  // Go
  { file: 'go.mod', indicates: { language: 'Go', packageManager: 'go' } },
  { file: 'go.sum', indicates: { packageManager: 'go' } },

  // Java/Kotlin
  { file: 'pom.xml', indicates: { language: 'Java', packageManager: 'maven' } },
  { file: 'build.gradle', indicates: { language: 'Java/Kotlin', packageManager: 'gradle' } },
  { file: 'build.gradle.kts', indicates: { language: 'Kotlin', packageManager: 'gradle' } },

  // Ruby
  { file: 'Gemfile', indicates: { language: 'Ruby', packageManager: 'bundler' } },
  { file: 'Gemfile.lock', indicates: { packageManager: 'bundler' } },

  // PHP
  { file: 'composer.json', indicates: { language: 'PHP', packageManager: 'composer' } },
  { file: 'composer.lock', indicates: { packageManager: 'composer' } },

  // C/C++
  { file: 'CMakeLists.txt', indicates: { language: 'C/C++' } },
  { file: 'Makefile', indicates: { language: 'C/C++' } },

  // .NET
  { file: '*.csproj', indicates: { language: 'C#', packageManager: 'nuget' } },
  { file: '*.fsproj', indicates: { language: 'F#', packageManager: 'nuget' } },
];

export const FRAMEWORK_PATTERNS: Record<string, { category: 'frontend' | 'backend' | 'fullstack' | 'testing' | 'build' }> = {
  // Frontend
  'react': { category: 'frontend' },
  'react-dom': { category: 'frontend' },
  'vue': { category: 'frontend' },
  'svelte': { category: 'frontend' },
  'angular': { category: 'frontend' },
  '@angular/core': { category: 'frontend' },
  'solid-js': { category: 'frontend' },
  'preact': { category: 'frontend' },

  // Fullstack
  'next': { category: 'fullstack' },
  'nuxt': { category: 'fullstack' },
  'remix': { category: 'fullstack' },
  'sveltekit': { category: 'fullstack' },
  '@sveltejs/kit': { category: 'fullstack' },
  'astro': { category: 'fullstack' },

  // Backend
  'express': { category: 'backend' },
  'fastify': { category: 'backend' },
  'koa': { category: 'backend' },
  'hapi': { category: 'backend' },
  'nestjs': { category: 'backend' },
  '@nestjs/core': { category: 'backend' },
  'fastapi': { category: 'backend' },
  'django': { category: 'backend' },
  'flask': { category: 'backend' },
  'axum': { category: 'backend' },
  'actix-web': { category: 'backend' },
  'rocket': { category: 'backend' },

  // Testing
  'jest': { category: 'testing' },
  'vitest': { category: 'testing' },
  'mocha': { category: 'testing' },
  'jasmine': { category: 'testing' },
  'playwright': { category: 'testing' },
  '@playwright/test': { category: 'testing' },
  'cypress': { category: 'testing' },
  'pytest': { category: 'testing' },

  // Build
  'vite': { category: 'build' },
  'webpack': { category: 'build' },
  'rollup': { category: 'build' },
  'esbuild': { category: 'build' },
  'parcel': { category: 'build' },
  'turbopack': { category: 'build' },
};

export const MAIN_DIRECTORIES = [
  'src',
  'lib',
  'app',
  'pages',
  'components',
  'tests',
  'test',
  '__tests__',
  'spec',
  'docs',
  'examples',
  'bin',
  'scripts',
  'public',
  'assets',
  'static',
];

export const BUILD_COMMAND_PATTERNS = [
  /npm\s+run\s+build/,
  /pnpm\s+build/,
  /yarn\s+build/,
  /bun\s+run\s+build/,
  /cargo\s+build/,
  /go\s+build/,
  /tsc\b/,
  /make\s+build/,
  /mvn\s+package/,
  /gradle\s+build/,
];

export const TEST_COMMAND_PATTERNS = [
  /npm\s+test/,
  /pnpm\s+test/,
  /yarn\s+test/,
  /bun\s+test/,
  /cargo\s+test/,
  /go\s+test/,
  /pytest/,
  /jest/,
  /vitest/,
  /make\s+test/,
];
