/**
 * LSP Server Configurations
 *
 * Defines known language servers and their configurations.
 * Supports auto-detection and installation hints.
 */

import { spawnSync } from 'child_process';
import { extname } from 'path';

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
  php: {
    name: 'PHP Language Server (Intelephense)',
    command: 'intelephense',
    args: ['--stdio'],
    extensions: ['.php', '.phtml'],
    installHint: 'npm install -g intelephense'
  },
  ruby: {
    name: 'Ruby Language Server (Solargraph)',
    command: 'solargraph',
    args: ['stdio'],
    extensions: ['.rb', '.rake', '.gemspec', '.erb'],
    installHint: 'gem install solargraph'
  },
  lua: {
    name: 'Lua Language Server',
    command: 'lua-language-server',
    args: [],
    extensions: ['.lua'],
    installHint: 'Install from https://github.com/LuaLS/lua-language-server'
  },
  kotlin: {
    name: 'Kotlin Language Server',
    command: 'kotlin-language-server',
    args: [],
    extensions: ['.kt', '.kts'],
    installHint: 'Install from https://github.com/fwcd/kotlin-language-server'
  },
  elixir: {
    name: 'ElixirLS',
    command: 'elixir-ls',
    args: [],
    extensions: ['.ex', '.exs', '.heex', '.eex'],
    installHint: 'Install from https://github.com/elixir-lsp/elixir-ls'
  },
  csharp: {
    name: 'OmniSharp',
    command: 'omnisharp',
    args: ['-lsp'],
    extensions: ['.cs'],
    installHint: 'dotnet tool install -g omnisharp'
  },
  dart: {
    name: 'Dart Analysis Server',
    command: 'dart',
    args: ['language-server', '--protocol=lsp'],
    extensions: ['.dart'],
    installHint: 'Install Dart SDK from https://dart.dev/get-dart or Flutter SDK from https://flutter.dev'
  },
  swift: {
    name: 'SourceKit-LSP',
    command: 'sourcekit-lsp',
    args: [],
    extensions: ['.swift'],
    installHint: 'Install Swift from https://swift.org/download or via Xcode'
  }
};

/**
 * Check if a command exists in PATH
 */
export function commandExists(command: string): boolean {
  const checkCommand = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checkCommand, [command], { stdio: 'ignore' });
  return result.status === 0;
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
    'php': 'php',
    'phtml': 'php',
    'ruby': 'ruby',
    'rb': 'ruby',
    'rake': 'ruby',
    'gemspec': 'ruby',
    'erb': 'ruby',
    'lua': 'lua',
    'kotlin': 'kotlin',
    'kt': 'kotlin',
    'kts': 'kotlin',
    'elixir': 'elixir',
    'ex': 'elixir',
    'exs': 'elixir',
    'heex': 'elixir',
    'eex': 'elixir',
    'csharp': 'csharp',
    'c#': 'csharp',
    'cs': 'csharp',
    'dart': 'dart',
    'flutter': 'dart',
    'swift': 'swift'
  };

  const serverKey = langMap[language.toLowerCase()];
  if (serverKey && LSP_SERVERS[serverKey]) {
    return LSP_SERVERS[serverKey];
  }

  return null;
}
