// Shared constant imported by scripts/session-start.mjs and
// templates/hooks/session-start.mjs. Kept in a side-effect-free module so
// tests can import it without triggering hook entrypoint side effects.
export const MODEL_ROUTING_OVERRIDE_MESSAGE = `<system-reminder>

[MODEL ROUTING OVERRIDE — NON-STANDARD PROVIDER DETECTED]

This environment uses a non-standard model provider (AWS Bedrock, Google Vertex AI, or a proxy such as CC Switch / LiteLLM).

How to pass \`model\` on Task/Agent calls:
- Prefer a tier alias: \`model: "sonnet"\`, \`model: "opus"\`, or \`model: "haiku"\`. OMC's pre-tool enforcer resolves these to provider-safe IDs when one of these env vars is set: \`ANTHROPIC_DEFAULT_SONNET_MODEL\` (and sibling \`ANTHROPIC_DEFAULT_OPUS_MODEL\` / \`ANTHROPIC_DEFAULT_HAIKU_MODEL\`), \`CLAUDE_CODE_BEDROCK_SONNET_MODEL\` (and sibling \`CLAUDE_CODE_BEDROCK_OPUS_MODEL\` / \`CLAUDE_CODE_BEDROCK_HAIKU_MODEL\`), or \`OMC_SUBAGENT_MODEL\`.
- If none of those env vars are configured, the enforcer will deny the tier alias with an env-var configuration hint — set one of them in your \`settings.json\` env or shell profile.
- The enforcer denies tier aliases it cannot resolve. It also denies provider-specific IDs that carry a \`[1m]\` context-window suffix or otherwise fail subagent-safe validation (sub-agents cannot inherit \`[1m]\`). Valid provider-specific IDs without extended-context suffixes are allowed.

When the session model carries a \`[1m]\` suffix, passing an explicit \`model\` is REQUIRED — omitting it will be denied (sub-agents cannot inherit the \`[1m]\` suffix). Use a tier alias (requires resolver env vars above); the Agent tool schema does not accept provider-specific IDs, so tier aliases are the only valid option.

When the session model has no \`[1m]\` suffix, omitting \`model\` is safe UNLESS a custom sub-agent definition pins a bare Anthropic model ID (e.g. \`model: claude-sonnet-4-6\` in agent frontmatter). When resolver env vars are configured, the enforcer will deny that call with tier-alias guidance; when they are absent, the call is not denied by the enforcer but will fail at the provider. Either way, custom sub-agents should pin tier aliases (not bare Anthropic IDs) in their frontmatter. Shipped OMC agents already do this and are unaffected.

The CLAUDE.md instruction "Pass model on Task calls: haiku, sonnet, opus" applies here — subject to the resolution prerequisites above.

</system-reminder>`;
