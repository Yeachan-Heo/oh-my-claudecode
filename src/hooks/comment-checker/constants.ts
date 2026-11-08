/**
 * Comment Checker Constants
 *
 * Keywords and patterns for comment detection and filtering.
 *
 * Adapted from oh-my-opencode's comment-checker hook.
 */

/**
 * BDD (Behavior-Driven Development) keywords that are acceptable in comments
 */
export const BDD_KEYWORDS = new Set([
  'given',
  'when',
  'then',
  'arrange',
  'act',
  'assert',
  'when & then',
  'when&then',
]);

/**
 * Prefixes for type checker and linter directives (acceptable comments)
 */
export const TYPE_CHECKER_PREFIXES = [
  // Python
  'type:',
  'noqa',
  'pyright:',
  'ruff:',
  'mypy:',
  'pylint:',
  'flake8:',
  'pyre:',
  'pytype:',
  // JavaScript/TypeScript
  'eslint-disable',
  'eslint-enable',
  'eslint-ignore',
  'prettier-ignore',
  'ts-ignore',
  'ts-expect-error',
  'ts-nocheck',
  '@ts-ignore',
  '@ts-expect-error',
  '@ts-nocheck',
  // Rust
  'clippy::',
  'allow(',
  'deny(',
  'warn(',
  'forbid(',
  // Go
  'nolint',
  'go:generate',
  'go:build',
  'go:embed',
  // Coverage
  'coverage:',
  'c8 ignore',
  'istanbul ignore',
  // Biome
  'biome-ignore',
  // Regions
  'region',
  'endregion',
  '#region',
  '#endregion',
];

/**
 * Header message for comment detection
 */
export const HOOK_MESSAGE_HEADER = `COMMENT/DOCSTRING DETECTED - IMMEDIATE ACTION REQUIRED

Your recent changes contain comments or docstrings, which triggered this hook.
You need to take immediate action. You must follow the conditions below.
(Listed in priority order - you must always act according to this priority order)

CRITICAL WARNING: This hook message MUST NEVER be ignored, even if you receive it multiple times.
You MUST provide corresponding explanation or action for EACH occurrence of this message.
Ignoring this message or failing to respond appropriately is strictly prohibited.

PRIORITY-BASED ACTION GUIDELINES:

1. This is a comment/docstring that already existed before
   -> Explain to the user that this is an existing comment/docstring and proceed (justify it)

2. This is a newly written comment: but it's in given, when, then format
   -> Tell the user it's a BDD comment and proceed (justify it)
   -> Note: This applies to comments only, not docstrings

3. This is a newly written comment/docstring: but it's a necessary comment/docstring
   -> Tell the user why this comment/docstring is absolutely necessary and proceed (justify it)
   -> Examples of necessary comments: complex algorithms, security-related, performance optimization, regex, mathematical formulas
   -> Examples of necessary docstrings: public API documentation, complex module/class interfaces
   -> IMPORTANT: Most docstrings are unnecessary if the code is self-explanatory. Only keep truly essential ones.

4. This is a newly written comment/docstring: but it's an unnecessary comment/docstring
   -> Apologize to the user and remove the comment/docstring.
   -> Make the code itself clearer so it can be understood without comments/docstrings.
   -> For verbose docstrings: refactor code to be self-documenting instead of adding lengthy explanations.

CODE SMELL WARNING: Using comments as visual separators (e.g., "// =========", "# ---", "// *** Section ***")
is a code smell. If you need separators, your file is too long or poorly organized.
Refactor into smaller modules or use proper code organization instead of comment-based section dividers.

MANDATORY REQUIREMENT: You must acknowledge this hook message and take one of the above actions.
Review in the above priority order and take the corresponding action EVERY TIME this appears.

Detected comments/docstrings:
`;

/**
 * Pattern for detecting line comments by language
 */
export const LINE_COMMENT_PATTERNS: Record<string, RegExp> = {
  // C-style: //, /* */
  js: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
  ts: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
  jsx: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
  tsx: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
  java: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
  c: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
  cpp: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
  cs: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
  go: /\/\/.*$/gm,
  rust: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
  swift: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
  kotlin: /\/\/.*$|\/\*[\s\S]*?\*\//gm,
  // Hash-style: #
  py: /#.*$|'''[\s\S]*?'''|"""[\s\S]*?"""/gm,
  rb: /#.*$|=begin[\s\S]*?=end/gm,
  sh: /#.*$/gm,
  bash: /#.*$/gm,
  zsh: /#.*$/gm,
  yaml: /#.*$/gm,
  yml: /#.*$/gm,
  toml: /#.*$/gm,
  // HTML-style: <!-- -->
  html: /<!--[\s\S]*?-->/gm,
  xml: /<!--[\s\S]*?-->/gm,
  vue: /<!--[\s\S]*?-->|\/\/.*$|\/\*[\s\S]*?\*\//gm,
  svelte: /<!--[\s\S]*?-->|\/\/.*$|\/\*[\s\S]*?\*\//gm,
  // SQL-style: --
  sql: /--.*$/gm,
  // Lua-style: --
  lua: /--.*$|--\[\[[\s\S]*?\]\]/gm,
};

/**
 * File extensions to language mapping
 */
export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.jsx': 'jsx',
  '.tsx': 'tsx',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'cs',
  '.go': 'go',
  '.rs': 'rust',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.py': 'py',
  '.pyi': 'py',
  '.rb': 'rb',
  '.sh': 'sh',
  '.bash': 'bash',
  '.zsh': 'zsh',
  '.yaml': 'yaml',
  '.yml': 'yml',
  '.toml': 'toml',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.sql': 'sql',
  '.lua': 'lua',
};
