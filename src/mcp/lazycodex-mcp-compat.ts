import { z } from 'zod';

export const LazyCodexMcpServerNames = [
  'grep_app',
  'context7',
  'codegraph',
  'git_bash',
  'lsp',
] as const;

export type LazyCodexMcpServerName = (typeof LazyCodexMcpServerNames)[number];

export const NativeBridgeServerSchema = z.object({
  command: z.literal('node'),
  args: z.tuple([z.literal('${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs')]),
});

export const SupportedLazyCodexMcpStatusSchema = z.object({
  supported: z.literal(true),
  note: z.string().min(1).optional(),
});

export const StagedLazyCodexMcpStatusSchema = z.object({
  supported: z.literal(false),
  stagedReason: z.string().min(1),
});

export const LazyCodexMcpStatusSchema = z.discriminatedUnion('supported', [
  SupportedLazyCodexMcpStatusSchema,
  StagedLazyCodexMcpStatusSchema,
]);

export const LazyCodexMcpCompatibilitySchema = z.object({
  schemaVersion: z.literal(1),
  bridge: NativeBridgeServerSchema.extend({
    name: z.literal('t'),
    supported: z.literal(true),
    smoke: z.string().min(1),
  }),
  servers: z.object({
    grep_app: LazyCodexMcpStatusSchema,
    context7: LazyCodexMcpStatusSchema,
    codegraph: LazyCodexMcpStatusSchema,
    git_bash: LazyCodexMcpStatusSchema,
    lsp: LazyCodexMcpStatusSchema,
  }),
});

export const OmcMcpConfigSchema = z.object({
  mcpServers: z.object({
    t: NativeBridgeServerSchema,
  }).catchall(z.unknown()),
  lazyccCompatibility: z.object({
    lazycodexSource: z.object({
      mcpParity: LazyCodexMcpCompatibilitySchema,
    }),
  }),
}).strict();

export type OmcMcpConfig = z.infer<typeof OmcMcpConfigSchema>;

export function parseOmcMcpConfig(input: unknown): OmcMcpConfig {
  return OmcMcpConfigSchema.parse(input);
}

export function getStagedLazyCodexMcpServerNames(
  config: OmcMcpConfig,
): readonly LazyCodexMcpServerName[] {
  return LazyCodexMcpServerNames.filter(
    (name) => !config.lazyccCompatibility.lazycodexSource.mcpParity.servers[name].supported,
  );
}

export function getAdvertisedStagedLazyCodexMcpServerNames(
  config: OmcMcpConfig,
): readonly LazyCodexMcpServerName[] {
  const advertisedServerNames = new Set(Object.keys(config.mcpServers));

  return getStagedLazyCodexMcpServerNames(config).filter((name) =>
    advertisedServerNames.has(name),
  );
}
