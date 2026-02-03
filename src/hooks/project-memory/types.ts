/**
 * Project Memory Type Definitions
 * Schema version: 1.0.0
 */

export interface ProjectMemory {
  version: string;
  lastScanned: number;
  projectRoot: string;
  techStack: TechStack;
  build: BuildInfo;
  conventions: CodeConventions;
  structure: ProjectStructure;
  customNotes: CustomNote[];
  directoryMap: Record<string, DirectoryInfo>;
  hotPaths: HotPath[];
  userDirectives: UserDirective[];
}

export interface TechStack {
  languages: LanguageDetection[];
  frameworks: FrameworkDetection[];
  packageManager: string | null;
  runtime: string | null;
}

export interface LanguageDetection {
  name: string;
  version: string | null;
  confidence: 'high' | 'medium' | 'low';
  markers: string[];
}

export interface FrameworkDetection {
  name: string;
  version: string | null;
  category: 'frontend' | 'backend' | 'fullstack' | 'testing' | 'build';
}

export interface BuildInfo {
  buildCommand: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  devCommand: string | null;
  scripts: Record<string, string>;
}

export interface CodeConventions {
  namingStyle: string | null;
  importStyle: string | null;
  testPattern: string | null;
  fileOrganization: string | null;
}

export interface ProjectStructure {
  isMonorepo: boolean;
  workspaces: string[];
  mainDirectories: string[];
  gitBranches: GitBranchPattern | null;
}

export interface GitBranchPattern {
  defaultBranch: string;
  branchingStrategy: string | null;
}

export interface CustomNote {
  timestamp: number;
  source: 'manual' | 'learned';
  category: string;
  content: string;
}

export interface ConfigPattern {
  file: string;
  indicates: {
    language?: string;
    packageManager?: string;
    framework?: string;
  };
}

/**
 * Directory information for project structure tracking
 */
export interface DirectoryInfo {
  path: string;
  purpose: string | null;
  fileCount: number;
  lastAccessed: number;
  keyFiles: string[];
}

/**
 * Hot path tracking for frequently accessed files/directories
 */
export interface HotPath {
  path: string;
  accessCount: number;
  lastAccessed: number;
  type: 'file' | 'directory';
}

/**
 * User directive that must survive compaction
 */
export interface UserDirective {
  timestamp: number;
  directive: string;
  context: string;
  source: 'explicit' | 'inferred';
  priority: 'high' | 'normal';
}
