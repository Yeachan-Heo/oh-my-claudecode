import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { LSP_SERVERS, getServerForFile, getServerForLanguage, getTypeScriptServerForWorkspace } from '../tools/lsp/servers.js';
function createTypeScriptProject(options) {
    const root = mkdtempSync(join(tmpdir(), 'omc-lsp-ts-'));
    const typescriptRoot = join(root, 'node_modules', 'typescript');
    mkdirSync(join(typescriptRoot, 'lib'), { recursive: true });
    writeFileSync(join(typescriptRoot, 'package.json'), JSON.stringify({ version: options.version }));
    if (options.tsserver) {
        writeFileSync(join(typescriptRoot, 'lib', 'tsserver.js'), '');
    }
    if (options.getExePath) {
        writeFileSync(join(typescriptRoot, 'lib', 'getExePath.js'), '');
    }
    if (options.tscBin) {
        const binDir = join(root, 'node_modules', '.bin');
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(binDir, process.platform === 'win32' ? 'tsc.cmd' : 'tsc'), '');
    }
    return root;
}
describe('LSP Server Configurations', () => {
    const serverKeys = Object.keys(LSP_SERVERS);
    it('should have 20 configured servers', () => {
        expect(serverKeys).toHaveLength(20);
    });
    it.each(serverKeys)('server "%s" should have valid config', (key) => {
        const config = LSP_SERVERS[key];
        expect(config.name).toBeTruthy();
        expect(config.command).toBeTruthy();
        expect(Array.isArray(config.args)).toBe(true);
        expect(config.extensions.length).toBeGreaterThan(0);
        expect(config.installHint).toBeTruthy();
    });
    it('kotlin should use stdio and an extended initialize timeout', () => {
        expect(LSP_SERVERS.kotlin.args).toContain('--stdio');
        expect(LSP_SERVERS.kotlin.initializeTimeoutMs).toBeGreaterThan(15_000);
    });
    it('should have no duplicate extension mappings across servers', () => {
        const seen = new Map();
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
    const cases = [
        ['app.ts', 'TypeScript Language Server'],
        ['app.py', 'Python Language Server (ty)'],
        ['main.rs', 'Rust Analyzer'],
        ['main.go', 'gopls'],
        ['main.c', 'clangd'],
        ['App.java', 'Eclipse JDT Language Server'],
        ['data.json', 'JSON Language Server'],
        ['index.html', 'HTML Language Server'],
        ['style.css', 'CSS Language Server'],
        ['App.vue', 'Vue Language Server (Volar)'],
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
        ['counter.v', 'Verible Verilog Language Server'],
        ['defs.vh', 'Verible Verilog Language Server'],
        ['top.sv', 'Verible Verilog Language Server'],
        ['pkg.svh', 'Verible Verilog Language Server'],
    ];
    it.each(cases)('should resolve "%s" to "%s"', (file, expectedName) => {
        const server = getServerForFile(file);
        expect(server).not.toBeNull();
        expect(server.name).toBe(expectedName);
    });
    it('should return null for unknown extensions', () => {
        expect(getServerForFile('file.xyz')).toBeNull();
    });
});
describe('TypeScript server selection', () => {
    it('uses project-local tsc --lsp --stdio for TypeScript 7 projects', () => {
        const root = createTypeScriptProject({ version: '7.0.1-rc', tscBin: true });
        try {
            const server = getTypeScriptServerForWorkspace(root);
            expect(server.name).toBe('TypeScript 7 Native Language Server (typescript-go)');
            expect(server.command).toBe(join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'));
            expect(server.args).toEqual(['--lsp', '--stdio']);
            expect(getServerForFile(join(root, 'src', 'app.ts'), root)).toEqual(server);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('uses project-local tsc when TypeScript has no tsserver.js', () => {
        const root = createTypeScriptProject({ version: '6.0.0-dev', tscBin: true });
        try {
            const server = getTypeScriptServerForWorkspace(root);
            expect(server.command).toBe(join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'));
            expect(server.args).toEqual(['--lsp', '--stdio']);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('uses project-local tsc when TypeScript exposes native getExePath metadata', () => {
        const root = createTypeScriptProject({ version: '6.0.0-dev', getExePath: true, tsserver: true, tscBin: true });
        try {
            const server = getTypeScriptServerForWorkspace(root);
            expect(server.command).toBe(join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'));
            expect(server.args).toEqual(['--lsp', '--stdio']);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('keeps classic typescript-language-server for classic TypeScript projects', () => {
        const root = createTypeScriptProject({ version: '5.7.2', tsserver: true, tscBin: true });
        try {
            const server = getTypeScriptServerForWorkspace(root);
            expect(server).toBe(LSP_SERVERS.typescript);
            expect(server.command).toBe('typescript-language-server');
            expect(server.args).toEqual(['--stdio']);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('falls back to classic server when native TypeScript has no local tsc binary', () => {
        const root = createTypeScriptProject({ version: '7.0.1-rc' });
        try {
            const server = getTypeScriptServerForWorkspace(root);
            expect(server).toBe(LSP_SERVERS.typescript);
            expect(server.command).toBe('typescript-language-server');
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
describe('getServerForLanguage', () => {
    const cases = [
        ['typescript', 'TypeScript Language Server'],
        ['javascript', 'TypeScript Language Server'],
        ['python', 'Python Language Server (ty)'],
        ['rust', 'Rust Analyzer'],
        ['go', 'gopls'],
        ['golang', 'gopls'],
        ['c', 'clangd'],
        ['cpp', 'clangd'],
        ['java', 'Eclipse JDT Language Server'],
        ['json', 'JSON Language Server'],
        ['html', 'HTML Language Server'],
        ['css', 'CSS Language Server'],
        ['vue', 'Vue Language Server (Volar)'],
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
        ['verilog', 'Verible Verilog Language Server'],
        ['systemverilog', 'Verible Verilog Language Server'],
        ['sv', 'Verible Verilog Language Server'],
        ['v', 'Verible Verilog Language Server'],
    ];
    it.each(cases)('should resolve language "%s" to "%s"', (lang, expectedName) => {
        const server = getServerForLanguage(lang);
        expect(server).not.toBeNull();
        expect(server.name).toBe(expectedName);
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
describe('Python server selection', () => {
    it('should invoke ty via its LSP subcommand', () => {
        expect(LSP_SERVERS.python.command).toBe('ty');
        expect(LSP_SERVERS.python.args).toEqual(['server']);
    });
});
//# sourceMappingURL=lsp-servers.test.js.map