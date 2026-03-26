#!/usr/bin/env node
/**
 * Session Summary Generator
 *
 * Standalone script that generates a brief (<20 char) summary of the current
 * Claude Code session using `claude -p`.
 *
 * Usage:
 *   node session-summary.mjs <transcript_path> <state_dir> <session_id> [--verbose]
 *
 * The script:
 * 1. Counts user message turns from the transcript JSONL
 * 2. Checks cached summary in <state_dir>/session-summary.json
 * 3. If turns >= 10 and (no cache or turns - lastTurnCount >= 10), generates
 *    a new summary via `claude -p`
 * 4. Writes the result to the state file
 *
 * Exit codes:
 *   0 - success (summary generated or cache is fresh)
 *   1 - error
 *   2 - not enough turns yet
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, createReadStream } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createInterface } from 'readline';

const TURN_THRESHOLD = 10;
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

function log(...args) {
  if (verbose) {
    console.error('[session-summary]', ...args);
  }
}

/**
 * Count user message turns from a transcript JSONL file.
 * A "turn" is a message with role === 'user'.
 */
async function countUserTurns(transcriptPath) {
  if (!existsSync(transcriptPath)) {
    return 0;
  }

  let turns = 0;
  const stream = createReadStream(transcriptPath);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.message?.role === 'user' || entry.type === 'human') {
        turns++;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return turns;
}

/**
 * Extract recent conversation context for summarization.
 * Returns the last N user messages as context.
 */
async function extractConversationContext(transcriptPath, maxMessages = 20) {
  if (!existsSync(transcriptPath)) {
    return '';
  }

  const messages = [];
  const stream = createReadStream(transcriptPath);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const role = entry.message?.role ?? (entry.type === 'human' ? 'user' : null);
      if (!role) continue;

      const content = entry.message?.content;
      if (!content) continue;

      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text)
          .join(' ');
      }

      if (text.trim()) {
        messages.push({ role, text: text.slice(0, 200) });
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Take last N messages for context
  const recent = messages.slice(-maxMessages);
  return recent.map(m => `${m.role}: ${m.text}`).join('\n');
}

/**
 * Read cached summary state (scoped by sessionId).
 */
function readSummaryState(stateDir, sessionId) {
  const statePath = join(stateDir, `session-summary-${sessionId}.json`);
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write summary state to disk (scoped by sessionId).
 */
function writeSummaryState(stateDir, sessionId, state) {
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, `session-summary-${sessionId}.json`);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Generate summary using `claude -p`.
 */
function generateSummary(conversationContext) {
  const prompt = `You are a session labeler. Given the conversation below, produce a SHORT label (under 20 characters, in the same language as the conversation) that summarizes what the user is working on. Output ONLY the label text, nothing else. No quotes, no explanation.

Examples of good labels:
- "auth bug fix"
- "API 테스트 추가"
- "리팩토링 utils"
- "deploy pipeline"
- "DB migration"

Conversation:
${conversationContext}

Label:`;

  try {
    const result = execFileSync('claude', ['-p', prompt], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'session-summary' },
    });
    const summary = result.trim().slice(0, 19); // Enforce <20 chars
    return summary || null;
  } catch (error) {
    log('claude -p failed:', error.message);
    return null;
  }
}

async function main() {
  const transcriptPath = process.argv[2];
  const stateDir = process.argv[3];
  const sessionId = process.argv[4];

  if (!transcriptPath || !stateDir || !sessionId) {
    console.error('Usage: session-summary.mjs <transcript_path> <state_dir> <session_id> [--verbose]');
    process.exit(1);
  }

  // Validate sessionId to prevent path traversal
  const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    console.error('[session-summary] invalid sessionId');
    process.exit(1);
  }

  log('transcript:', transcriptPath);
  log('stateDir:', stateDir);
  log('sessionId:', sessionId);

  // 1. Count user turns
  const turnCount = await countUserTurns(transcriptPath);
  log('user turns:', turnCount);

  if (turnCount < TURN_THRESHOLD) {
    log('not enough turns yet');
    process.exit(2);
  }

  // 2. Check cached state (scoped by sessionId)
  const cached = readSummaryState(stateDir, sessionId);
  log('cached state:', cached);

  if (cached?.summary && cached?.turnCount != null) {
    const turnsSinceLastGeneration = turnCount - cached.turnCount;
    if (turnsSinceLastGeneration < TURN_THRESHOLD) {
      log('cache is fresh, skipping generation');
      process.exit(0);
    }
  }

  // 3. Extract conversation context
  const context = await extractConversationContext(transcriptPath);
  if (!context) {
    log('no conversation context found');
    process.exit(1);
  }

  // 4. Generate summary via claude -p
  log('generating summary...');
  const summary = generateSummary(context);

  if (!summary) {
    log('failed to generate summary');
    process.exit(1);
  }

  log('generated summary:', summary);

  // 5. Write state (scoped by sessionId)
  writeSummaryState(stateDir, sessionId, {
    summary,
    turnCount,
    generatedAt: new Date().toISOString(),
  });

  log('done');
  process.exit(0);
}

main().catch(error => {
  console.error('[session-summary] fatal error:', error.message);
  process.exit(1);
});
