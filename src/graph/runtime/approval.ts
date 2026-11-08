/**
 * Human approval gate (graph runtime v2).
 *
 * Bridges the frozen HumanApprovalPrompter contract to a stdin/stdout y/n
 * prompt. Fail-closed by construction: stream EOF/closure, unrecognized
 * input after the single re-prompt, or any non-yes/no answer resolves to
 * "denied" (AC-14 / AC-14b: denied is a first-class recorded outcome).
 */

import { createInterface } from "readline";
import type { Interface as ReadlineInterface } from "readline";

import type { GraphApprovalDecision } from "../types.js";
import type { ApprovalRequest, HumanApprovalPrompter } from "./types.js";

type Decision = GraphApprovalDecision["decision"];

/** Maps one raw input line to a decision, or null when unrecognized. */
function parseAnswer(raw: string): Decision | null {
  const answer = raw.trim().toLowerCase();
  if (answer === "y" || answer === "yes") {
    return "approved";
  }
  if (answer === "n" || answer === "no") {
    return "denied";
  }
  return null;
}

/**
 * A prompter that always returns the given decision without touching any
 * stream. Used by runner unit tests and non-interactive invocations.
 */
export function createFixedApprovalGate(decision: Decision): HumanApprovalPrompter {
  return {
    async prompt(): Promise<Decision> {
      return decision;
    },
  };
}

/**
 * Interactive y/n gate over an injectable readable stream (default
 * process.stdin). Prompts via process.stdout.write only — never console.
 */
export function createStdinApprovalGate(
  input?: NodeJS.ReadableStream,
): HumanApprovalPrompter {
  const stream = input ?? process.stdin;
  let readlineInterface: ReadlineInterface | null = null;
  let streamClosed = false;
  /** Lines that arrived before any reader asked for them. */
  const bufferedLines: string[] = [];
  /** At most one reader waits at a time (prompts are sequential). */
  let waitingReader: ((line: string | null) => void) | null = null;

  /**
   * Created lazily at first prompt so the interface attaches while the
   * stream is still live. A single permanent line listener captures every
   * arriving line — readline emits lines whether or not a reader is
   * currently attached, so per-read listeners would drop buffered lines.
   */
  function getInterface(): ReadlineInterface {
    if (readlineInterface === null) {
      readlineInterface = createInterface({ input: stream });
      readlineInterface.on("line", (line: string) => {
        if (waitingReader !== null) {
          const reader = waitingReader;
          waitingReader = null;
          reader(line);
        } else {
          bufferedLines.push(line);
        }
      });
      readlineInterface.on("close", () => {
        streamClosed = true;
        if (waitingReader !== null) {
          const reader = waitingReader;
          waitingReader = null;
          reader(null);
        }
      });
    }
    return readlineInterface;
  }

  /** Resolves with the next line, or null when the stream hit EOF/closed. */
  function readLine(): Promise<string | null> {
    if (streamClosed) {
      return Promise.resolve(null);
    }
    const queued = bufferedLines.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    getInterface();
    return new Promise((resolve) => {
      waitingReader = resolve;
    });
  }

  return {
    async prompt(request: ApprovalRequest): Promise<Decision> {
      process.stdout.write(
        `\n[approval] ${request.node_id}: ${request.prompt_text}\nApprove? [y/n] `,
      );
      let answer = await readLine();
      if (answer !== null) {
        const parsed = parseAnswer(answer);
        if (parsed !== null) {
          return parsed;
        }
        // Unrecognized answer: re-prompt once, then default to denied.
        process.stdout.write("Approve? [y/n] ");
        answer = await readLine();
      }
      const retryParsed = answer === null ? null : parseAnswer(answer);
      return retryParsed === "approved" ? "approved" : "denied";
    },
  };
}
