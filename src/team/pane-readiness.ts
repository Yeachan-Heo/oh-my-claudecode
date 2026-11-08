import type { CliAgentType } from './model-contract.js';

const LEGACY_IDLE_PROMPT_LINE = /^\s*(?:[│┃║▌▐▏▕╎┆┊]\s*)?[›>❯]\s*/u;
const CURSOR_IDLE_PROMPT_LINE = /^\s*(?:[│┃║▌▐▏▕╎┆┊]\s*)?[›>❯→]\s*/u;

const PROVIDER_IDLE_PROMPT_LINES: Readonly<Record<CliAgentType, RegExp>> = {
  claude: LEGACY_IDLE_PROMPT_LINE,
  codex: LEGACY_IDLE_PROMPT_LINE,
  gemini: LEGACY_IDLE_PROMPT_LINE,
  cursor: CURSOR_IDLE_PROMPT_LINE,
  grok: LEGACY_IDLE_PROMPT_LINE,
  antigravity: LEGACY_IDLE_PROMPT_LINE,
};

export function paneLineLooksLikeIdlePrompt(
  line: string,
  provider?: CliAgentType,
): boolean {
  if (provider === undefined) return LEGACY_IDLE_PROMPT_LINE.test(line);
  return PROVIDER_IDLE_PROMPT_LINES[provider].test(line);
}
