import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

export interface LLMCallOptions {
  model: 'claude-sonnet-4-20250514' | 'claude-opus-4-20250514';
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

  // 1. Try code fence extraction first
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // 2. Direct parse attempt
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Continue to fallback strategies
  }

  // 3. Extract first JSON object from mixed prose+JSON
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]) as T;
    } catch {
      // Try finding the largest balanced braces
      const text = objMatch[0];
      let depth = 0;
      let start = -1;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
          if (depth === 0) start = i;
          depth++;
        } else if (text[i] === '}') {
          depth--;
          if (depth === 0 && start >= 0) {
            try {
              return JSON.parse(text.slice(start, i + 1)) as T;
            } catch {
              // continue scanning
            }
          }
        }
      }
    }
  }

  // 4. Extract first JSON array from mixed content
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]) as T;
    } catch {
      // fall through
    }
  }

  // 5. Final attempt: strip common LLM prefixes/suffixes
  const stripped = cleaned
    .replace(/^[^[{]*(?=[\[{])/, '') // strip leading prose
    .replace(/(?<=[\]}])[^}\]]*$/, ''); // strip trailing prose
  try {
    return JSON.parse(stripped) as T;
  } catch {
    // Give up with useful error
    const preview = raw.slice(0, 200).replace(/\n/g, ' ');
    throw new Error(`Failed to parse JSON from LLM response. Preview: "${preview}..."`);
  }
}

export function loadAgentPrompt(agentName: string): string {
  const promptPath = path.resolve(__dirname, '..', 'agents', `${agentName}.md`);
  return fs.readFileSync(promptPath, 'utf-8');
}
