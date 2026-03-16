import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

export interface LLMCallOptions {
  model: 'claude-sonnet-4-6-20250715' | 'claude-sonnet-4-20250514' | 'claude-opus-4-20250514';
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const client = new Anthropic();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callLLM(options: LLMCallOptions): Promise<string> {
  const { model, systemPrompt, userMessage, maxTokens = 4096, temperature = 0 } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('LLM response contains no text block');
      }
      return textBlock.text;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        console.warn(`[llm] attempt ${attempt} failed, retrying in ${RETRY_DELAY_MS}ms...`);
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw new Error(`LLM call failed after ${MAX_RETRIES} attempts: ${lastError}`);
}

export function parseJSON<T>(raw: string): T {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }
  return JSON.parse(cleaned) as T;
}

export function loadAgentPrompt(agentName: string): string {
  const promptPath = path.resolve(__dirname, '..', 'agents', `${agentName}.md`);
  return fs.readFileSync(promptPath, 'utf-8');
}
