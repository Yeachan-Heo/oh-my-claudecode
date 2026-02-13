import { describe, it, expect } from 'vitest';
import { LSP_SERVERS, getServerForFile, getServerForLanguage } from '../tools/lsp/servers.js';

describe('LSP Server Configurations', () => {
  const serverKeys = Object.keys(LSP_SERVERS);

  it('should have 17 configured servers', () => {
    expect(serverKeys).toHaveLength(17);
  });

  it.each(serverKeys)('server "%s" should have valid config', (key) => {
    const config = LSP_SERVERS[key];
    expect(config.name).toBeTruthy();
    expect(config.command).toBeTruthy();
    expect(Array.isArray(config.args)).toBe(true);
    expect(config.extensions.length).toBeGreaterThan(0);
    expect(config.installHint).toBeTruthy();
  });

  it('should have no duplicate extension mappings across servers', () => {
    const seen = new Map<string, string>();
    for (const [key, config] of Object.entries(LSP_SERVERS)) {
      for (const ext of config.extensions) {
        if (seen.has(ext)) {
          throw new Error(`Extension "${ext}" mapped to both "${seen.get(ext)}" and "${key}"`);
        }
        seen.set(ext, key);
      }
    }
  });
});

describe('getServerForFile', () => {
  const cases: [string, string][] = [
    ['app.ts', 'TypeScript Language Server'],
    ['app.py', 'Python Language Server (pylsp)'],
    ['main.rs', 'Rust Analyzer'],
    ['main.go', 'gopls'],
    ['main.c', 'clangd'],
    ['App.java', 'Eclipse JDT Language Server'],
    ['data.json', 'JSON Language Server'],
    ['index.html', 'HTML Language Server'],
    ['style.css', 'CSS Language Server'],
    ['config.yaml', 'YAML Language Server'],
    ['index.php', 'PHP Language Server (Intelephense)'],
    ['template.phtml', 'PHP Language Server (Intelephense)'],
    ['app.rb', 'Ruby Language Server (Solargraph)'],
    ['Rakefile.rake', 'Ruby Language Server (Solargraph)'],
    ['test.gemspec', 'Ruby Language Server (Solargraph)'],
    ['init.lua', 'Lua Language Server'],
    ['Main.kt', 'Kotlin Language Server'],
    ['build.gradle.kts', 'Kotlin Language Server'],
    ['app.ex', 'ElixirLS'],
    ['test.exs', 'ElixirLS'],
    ['page.heex', 'ElixirLS'],
    ['template.eex', 'ElixirLS'],
    ['Program.cs', 'OmniSharp'],
    ['main.dart', 'Dart Analysis Server'],
    ['view.erb', 'Ruby Language Server (Solargraph)'],
  ];

  it.each(cases)('should resolve "%s" to "%s"', (file, expectedName) => {
    const server = getServerForFile(file);
    expect(server).not.toBeNull();
    expect(server!.name).toBe(expectedName);
  });

  it('should return null for unknown extensions', () => {
    expect(getServerForFile('file.xyz')).toBeNull();
  });
});

describe('getServerForLanguage', () => {
  const cases: [string, string][] = [
    ['typescript', 'TypeScript Language Server'],
    ['javascript', 'TypeScript Language Server'],
    ['python', 'Python Language Server (pylsp)'],
    ['rust', 'Rust Analyzer'],
    ['go', 'gopls'],
    ['golang', 'gopls'],
    ['c', 'clangd'],
    ['cpp', 'clangd'],
    ['java', 'Eclipse JDT Language Server'],
    ['json', 'JSON Language Server'],
    ['html', 'HTML Language Server'],
    ['css', 'CSS Language Server'],
    ['yaml', 'YAML Language Server'],
    // New languages
    ['php', 'PHP Language Server (Intelephense)'],
    ['phtml', 'PHP Language Server (Intelephense)'],
    ['ruby', 'Ruby Language Server (Solargraph)'],
    ['rb', 'Ruby Language Server (Solargraph)'],
    ['rake', 'Ruby Language Server (Solargraph)'],
    ['gemspec', 'Ruby Language Server (Solargraph)'],
    ['lua', 'Lua Language Server'],
    ['kotlin', 'Kotlin Language Server'],
    ['kt', 'Kotlin Language Server'],
    ['kts', 'Kotlin Language Server'],
    ['elixir', 'ElixirLS'],
    ['ex', 'ElixirLS'],
    ['exs', 'ElixirLS'],
    ['heex', 'ElixirLS'],
    ['eex', 'ElixirLS'],
    ['csharp', 'OmniSharp'],
    ['erb', 'Ruby Language Server (Solargraph)'],
    ['c#', 'OmniSharp'],
    ['cs', 'OmniSharp'],
    ['dart', 'Dart Analysis Server'],
    ['flutter', 'Dart Analysis Server'],
  ];

  it.each(cases)('should resolve language "%s" to "%s"', (lang, expectedName) => {
    const server = getServerForLanguage(lang);
    expect(server).not.toBeNull();
    expect(server!.name).toBe(expectedName);
  });

  it('should be case-insensitive', () => {
    expect(getServerForLanguage('PHP')?.name).toBe('PHP Language Server (Intelephense)');
    expect(getServerForLanguage('Kotlin')?.name).toBe('Kotlin Language Server');
  });

  it('should return null for unknown languages', () => {
    expect(getServerForLanguage('brainfuck')).toBeNull();
  });
});

describe('OmniSharp command casing', () => {
  it('should use lowercase command for cross-platform compatibility', () => {
    expect(LSP_SERVERS.csharp.command).toBe('omnisharp');
  });
});
