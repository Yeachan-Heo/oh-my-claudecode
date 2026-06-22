/**
 * Provider backend overrides for `omc ask` / `run-provider-advisor`.
 *
 * Lets a site repoint a single `ask` provider axis at a drop-in CLI through
 * environment variables, without editing the hardcoded provider table.
 *
 * Motivating case: Google moved `@google/gemini-cli` access behind Antigravity,
 * so accounts on the new tier get `IneligibleTier` from the `gemini` binary —
 * which silently breaks the Gemini axis used by `omc ask gemini` and the `/ccg`
 * tri-model orchestration. With these overrides the Gemini axis can be routed
 * through Antigravity's `agy` CLI instead:
 *
 *   OMC_ASK_GEMINI_BIN=agy
 *   OMC_ASK_GEMINI_ARGS=["--print","{{prompt}}","--dangerously-skip-permissions"]
 *
 * Both overrides are opt-in and per-provider. When unset, default behavior is
 * unchanged (full backward compatibility).
 */

export const PROMPT_PLACEHOLDER = '{{prompt}}';

function envKey(provider, suffix) {
  return `OMC_ASK_${provider.toUpperCase()}_${suffix}`;
}

/**
 * Resolve the binary for a provider, honoring an `OMC_ASK_<PROVIDER>_BIN`
 * override. Falls back to `defaultBinary` when the override is unset or blank.
 *
 * @param {string} provider - canonical provider name (e.g. `gemini`).
 * @param {string} defaultBinary - the built-in binary for this provider.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {string} the binary to spawn.
 */
export function resolveProviderBinary(provider, defaultBinary, env = process.env) {
  const override = env[envKey(provider, 'BIN')];
  if (typeof override === 'string' && override.trim()) {
    return override.trim();
  }
  return defaultBinary;
}

/**
 * Resolve an `OMC_ASK_<PROVIDER>_ARGS` override.
 *
 * The value is a JSON array of strings. Every occurrence of the literal
 * `{{prompt}}` token (see {@link PROMPT_PLACEHOLDER}) is replaced with `prompt`.
 * When no token is present, the caller should pipe the prompt over stdin
 * instead (mirroring how `claude -p` reads the prompt from stdin).
 *
 * @param {string} provider - canonical provider name.
 * @param {string} prompt - the prompt to substitute / pipe.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {{ args: string[], usesPromptPlaceholder: boolean } | null}
 *   resolved args, or `null` when the override is unset (use default args).
 * @throws {Error} when the value is not a JSON array of strings.
 */
export function resolveProviderArgsOverride(provider, prompt, env = process.env) {
  const key = envKey(provider, 'ARGS');
  const raw = env[key];
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${key} must be a JSON array of strings, e.g. ["--print","{{prompt}}"]. JSON parse failed: ${detail}`);
  }

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${key} must be a JSON array of strings, e.g. ["--print","{{prompt}}"].`);
  }

  const usesPromptPlaceholder = parsed.some((item) => item.includes(PROMPT_PLACEHOLDER));
  const args = parsed.map((item) => item.split(PROMPT_PLACEHOLDER).join(prompt));
  return { args, usesPromptPlaceholder };
}
