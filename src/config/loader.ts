/**
 * Configuration Loader
 *
 * Handles loading and merging configuration from multiple sources:
 * - User config: ~/.config/claude-omc/config.jsonc
 * - Project config: .claude/omc.jsonc
 * - Environment variables
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import * as jsonc from 'jsonc-parser';
import type { PluginConfig, ExternalModelsConfig } from '../shared/types.js';
import { getConfigDir } from '../utils/paths.js';
import {
  getDefaultModelHigh,
  getDefaultModelMedium,
  getDefaultModelLow,
} from './models.js';

/**
 * Default configuration.
 *
 * Model IDs are resolved from environment variables (OMC_MODEL_HIGH,
 * OMC_MODEL_MEDIUM, OMC_MODEL_LOW) with built-in fallbacks.
 * User/project config files can further override via deepMerge.
 *
 * Note: env vars for external model defaults (OMC_CODEX_DEFAULT_MODEL,
 * OMC_GEMINI_DEFAULT_MODEL) are read lazily in loadEnvConfig() to avoid
 * capturing stale values at module load time.
 */
export const DEFAULT_CONFIG: PluginConfig = {
  agents: {
    omc: { model: getDefaultModelHigh() },
    architect: { model: getDefaultModelHigh(), enabled: true },
    researcher: { model: getDefaultModelMedium() },
    explore: { model: getDefaultModelLow() },
    frontendEngineer: { model: getDefaultModelMedium(), enabled: true },
    documentWriter: { model: getDefaultModelLow(), enabled: true },
    multimodalLooker: { model: getDefaultModelMedium(), enabled: true },
    // New agents from oh-my-opencode
    critic: { model: getDefaultModelHigh(), enabled: true },
    analyst: { model: getDefaultModelHigh(), enabled: true },
    coordinator: { model: getDefaultModelMedium(), enabled: true },
    executor: { model: getDefaultModelMedium(), enabled: true },
    planner: { model: getDefaultModelHigh(), enabled: true }
  },
  features: {
    parallelExecution: true,
    lspTools: true,   // Real LSP integration with language servers
    astTools: true,   // Real AST tools using ast-grep
    continuationEnforcement: true,
    autoContextInjection: true
  },
  mcpServers: {
    exa: { enabled: true },
    context7: { enabled: true }
  },
  permissions: {
    allowBash: true,
    allowEdit: true,
    allowWrite: true,
    maxBackgroundTasks: 5
  },
  magicKeywords: {
    ultrawork: ['ultrawork', 'ulw', 'uw'],
    search: ['search', 'find', 'locate'],
    analyze: ['analyze', 'investigate', 'examine'],
    ultrathink: ['ultrathink', 'think', 'reason', 'ponder']
  },
  // Intelligent model routing configuration
  routing: {
    enabled: true,
    defaultTier: 'MEDIUM',
    escalationEnabled: true,
    maxEscalations: 2,
    tierModels: {
      LOW: getDefaultModelLow(),
      MEDIUM: getDefaultModelMedium(),
      HIGH: getDefaultModelHigh()
    },
    agentOverrides: {
      architect: { tier: 'HIGH', reason: 'Advisory agent requires deep reasoning' },
      planner: { tier: 'HIGH', reason: 'Strategic planning requires deep reasoning' },
      critic: { tier: 'HIGH', reason: 'Critical review requires deep reasoning' },
      analyst: { tier: 'HIGH', reason: 'Pre-planning analysis requires deep reasoning' },
      explore: { tier: 'LOW', reason: 'Exploration is search-focused' },
      'writer': { tier: 'LOW', reason: 'Documentation is straightforward' }
    },
    escalationKeywords: [
      'critical', 'production', 'urgent', 'security', 'breaking',
      'architecture', 'refactor', 'redesign', 'root cause'
    ],
    simplificationKeywords: [
      'find', 'list', 'show', 'where', 'search', 'locate', 'grep'
    ]
  },
  // External models configuration (Codex, Gemini)
  // Static defaults only — env var overrides applied in loadEnvConfig()
  externalModels: {
    defaults: {
      codexModel: 'gpt-5.3-codex',
      geminiModel: 'gemini-3.1-pro-preview',
    },
    fallbackPolicy: {
      onModelFailure: 'provider_chain',
      allowCrossProvider: false,
      crossProviderOrder: ['codex', 'gemini'],
    },
  },
  // Delegation routing configuration (opt-in feature for external model routing)
  delegationRouting: {
    enabled: false,  // Opt-in feature
    defaultProvider: 'claude',
    roles: {},
  },
  // Startup codebase map injection (issue #804)
  startupCodebaseMap: {
    enabled: true,
    maxFiles: 200,
    maxDepth: 4,
  },
  // Task size detection (issue #790): prevent over-orchestration for small tasks
  taskSizeDetection: {
    enabled: true,
    smallWordLimit: 50,
    largeWordLimit: 200,
    suppressHeavyModesForSmallTasks: true,
  },
};

/**
 * Configuration file locations
 */
export function getConfigPaths(): { user: string; project: string } {
  const userConfigDir = getConfigDir();

  return {
    user: join(userConfigDir, 'claude-omc', 'config.jsonc'),
    project: join(process.cwd(), '.claude', 'omc.jsonc')
  };
}

/**
 * Load and parse a JSONC file
 */
export function loadJsoncFile(path: string): PluginConfig | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const errors: jsonc.ParseError[] = [];
    const result = jsonc.parse(content, errors, {
      allowTrailingComma: true,
      allowEmptyContent: true
    });

    if (errors.length > 0) {
      console.warn(`Warning: Parse errors in ${path}:`, errors);
    }

    return result as PluginConfig;
  } catch (error) {
    console.error(`Error loading config from ${path}:`, error);
    return null;
  }
}

/**
 * Deep merge two objects
 */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      ) as T[keyof T];
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}

/**
 * Load configuration from environment variables
 */
export function loadEnvConfig(): Partial<PluginConfig> {
  const config: Partial<PluginConfig> = {};

  // MCP API keys
  if (process.env.EXA_API_KEY) {
    config.mcpServers = {
      ...config.mcpServers,
      exa: { enabled: true, apiKey: process.env.EXA_API_KEY }
    };
  }

  // Feature flags from environment
  if (process.env.OMC_PARALLEL_EXECUTION !== undefined) {
    config.features = {
      ...config.features,
      parallelExecution: process.env.OMC_PARALLEL_EXECUTION === 'true'
    };
  }

  if (process.env.OMC_LSP_TOOLS !== undefined) {
    config.features = {
      ...config.features,
      lspTools: process.env.OMC_LSP_TOOLS === 'true'
    };
  }

  if (process.env.OMC_MAX_BACKGROUND_TASKS) {
    const maxTasks = parseInt(process.env.OMC_MAX_BACKGROUND_TASKS, 10);
    if (!isNaN(maxTasks)) {
      config.permissions = {
        ...config.permissions,
        maxBackgroundTasks: maxTasks
      };
    }
  }

  // Routing configuration from environment
  if (process.env.OMC_ROUTING_ENABLED !== undefined) {
    config.routing = {
      ...config.routing,
      enabled: process.env.OMC_ROUTING_ENABLED === 'true'
    };
  }

  if (process.env.OMC_ROUTING_DEFAULT_TIER) {
    const tier = process.env.OMC_ROUTING_DEFAULT_TIER.toUpperCase();
    if (tier === 'LOW' || tier === 'MEDIUM' || tier === 'HIGH') {
      config.routing = {
        ...config.routing,
        defaultTier: tier as 'LOW' | 'MEDIUM' | 'HIGH'
      };
    }
  }

  if (process.env.OMC_ESCALATION_ENABLED !== undefined) {
    config.routing = {
      ...config.routing,
      escalationEnabled: process.env.OMC_ESCALATION_ENABLED === 'true'
    };
  }

  // External models configuration from environment
  const externalModelsDefaults: ExternalModelsConfig['defaults'] = {};

  if (process.env.OMC_EXTERNAL_MODELS_DEFAULT_PROVIDER) {
    const provider = process.env.OMC_EXTERNAL_MODELS_DEFAULT_PROVIDER;
    if (provider === 'codex' || provider === 'gemini') {
      externalModelsDefaults.provider = provider;
    }
  }

  if (process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL) {
    externalModelsDefaults.codexModel = process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL;
  } else if (process.env.OMC_CODEX_DEFAULT_MODEL) {
    // Legacy fallback
    externalModelsDefaults.codexModel = process.env.OMC_CODEX_DEFAULT_MODEL;
  }

  if (process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL) {
    externalModelsDefaults.geminiModel = process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL;
  } else if (process.env.OMC_GEMINI_DEFAULT_MODEL) {
    // Legacy fallback
    externalModelsDefaults.geminiModel = process.env.OMC_GEMINI_DEFAULT_MODEL;
  }

  const externalModelsFallback: ExternalModelsConfig['fallbackPolicy'] = {
    onModelFailure: 'provider_chain'
  };

  if (process.env.OMC_EXTERNAL_MODELS_FALLBACK_POLICY) {
    const policy = process.env.OMC_EXTERNAL_MODELS_FALLBACK_POLICY;
    if (policy === 'provider_chain' || policy === 'cross_provider' || policy === 'claude_only') {
      externalModelsFallback.onModelFailure = policy;
    }
  }

  // Only add externalModels if any env vars were set
  if (Object.keys(externalModelsDefaults).length > 0 || externalModelsFallback.onModelFailure !== 'provider_chain') {
    config.externalModels = {
      defaults: externalModelsDefaults,
      fallbackPolicy: externalModelsFallback
    };
  }

  // Delegation routing configuration from environment
  if (process.env.OMC_DELEGATION_ROUTING_ENABLED !== undefined) {
    config.delegationRouting = {
      ...config.delegationRouting,
      enabled: process.env.OMC_DELEGATION_ROUTING_ENABLED === 'true',
    };
  }

  if (process.env.OMC_DELEGATION_ROUTING_DEFAULT_PROVIDER) {
    const provider = process.env.OMC_DELEGATION_ROUTING_DEFAULT_PROVIDER;
    if (['claude', 'codex', 'gemini'].includes(provider)) {
      config.delegationRouting = {
        ...config.delegationRouting,
        defaultProvider: provider as 'claude' | 'codex' | 'gemini',
      };
    }
  }

  return config;
}

/**
 * Load and merge all configuration sources
 */
export function loadConfig(): PluginConfig {
  const paths = getConfigPaths();

  // Start with defaults
  let config = { ...DEFAULT_CONFIG };

  // Merge user config
  const userConfig = loadJsoncFile(paths.user);
  if (userConfig) {
    config = deepMerge(config, userConfig);
  }

  // Merge project config (takes precedence over user)
  const projectConfig = loadJsoncFile(paths.project);
  if (projectConfig) {
    config = deepMerge(config, projectConfig);
  }

  // Merge environment variables (highest precedence)
  const envConfig = loadEnvConfig();
  config = deepMerge(config, envConfig);

  return config;
}

/**
 * Find and load AGENTS.md or CLAUDE.md files for context injection
 */
export function findContextFiles(startDir?: string): string[] {
  const files: string[] = [];
  const searchDir = startDir ?? process.cwd();

  // Files to look for
  const contextFileNames = [
    'AGENTS.md',
    'CLAUDE.md',
    '.claude/CLAUDE.md',
    '.claude/AGENTS.md'
  ];

  // Search in current directory and parent directories
  let currentDir = searchDir;
  const searchedDirs = new Set<string>();

  while (currentDir && !searchedDirs.has(currentDir)) {
    searchedDirs.add(currentDir);

    for (const fileName of contextFileNames) {
      const filePath = join(currentDir, fileName);
      if (existsSync(filePath) && !files.includes(filePath)) {
        files.push(filePath);
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return files;
}

/**
 * Load context from AGENTS.md/CLAUDE.md files
 */
export function loadContextFromFiles(files: string[]): string {
  const contexts: string[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      contexts.push(`## Context from ${file}\n\n${content}`);
    } catch (error) {
      console.warn(`Warning: Could not read context file ${file}:`, error);
    }
  }

  return contexts.join('\n\n---\n\n');
}

/**
 * Generate JSON Schema for configuration (for editor autocomplete)
 */
export function generateConfigSchema(): object {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Oh-My-ClaudeCode Configuration',
    type: 'object',
    properties: {
      agents: {
        type: 'object',
        description: 'Agent model and feature configuration',
        properties: {
          omc: {
            type: 'object',
            properties: {
              model: { type: 'string', description: 'Model ID for the main orchestrator' }
            }
          },
          architect: {
            type: 'object',
            properties: {
              model: { type: 'string' },
              enabled: { type: 'boolean' }
            }
          },
          researcher: {
            type: 'object',
            properties: { model: { type: 'string' } }
          },
          explore: {
            type: 'object',
            properties: { model: { type: 'string' } }
          },
          frontendEngineer: {
            type: 'object',
            properties: {
              model: { type: 'string' },
              enabled: { type: 'boolean' }
            }
          },
          documentWriter: {
            type: 'object',
            properties: {
              model: { type: 'string' },
              enabled: { type: 'boolean' }
            }
          },
          multimodalLooker: {
            type: 'object',
            properties: {
              model: { type: 'string' },
              enabled: { type: 'boolean' }
            }
          }
        }
      },
      features: {
        type: 'object',
        description: 'Feature toggles',
        properties: {
          parallelExecution: { type: 'boolean', default: true },
          lspTools: { type: 'boolean', default: true },
          astTools: { type: 'boolean', default: true },
          continuationEnforcement: { type: 'boolean', default: true },
          autoContextInjection: { type: 'boolean', default: true }
        }
      },
      mcpServers: {
        type: 'object',
        description: 'MCP server configurations',
        properties: {
          exa: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              apiKey: { type: 'string' }
            }
          },
          context7: {
            type: 'object',
            properties: { enabled: { type: 'boolean' } }
          }
        }
      },
      permissions: {
        type: 'object',
        description: 'Permission settings',
        properties: {
          allowBash: { type: 'boolean', default: true },
          allowEdit: { type: 'boolean', default: true },
          allowWrite: { type: 'boolean', default: true },
          maxBackgroundTasks: { type: 'integer', default: 5, minimum: 1, maximum: 50 }
        }
      },
      magicKeywords: {
        type: 'object',
        description: 'Magic keyword triggers',
        properties: {
          ultrawork: { type: 'array', items: { type: 'string' } },
          search: { type: 'array', items: { type: 'string' } },
          analyze: { type: 'array', items: { type: 'string' } },
          ultrathink: { type: 'array', items: { type: 'string' } }
        }
      },
      externalModels: {
        type: 'object',
        description: 'External model provider configuration (Codex, Gemini)',
        properties: {
          defaults: {
            type: 'object',
            description: 'Default model settings for external providers',
            properties: {
              provider: {
                type: 'string',
                enum: ['codex', 'gemini'],
                description: 'Default external provider'
              },
              codexModel: {
                type: 'string',
                default: 'gpt-5.3-codex',
                description: 'Default Codex model'
              },
              geminiModel: {
                type: 'string',
                default: 'gemini-3.1-pro-preview',
                description: 'Default Gemini model'
              }
            }
          },
          rolePreferences: {
            type: 'object',
            description: 'Provider/model preferences by agent role',
            additionalProperties: {
              type: 'object',
              properties: {
                provider: { type: 'string', enum: ['codex', 'gemini'] },
                model: { type: 'string' }
              },
              required: ['provider', 'model']
            }
          },
          taskPreferences: {
            type: 'object',
            description: 'Provider/model preferences by task type',
            additionalProperties: {
              type: 'object',
              properties: {
                provider: { type: 'string', enum: ['codex', 'gemini'] },
                model: { type: 'string' }
              },
              required: ['provider', 'model']
            }
          },
          fallbackPolicy: {
            type: 'object',
            description: 'Fallback behavior on model failure',
            properties: {
              onModelFailure: {
                type: 'string',
                enum: ['provider_chain', 'cross_provider', 'claude_only'],
                default: 'provider_chain',
                description: 'Fallback strategy when a model fails'
              },
              allowCrossProvider: {
                type: 'boolean',
                default: false,
                description: 'Allow fallback to a different provider'
              },
              crossProviderOrder: {
                type: 'array',
                items: { type: 'string', enum: ['codex', 'gemini'] },
                default: ['codex', 'gemini'],
                description: 'Order of providers for cross-provider fallback'
              }
            }
          }
        }
      },
      delegationRouting: {
        type: 'object',
        description: 'Delegation routing configuration for external model providers (opt-in feature)',
        properties: {
          enabled: {
            type: 'boolean',
            default: false,
            description: 'Enable delegation routing to external providers (Codex, Gemini)'
          },
          defaultProvider: {
            type: 'string',
            enum: ['claude', 'codex', 'gemini'],
            default: 'claude',
            description: 'Default provider for delegation routing when no specific role mapping exists'
          },
          roles: {
            type: 'object',
            description: 'Provider mappings by agent role',
            additionalProperties: {
              type: 'object',
              properties: {
                provider: { type: 'string', enum: ['claude', 'codex', 'gemini'] },
                tool: { type: 'string', enum: ['Task'] },
                model: { type: 'string' },
                agentType: { type: 'string' },
                fallback: { type: 'array', items: { type: 'string' } }
              },
              required: ['provider', 'tool']
            }
          }
        }
      }
    }
  };
}
