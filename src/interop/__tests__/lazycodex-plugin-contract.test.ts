import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const RelativePathSchema = z.string().regex(/^\.\/?[A-Za-z0-9._/-]+$/);
const PortableLazyCodexReferenceManifest = './docs/lazycodex-port/contract-inventory.md';

const PluginManifestSchema = z.object({
  name: z.literal('lazycc'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  skills: z.literal('./skills/'),
  mcpServers: z.literal('./.mcp.json'),
}).catchall(z.unknown()).superRefine((manifest, context) => {
  if (Object.prototype.hasOwnProperty.call(manifest, 'lazycodexCompatibility')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'legacy LazyCodex compatibility metadata belongs under package.json lazyccCompatibility',
      path: ['lazycodexCompatibility'],
    });
  }
});

const MarketplaceSchema = z.object({
  name: z.literal('lazycc'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  plugins: z.array(
    z.object({
      name: z.literal('lazycc'),
      source: z.literal('./'),
      category: z.string().min(1),
      tags: z.array(z.string().min(1)).min(1),
    }),
  ).min(1),
});

const McpConfigSchema = z.object({
  mcpServers: z.object({
    t: z.object({
      command: z.literal('node'),
      args: z.tuple([z.literal('${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs')]),
    }),
  }),
});

const PackageCompatibilitySchema = z.object({
  manifest: z.literal('.claude-plugin/plugin.json'),
  marketplace: z.literal('.claude-plugin/marketplace.json'),
  skillsPath: z.literal('skills'),
  mcpPath: z.literal('.mcp.json'),
  lazycodexSource: z.object({
    version: z.literal('4.15.1'),
    docs: z.literal('docs/lazycodex-port/contract-inventory.md'),
    stateFallback: z.literal('.lazycodex'),
  }),
  versionedDocs: z.array(z.literal('docs/lazycodex-port/contract-inventory.md')).min(1),
  packagedFiles: z.array(RelativePathSchema.or(z.string().regex(/^[A-Za-z0-9._/-]+$/))).min(6),
});

const PackageSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  files: z.array(z.string().min(1)),
  scripts: z.record(z.string()),
  lazyccCompatibility: PackageCompatibilitySchema,
});

const NpmPackDryRunSchema = z.array(z.object({
  files: z.array(z.object({ path: z.string().min(1) })),
})).min(1);
const LocalTaskPathPattern = new RegExp([
  `${['', 'Users', 'jacob'].join('/')}\\b`,
  ['omc', 'claude', 'port', 'lazycodex'].join('-'),
].join('|'));
const LocalWorktreeName = ['omc', 'claude', 'port', 'lazycodex'].join('-');

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'));
}

function readShippedLazyCodexDocPaths(): readonly string[] {
  const docsRoot = resolve(process.cwd(), 'docs', 'lazycodex-port');
  return readdirSync(docsRoot)
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => resolve(docsRoot, entry));
}

describe('LazyCC plugin metadata contract with legacy LazyCodex compatibility', () => {
  it('keeps the Claude plugin manifest LazyCC-native and strict-validation clean', () => {
    const plugin = PluginManifestSchema.parse(readJsonFile('.claude-plugin/plugin.json'));
    const marketplace = MarketplaceSchema.parse(readJsonFile('.claude-plugin/marketplace.json'));
    const mcp = McpConfigSchema.parse(readJsonFile('.mcp.json'));
    const packageJson = PackageSchema.parse(readJsonFile('package.json'));

    expect(plugin.name).toBe('lazycc');
    expect(marketplace.plugins.map((entry) => entry.name)).toContain('lazycc');
    expect(plugin.version).toBe(packageJson.version);
    expect(marketplace.version).toBe(packageJson.version);
    expect(Object.prototype.hasOwnProperty.call(plugin, 'lazycodexCompatibility')).toBe(false);
    expect(mcp.mcpServers.t.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs']);
  });

  it('keeps legacy LazyCodex compatibility surfaces included in npm packaging and build checks', () => {
    const packageJson = PackageSchema.parse(readJsonFile('package.json'));
    const requiredPackagedFiles = [
      '.claude-plugin',
      '.mcp.json',
      'skills',
      'docs',
      'bridge/mcp-server.cjs',
    ];

    expect(packageJson.scripts['check:lazycodex-plugin-contract']).toBe(
      'vitest run --run src/interop/__tests__/lazycodex-plugin-contract.test.ts',
    );
    for (const entry of requiredPackagedFiles) {
      expect(packageJson.files).toContain(entry);
      expect(packageJson.lazyccCompatibility.packagedFiles).toContain(entry);
    }
    expect(packageJson.lazyccCompatibility.lazycodexSource).toEqual({
      version: '4.15.1',
      docs: 'docs/lazycodex-port/contract-inventory.md',
      stateFallback: '.lazycodex',
    });
    for (const docPath of packageJson.lazyccCompatibility.versionedDocs) {
      expect(existsSync(resolve(process.cwd(), docPath))).toBe(true);
    }
  });

  it('packages the compiled LazyCodex hook adapter without requiring TypeScript source at runtime', () => {
    const dryRun = NpmPackDryRunSchema.parse(JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })));
    const packedPaths = dryRun.flatMap((entry) => entry.files.map((file) => file.path));

    expect(packedPaths).toContain('scripts/lazycodex-compat-hook.mjs');
    expect(packedPaths).toContain('dist/hooks/lazycodex-compat/cli.js');
    expect(packedPaths).not.toContain('src/hooks/lazycodex-compat/cli.ts');
  });

  it('keeps every npm-packed file free of machine-local absolute paths', () => {
    const dryRun = NpmPackDryRunSchema.parse(JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })));
    const packedPaths = dryRun.flatMap((entry) => entry.files.map((file) => file.path));
    const violations = packedPaths.flatMap((packedPath) => {
      const absolutePath = resolve(process.cwd(), packedPath);
      if (!existsSync(absolutePath)) {
        return [];
      }
      const content = readFileSync(absolutePath);
      if (content.includes(0)) {
        return [];
      }
      return LocalTaskPathPattern.test(content.toString('utf8')) ? [packedPath] : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps shipped LazyCodex docs free of task-local absolute paths', () => {
    for (const docPath of readShippedLazyCodexDocPaths()) {
      const content = readFileSync(docPath, 'utf8');
      expect(content).not.toMatch(/\/Users\//);
      expect(content).not.toContain(LocalWorktreeName);
    }
  });

  it('rejects malformed manifests before contract assertions', () => {
    const malformedManifest = {
      name: 'lazycodex',
      version: '4.11.5',
      skills: './skills/',
      mcpServers: './.mcp.json',
    };

    expect(() => PluginManifestSchema.parse(malformedManifest)).toThrow();
  });

  it('rejects legacy top-level LazyCodex compatibility metadata in the Claude plugin manifest', () => {
    const staleManifest = {
      name: 'lazycc',
      version: '4.11.5',
      skills: './skills/',
      mcpServers: './.mcp.json',
      lazycodexCompatibility: {
        schemaVersion: 1,
        sourcePlugin: {
          name: 'lazycodex',
          version: '4.15.1',
          referenceManifest: PortableLazyCodexReferenceManifest,
        },
        paths: {
          skills: './skills/',
          mcpServers: './.mcp.json',
          docs: './docs/lazycodex-port/contract-inventory.md',
        },
        policy: {
          hostMutationDefault: 'disabled',
          autoUpdateDefault: 'disabled',
          telemetryDefault: 'disabled',
          explicitOptInRequired: true,
        },
        surfaces: ['hooks', 'skills', 'mcp', 'agents', 'models', 'state', 'evidence'],
      },
    };

    expect(() => PluginManifestSchema.parse(staleManifest)).toThrow();
  });
});
