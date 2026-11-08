import type { NodeExecutionContext } from "../types.js";

/** Environment required for ordinary process operation, excluding secrets. */
const BASE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "USER",
  "USERNAME",
  "LOGNAME",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const;

/** Provider settings deliberately forwarded to the Agent SDK only. */
const AGENT_PROVIDER_ENV_ALLOWLIST = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "KIMI_API_KEY",
  "ZAI_API_KEY",
  "MINIMAX_API_KEY",
] as const;

const TOKEN_PATTERN = /\{(\w+)\}/g;

/** Built-in agent execution is read-only and never prompts for extra access. */
export const READ_ONLY_AGENT_TOOLS = ["Read", "Glob", "Grep"] as const;

function baseEnv(): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const key of BASE_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) child[key] = value;
  }
  return child;
}

/** Environment for arbitrary command nodes, including graph-owned variables. */
export function buildCommandEnv(idempotencyKey?: string): NodeJS.ProcessEnv {
  const child = baseEnv();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GRAPH_") && value !== undefined) child[key] = value;
  }
  if (idempotencyKey !== undefined) {
    child.GRAPH_IDEMPOTENCY_KEY = idempotencyKey;
  }
  return child;
}

/** Environment for the read-only Agent SDK subprocess. */
export function buildAgentEnv(idempotencyKey?: string): NodeJS.ProcessEnv {
  const child = baseEnv();
  for (const key of AGENT_PROVIDER_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) child[key] = value;
  }
  if (idempotencyKey !== undefined) {
    child.GRAPH_IDEMPOTENCY_KEY = idempotencyKey;
  }
  return child;
}

/** Resolve an idempotency key before an external effect starts. */
export function idempotencyKeyFor(
  context: NodeExecutionContext,
): string | undefined {
  if (context.node.effect_policy.policy !== "idempotent") return undefined;
  const tokens: Readonly<Record<string, string>> = {
    run_id: context.descriptor.run_id,
    node_id: context.node.id,
    activation_id: context.activation_id,
    attempt_id: context.attempt_id,
    attempt_no: String(context.attempt_no),
  };
  return context.node.effect_policy.idempotency_key_template.replace(
    TOKEN_PATTERN,
    (match, token: string) =>
      Object.prototype.hasOwnProperty.call(tokens, token) ? tokens[token]! : match,
  );
}

