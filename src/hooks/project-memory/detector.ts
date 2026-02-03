/**
 * Project Environment Detector
 * Auto-detects languages, frameworks, build tools, and conventions
 */

import fs from 'fs/promises';
import path from 'path';
import {
  ProjectMemory,
  TechStack,
  BuildInfo,
  CodeConventions,
  ProjectStructure,
  LanguageDetection,
  FrameworkDetection,
  GitBranchPattern,
} from './types.js';
import {
  SCHEMA_VERSION,
  CONFIG_PATTERNS,
  FRAMEWORK_PATTERNS,
  MAIN_DIRECTORIES,
} from './constants.js';
import { mapDirectoryStructure } from './directory-mapper.js';

/**
 * Main entry point: detect all project environment details
 */
export async function detectProjectEnvironment(projectRoot: string): Promise<ProjectMemory> {
  const [techStack, build, conventions, structure, directoryMap] = await Promise.all([
    detectTechStack(projectRoot),
    detectBuildInfo(projectRoot),
    detectConventions(projectRoot),
    detectStructure(projectRoot),
    mapDirectoryStructure(projectRoot),
  ]);

  return {
    version: SCHEMA_VERSION,
    lastScanned: Date.now(),
    projectRoot,
    techStack,
    build,
    conventions,
    structure,
    customNotes: [],
    directoryMap,
    hotPaths: [],
    userDirectives: [],
  };
}

/**
 * Detect tech stack: languages, frameworks, package manager, runtime
 */
async function detectTechStack(projectRoot: string): Promise<TechStack> {
  const languages: LanguageDetection[] = [];
  const frameworks: FrameworkDetection[] = [];
  let packageManager: string | null = null;
  let runtime: string | null = null;

  // Check for config files
  // First pass: detect languages and collect package manager hints
  const packageManagerHints: string[] = [];

  for (const pattern of CONFIG_PATTERNS) {
    const filePath = path.join(projectRoot, pattern.file);
    const exists = await fileExists(filePath);

    if (exists) {
      // Detect language
      if (pattern.indicates.language) {
        const existingLang = languages.find(l => l.name === pattern.indicates.language);
        if (!existingLang) {
          const version = await extractVersion(filePath, pattern.indicates.language);
          languages.push({
            name: pattern.indicates.language!,
            version,
            confidence: 'high',
            markers: [pattern.file],
          });
        } else {
          existingLang.markers.push(pattern.file);
        }
      }

      // Collect package manager hints
      if (pattern.indicates.packageManager) {
        packageManagerHints.push(pattern.indicates.packageManager);
      }
    }
  }

  // Prioritize lockfile-based package managers over generic ones
  const lockfileManagers = ['pnpm', 'yarn', 'cargo', 'poetry', 'pipenv', 'bundler', 'composer', 'go'];
  const lockfileMatch = packageManagerHints.find(pm => lockfileManagers.includes(pm));
  packageManager = lockfileMatch || packageManagerHints[0] || null;

  // Detect frameworks from package.json
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (await fileExists(packageJsonPath)) {
    const pkgFrameworks = await detectFrameworksFromPackageJson(packageJsonPath);
    frameworks.push(...pkgFrameworks);

    // Detect runtime from package.json engines
    runtime = await detectRuntime(packageJsonPath);
  }

  // Detect frameworks from Cargo.toml
  const cargoTomlPath = path.join(projectRoot, 'Cargo.toml');
  if (await fileExists(cargoTomlPath)) {
    const cargoFrameworks = await detectFrameworksFromCargoToml(cargoTomlPath);
    frameworks.push(...cargoFrameworks);
  }

  // Detect frameworks from pyproject.toml
  const pyprojectPath = path.join(projectRoot, 'pyproject.toml');
  if (await fileExists(pyprojectPath)) {
    const pyFrameworks = await detectFrameworksFromPyproject(pyprojectPath);
    frameworks.push(...pyFrameworks);
  }

  return {
    languages,
    frameworks,
    packageManager,
    runtime,
  };
}

/**
 * Detect build commands and scripts
 */
async function detectBuildInfo(projectRoot: string): Promise<BuildInfo> {
  let buildCommand: string | null = null;
  let testCommand: string | null = null;
  let lintCommand: string | null = null;
  let devCommand: string | null = null;
  const scripts: Record<string, string> = {};

  // Check package.json scripts
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (await fileExists(packageJsonPath)) {
    try {
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(content);
      const pkgScripts = packageJson.scripts || {};

      // Determine package manager
      let pm = 'npm';
      if (await fileExists(path.join(projectRoot, 'pnpm-lock.yaml'))) {
        pm = 'pnpm';
      } else if (await fileExists(path.join(projectRoot, 'yarn.lock'))) {
        pm = 'yarn';
      } else if (await fileExists(path.join(projectRoot, 'bun.lockb'))) {
        pm = 'bun';
      }

      // Store all scripts
      Object.assign(scripts, pkgScripts);

      // Extract common commands
      if (pkgScripts.build) {
        buildCommand = `${pm} ${pm === 'npm' ? 'run ' : ''}build`;
      }
      if (pkgScripts.test) {
        testCommand = `${pm} test`;
      }
      if (pkgScripts.lint) {
        lintCommand = `${pm} ${pm === 'npm' ? 'run ' : ''}lint`;
      }
      if (pkgScripts.dev || pkgScripts.start) {
        devCommand = `${pm} ${pm === 'npm' ? 'run ' : ''}${pkgScripts.dev ? 'dev' : 'start'}`;
      }
    } catch (error) {
      // Invalid JSON, skip
    }
  }

  // Check Cargo.toml
  if (await fileExists(path.join(projectRoot, 'Cargo.toml'))) {
    if (!buildCommand) buildCommand = 'cargo build';
    if (!testCommand) testCommand = 'cargo test';
    if (!lintCommand) lintCommand = 'cargo clippy';
    if (!devCommand) devCommand = 'cargo run';
  }

  // Check Makefile
  if (await fileExists(path.join(projectRoot, 'Makefile'))) {
    if (!buildCommand) buildCommand = 'make build';
    if (!testCommand) testCommand = 'make test';
  }

  // Check pyproject.toml
  if (await fileExists(path.join(projectRoot, 'pyproject.toml'))) {
    if (!testCommand) testCommand = 'pytest';
    if (!lintCommand) lintCommand = 'ruff check';
  }

  return {
    buildCommand,
    testCommand,
    lintCommand,
    devCommand,
    scripts,
  };
}

/**
 * Detect code conventions from sample files
 */
async function detectConventions(projectRoot: string): Promise<CodeConventions> {
  let namingStyle: string | null = null;
  let importStyle: string | null = null;
  let testPattern: string | null = null;
  let fileOrganization: string | null = null;

  // Sample source files
  const srcDirs = ['src', 'lib', 'app'];
  const sampleFiles: string[] = [];

  for (const dir of srcDirs) {
    const dirPath = path.join(projectRoot, dir);
    if (await fileExists(dirPath)) {
      try {
        const files = await fs.readdir(dirPath);
        for (const file of files.slice(0, 5)) {
          if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.py')) {
            sampleFiles.push(path.join(dirPath, file));
          }
        }
      } catch (error) {
        // Skip unreadable directories
      }
    }
  }

  // Analyze naming patterns
  if (sampleFiles.length > 0) {
    const contents = await Promise.all(
      sampleFiles.map(f => fs.readFile(f, 'utf-8').catch(() => ''))
    );

    // Detect naming style (simplified heuristic)
    const camelCaseCount = contents.filter(c => /\bfunction\s+[a-z][a-zA-Z]+/.test(c)).length;
    const snakeCaseCount = contents.filter(c => /\bdef\s+[a-z_]+/.test(c)).length;
    const pascalCaseCount = contents.filter(c => /\bclass\s+[A-Z][a-zA-Z]+/.test(c)).length;

    if (snakeCaseCount > camelCaseCount) {
      namingStyle = 'snake_case';
    } else if (pascalCaseCount > 0) {
      namingStyle = 'camelCase/PascalCase';
    } else if (camelCaseCount > 0) {
      namingStyle = 'camelCase';
    }

    // Detect import style
    const esModuleCount = contents.filter(c => /^import\s+.*from/.test(c)).length;
    const commonJSCount = contents.filter(c => /^const\s+.*=\s*require\(/.test(c)).length;

    if (esModuleCount > commonJSCount) {
      importStyle = 'ES modules';
    } else if (commonJSCount > 0) {
      importStyle = 'CommonJS';
    }
  }

  // Detect test pattern
  const testDirs = ['tests', 'test', '__tests__', 'spec'];
  for (const dir of testDirs) {
    const dirPath = path.join(projectRoot, dir);
    if (await fileExists(dirPath)) {
      try {
        const files = await fs.readdir(dirPath);
        const testFile = files.find(f => /\.(test|spec)\.(ts|js|py)$/.test(f));
        if (testFile) {
          if (testFile.endsWith('.test.ts')) testPattern = '*.test.ts';
          else if (testFile.endsWith('.spec.ts')) testPattern = '*.spec.ts';
          else if (testFile.startsWith('test_')) testPattern = 'test_*.py';
          break;
        }
      } catch (error) {
        // Skip
      }
    }
  }

  // Detect file organization (feature-based vs type-based)
  const hasFeaturesDir = await fileExists(path.join(projectRoot, 'src', 'features'));
  const hasComponentsDir = await fileExists(path.join(projectRoot, 'src', 'components'));
  const hasControllersDir = await fileExists(path.join(projectRoot, 'src', 'controllers'));

  if (hasFeaturesDir) {
    fileOrganization = 'feature-based';
  } else if (hasComponentsDir || hasControllersDir) {
    fileOrganization = 'type-based';
  }

  return {
    namingStyle,
    importStyle,
    testPattern,
    fileOrganization,
  };
}

/**
 * Detect project structure
 */
async function detectStructure(projectRoot: string): Promise<ProjectStructure> {
  let isMonorepo = false;
  const workspaces: string[] = [];
  const mainDirectories: string[] = [];
  let gitBranches: GitBranchPattern | null = null;

  // Check for monorepo
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (await fileExists(packageJsonPath)) {
    try {
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(content);
      if (packageJson.workspaces) {
        isMonorepo = true;
        workspaces.push(...(Array.isArray(packageJson.workspaces)
          ? packageJson.workspaces
          : packageJson.workspaces.packages || []));
      }
    } catch (error) {
      // Invalid JSON
    }
  }

  // Check pnpm-workspace.yaml
  const pnpmWorkspacePath = path.join(projectRoot, 'pnpm-workspace.yaml');
  if (await fileExists(pnpmWorkspacePath)) {
    isMonorepo = true;
    // Could parse YAML here, but skipping for simplicity
  }

  // List main directories
  try {
    const entries = await fs.readdir(projectRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && MAIN_DIRECTORIES.includes(entry.name)) {
        mainDirectories.push(entry.name);
      }
    }
  } catch (error) {
    // Skip
  }

  // Detect git branch
  gitBranches = await detectGitBranch(projectRoot);

  return {
    isMonorepo,
    workspaces,
    mainDirectories,
    gitBranches,
  };
}

/**
 * Helper: Check if file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Helper: Extract version from config file
 */
async function extractVersion(filePath: string, language: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');

    if (filePath.endsWith('package.json')) {
      const packageJson = JSON.parse(content);
      if (packageJson.engines?.node) {
        return packageJson.engines.node;
      }
    }

    if (filePath.endsWith('Cargo.toml')) {
      const match = content.match(/^rust-version\s*=\s*"([^"]+)"/m);
      if (match) return match[1];
    }

    if (filePath.endsWith('pyproject.toml')) {
      const match = content.match(/^python\s*=\s*"([^"]+)"/m);
      if (match) return match[1];
    }
  } catch (error) {
    // Skip
  }

  return null;
}

/**
 * Helper: Detect frameworks from package.json
 */
async function detectFrameworksFromPackageJson(filePath: string): Promise<FrameworkDetection[]> {
  const frameworks: FrameworkDetection[] = [];

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const packageJson = JSON.parse(content);
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    for (const [name, version] of Object.entries(deps)) {
      if (FRAMEWORK_PATTERNS[name]) {
        frameworks.push({
          name,
          version: typeof version === 'string' ? version.replace(/[\^~]/, '') : null,
          category: FRAMEWORK_PATTERNS[name].category,
        });
      }
    }
  } catch (error) {
    // Skip
  }

  return frameworks;
}

/**
 * Helper: Detect frameworks from Cargo.toml
 */
async function detectFrameworksFromCargoToml(filePath: string): Promise<FrameworkDetection[]> {
  const frameworks: FrameworkDetection[] = [];

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const deps = ['axum', 'actix-web', 'rocket', 'tokio', 'async-std'];

    for (const dep of deps) {
      const regex = new RegExp(`^${dep}\\s*=`, 'm');
      if (regex.test(content) && FRAMEWORK_PATTERNS[dep]) {
        frameworks.push({
          name: dep,
          version: null,
          category: FRAMEWORK_PATTERNS[dep].category,
        });
      }
    }
  } catch (error) {
    // Skip
  }

  return frameworks;
}

/**
 * Helper: Detect frameworks from pyproject.toml
 */
async function detectFrameworksFromPyproject(filePath: string): Promise<FrameworkDetection[]> {
  const frameworks: FrameworkDetection[] = [];

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const deps = ['fastapi', 'django', 'flask', 'pytest'];

    for (const dep of deps) {
      const regex = new RegExp(`["']${dep}`, 'm');
      if (regex.test(content) && FRAMEWORK_PATTERNS[dep]) {
        frameworks.push({
          name: dep,
          version: null,
          category: FRAMEWORK_PATTERNS[dep].category,
        });
      }
    }
  } catch (error) {
    // Skip
  }

  return frameworks;
}

/**
 * Helper: Detect runtime from package.json engines
 */
async function detectRuntime(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const packageJson = JSON.parse(content);

    if (packageJson.engines?.node) {
      const version = packageJson.engines.node.replace(/[\^~><= ]/g, '');
      return `Node.js ${version}`;
    }
  } catch (error) {
    // Skip
  }

  return null;
}

/**
 * Helper: Detect git branch pattern
 */
async function detectGitBranch(projectRoot: string): Promise<GitBranchPattern | null> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    // Get default branch
    const { stdout } = await execFileAsync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: projectRoot,
    });

    const match = stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
    if (match) {
      return {
        defaultBranch: match[1],
        branchingStrategy: null, // Could detect git-flow vs trunk-based, but skipping for now
      };
    }
  } catch (error) {
    // Not a git repo or no remote
  }

  return null;
}
