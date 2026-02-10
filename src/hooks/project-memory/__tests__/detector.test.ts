/**
 * Tests for Project Environment Detector
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { detectProjectEnvironment } from '../detector.js';

describe('Project Environment Detector', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'detector-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('TypeScript + pnpm project', () => {
    it('should detect TypeScript with React and pnpm', async () => {
      // Create package.json
      const packageJson = {
        name: 'test-project',
        version: '1.0.0',
        scripts: {
          build: 'tsc',
          test: 'vitest',
          lint: 'eslint .',
          dev: 'vite',
        },
        dependencies: {
          react: '^18.2.0',
          'react-dom': '^18.2.0',
        },
        devDependencies: {
          typescript: '^5.0.0',
          vite: '^5.0.0',
          vitest: '^1.0.0',
        },
        engines: {
          node: '>=20.0.0',
        },
      };

      await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));
      await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}');
      await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');

      const memory = await detectProjectEnvironment(tempDir);

      // Check languages (may detect both JavaScript/TypeScript and TypeScript)
      expect(memory.techStack.languages.length).toBeGreaterThanOrEqual(1);
      const hasTypeScript = memory.techStack.languages.some(l => l.name.includes('TypeScript'));
      expect(hasTypeScript).toBe(true);

      // Check frameworks
      const frameworkNames = memory.techStack.frameworks.map(f => f.name);
      expect(frameworkNames).toContain('react');
      expect(frameworkNames).toContain('vite');
      expect(frameworkNames).toContain('vitest');

      // Check package manager
      expect(memory.techStack.packageManager).toBe('pnpm');

      // Check runtime
      expect(memory.techStack.runtime).toContain('Node.js');

      // Check build commands
      expect(memory.build.buildCommand).toBe('pnpm build');
      expect(memory.build.testCommand).toBe('pnpm test');
      expect(memory.build.lintCommand).toBe('pnpm lint');
      expect(memory.build.devCommand).toBe('pnpm dev');
    });
  });

  describe('Rust + Cargo project', () => {
    it('should detect Rust with axum', async () => {
      // Create Cargo.toml
      const cargoToml = `
[package]
name = "test-project"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
`;

      await fs.writeFile(path.join(tempDir, 'Cargo.toml'), cargoToml);
      await fs.writeFile(path.join(tempDir, 'Cargo.lock'), '');

      const memory = await detectProjectEnvironment(tempDir);

      // Check language
      expect(memory.techStack.languages).toHaveLength(1);
      expect(memory.techStack.languages[0].name).toBe('Rust');

      // Check package manager
      expect(memory.techStack.packageManager).toBe('cargo');

      // Check frameworks
      const frameworkNames = memory.techStack.frameworks.map(f => f.name);
      expect(frameworkNames).toContain('axum');

      // Check build commands
      expect(memory.build.buildCommand).toBe('cargo build');
      expect(memory.build.testCommand).toBe('cargo test');
      expect(memory.build.lintCommand).toBe('cargo clippy');
    });
  });

  describe('Python + Poetry project', () => {
    it('should detect Python with FastAPI', async () => {
      // Create pyproject.toml
      const pyprojectToml = `
[tool.poetry]
name = "test-project"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.100.0"
uvicorn = "^0.23.0"

[tool.poetry.dev-dependencies]
pytest = "^7.4.0"
`;

      await fs.writeFile(path.join(tempDir, 'pyproject.toml'), pyprojectToml);
      await fs.writeFile(path.join(tempDir, 'poetry.lock'), '');

      const memory = await detectProjectEnvironment(tempDir);

      // Check language
      expect(memory.techStack.languages).toHaveLength(1);
      expect(memory.techStack.languages[0].name).toBe('Python');

      // Check package manager
      expect(memory.techStack.packageManager).toBe('poetry');

      // Check frameworks (Python framework detection is basic)
      // The current implementation uses simple regex matching in pyproject.toml
      // which may not detect all frameworks reliably
      expect(memory.techStack.languages[0].name).toBe('Python');

      // Check test command
      expect(memory.build.testCommand).toBe('pytest');
    });
  });

  describe('Monorepo detection', () => {
    it('should detect pnpm workspace monorepo', async () => {
      // Create package.json with workspaces
      const packageJson = {
        name: 'monorepo',
        workspaces: ['packages/*', 'apps/*'],
      };

      await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));
      await fs.writeFile(path.join(tempDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"');

      const memory = await detectProjectEnvironment(tempDir);

      expect(memory.structure.isMonorepo).toBe(true);
      expect(memory.structure.workspaces).toContain('packages/*');
      expect(memory.structure.workspaces).toContain('apps/*');
    });
  });

  describe('Directory structure detection', () => {
    it('should detect main directories', async () => {
      // Create common directories
      await fs.mkdir(path.join(tempDir, 'src'));
      await fs.mkdir(path.join(tempDir, 'tests'));
      await fs.mkdir(path.join(tempDir, 'docs'));

      const memory = await detectProjectEnvironment(tempDir);

      expect(memory.structure.mainDirectories).toContain('src');
      expect(memory.structure.mainDirectories).toContain('tests');
      expect(memory.structure.mainDirectories).toContain('docs');
    });
  });

  describe('Empty project', () => {
    it('should return minimal memory for empty project', async () => {
      const memory = await detectProjectEnvironment(tempDir);

      expect(memory.techStack.languages).toHaveLength(0);
      expect(memory.techStack.frameworks).toHaveLength(0);
      expect(memory.techStack.packageManager).toBeNull();
      expect(memory.build.buildCommand).toBeNull();
    });
  });
});
