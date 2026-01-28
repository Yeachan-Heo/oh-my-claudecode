/**
 * LSP Server Configurations
 *
 * Defines known language servers and their configurations.
 * Supports auto-detection and installation hints.
 */

import { execFileSync } from 'child_process';
import { extname } from 'path';

/**
 * Timeout for which/where command existence checks (ms)
 */
const COMMAND_EXISTS_TIMEOUT_MS = 5000;

export interface LspServerConfig {
  name: string;
  command: string;
  args: string[];
  extensions: string[];
  installHint: string;
  initializationOptions?: Record<string, unknown>;
}

/**
 * Known LSP servers and their configurations
 */
export const LSP_SERVERS: Record<string, LspServerConfig> = {
  typescript: {
    name: 'TypeScript Language Server',
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
    installHint: 'npm install -g typescript-language-server typescript'
  },
  python: {
    name: 'Python Language Server (pylsp)',
    command: 'pylsp',
    args: [],
    extensions: ['.py', '.pyw'],
    installHint: 'pip install python-lsp-server'
  },
  rust: {
    name: 'Rust Analyzer',
    command: 'rust-analyzer',
    args: [],
    extensions: ['.rs'],
    installHint: 'rustup component add rust-analyzer'
  },
  go: {
    name: 'gopls',
    command: 'gopls',
    args: ['serve'],
    extensions: ['.go'],
    installHint: 'go install golang.org/x/tools/gopls@latest'
  },
  c: {
    name: 'clangd',
    command: 'clangd',
    args: [],
    extensions: ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
    installHint: 'Install clangd from your package manager or LLVM'
  },
  java: {
    name: 'Eclipse JDT Language Server',
    command: 'jdtls',
    args: [],
    extensions: ['.java'],
    installHint: 'Install from https://github.com/eclipse/eclipse.jdt.ls'
  },
  json: {
    name: 'JSON Language Server',
    command: 'vscode-json-language-server',
    args: ['--stdio'],
    extensions: ['.json', '.jsonc'],
    installHint: 'npm install -g vscode-langservers-extracted'
  },
  html: {
    name: 'HTML Language Server',
    command: 'vscode-html-language-server',
    args: ['--stdio'],
    extensions: ['.html', '.htm'],
    installHint: 'npm install -g vscode-langservers-extracted'
  },
  css: {
    name: 'CSS Language Server',
    command: 'vscode-css-language-server',
    args: ['--stdio'],
    extensions: ['.css', '.scss', '.less'],
    installHint: 'npm install -g vscode-langservers-extracted'
  },
  yaml: {
    name: 'YAML Language Server',
    command: 'yaml-language-server',
    args: ['--stdio'],
    extensions: ['.yaml', '.yml'],
    installHint: 'npm install -g yaml-language-server'
  },
  ruby: {
    name: 'Solargraph',
    command: 'solargraph',
    args: ['stdio'],
    extensions: ['.rb', '.rake', '.gemspec'],
    installHint: 'gem install solargraph'
  },
  php: {
    name: 'Intelephense',
    command: 'intelephense',
    args: ['--stdio'],
    extensions: ['.php', '.phtml'],
    installHint: 'npm install -g intelephense'
  },
  lua: {
    name: 'Lua Language Server',
    command: 'lua-language-server',
    args: [],
    extensions: ['.lua'],
    installHint: 'brew install lua-language-server (or see https://github.com/LuaLS/lua-language-server)'
  },
  bash: {
    name: 'Bash Language Server',
    command: 'bash-language-server',
    args: ['start'],
    extensions: ['.sh', '.bash', '.zsh'],
    installHint: 'npm install -g bash-language-server'
  },
  elixir: {
    name: 'Elixir LS',
    command: 'elixir-ls',
    args: [],
    extensions: ['.ex', '.exs'],
    installHint: 'See https://github.com/elixir-lsp/elixir-ls - user may need to create wrapper script "elixir-ls" that calls language_server.sh'
  },
  kotlin: {
    name: 'Kotlin Language Server',
    command: 'kotlin-language-server',
    args: [],
    extensions: ['.kt', '.kts'],
    installHint: 'See https://github.com/fwcd/kotlin-language-server'
  },
  swift: {
    name: 'SourceKit-LSP',
    command: 'sourcekit-lsp',
    args: [],
    extensions: ['.swift'],
    installHint: 'Included with Xcode or Swift toolchain'
  },
  csharp: {
    name: 'OmniSharp / csharp-ls',
    command: 'omnisharp',
    args: ['-lsp'],
    extensions: ['.cs'],
    installHint: 'Option 1: dotnet tool install --global csharp-ls (simpler). Option 2: See https://github.com/OmniSharp/omnisharp-roslyn'
  },
  scala: {
    name: 'Metals',
    command: 'metals',
    args: [],
    extensions: ['.scala', '.sc', '.sbt'],
    installHint: 'cs install metals (requires Coursier)'
  },
  zig: {
    name: 'ZLS',
    command: 'zls',
    args: [],
    extensions: ['.zig'],
    installHint: 'See https://github.com/zigtools/zls'
  },
  haskell: {
    name: 'Haskell Language Server',
    command: 'haskell-language-server-wrapper',
    args: ['--lsp'],
    extensions: ['.hs', '.lhs'],
    installHint: 'ghcup install hls'
  }
};

/**
 * Check if a command exists in PATH
 *
 * Uses execFileSync with array arguments to prevent shell injection.
 * Input validation rejects command names with shell metacharacters.
 */
export function commandExists(command: string): boolean {
  // Input validation - only allow safe command names (alphanumeric, dot, underscore, hyphen)
  if (!command || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(command)) {
    return false;
  }
  try {
    const checkCommand = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(checkCommand, [command], {
      stdio: 'ignore',
      timeout: COMMAND_EXISTS_TIMEOUT_MS
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the LSP server config for a file based on its extension
 */
export function getServerForFile(filePath: string): LspServerConfig | null {
  const ext = extname(filePath).toLowerCase();

  for (const [_, config] of Object.entries(LSP_SERVERS)) {
    if (config.extensions.includes(ext)) {
      return config;
    }
  }

  return null;
}

/**
 * Get all available servers (installed and not installed)
 */
export function getAllServers(): Array<LspServerConfig & { installed: boolean }> {
  return Object.values(LSP_SERVERS).map(config => ({
    ...config,
    installed: commandExists(config.command)
  }));
}

/**
 * Get the appropriate server for a language
 */
export function getServerForLanguage(language: string): LspServerConfig | null {
  // Map common language names to server keys
  const langMap: Record<string, string> = {
    'javascript': 'typescript',
    'typescript': 'typescript',
    'tsx': 'typescript',
    'jsx': 'typescript',
    'python': 'python',
    'rust': 'rust',
    'go': 'go',
    'golang': 'go',
    'c': 'c',
    'cpp': 'c',
    'c++': 'c',
    'java': 'java',
    'json': 'json',
    'html': 'html',
    'css': 'css',
    'scss': 'css',
    'less': 'css',
    'yaml': 'yaml',
    'ruby': 'ruby',
    'php': 'php',
    'lua': 'lua',
    'bash': 'bash',
    'shell': 'bash',
    'sh': 'bash',
    'shellscript': 'bash',
    'elixir': 'elixir',
    'kotlin': 'kotlin',
    'swift': 'swift',
    'csharp': 'csharp',
    'c#': 'csharp',
    'scala': 'scala',
    'zig': 'zig',
    'haskell': 'haskell',
    'hs': 'haskell'
  };

  const serverKey = langMap[language.toLowerCase()];
  if (serverKey && LSP_SERVERS[serverKey]) {
    return LSP_SERVERS[serverKey];
  }

  return null;
}
