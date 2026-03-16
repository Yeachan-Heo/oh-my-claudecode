/**
 * @file Structured pipeline logger.
 * Appends JSON-line entries to data/pipeline.log.
 */

import fs from 'fs';
import path from 'path';

const LOG_FILE = path.resolve('data', 'pipeline.log');

/**
 * Appends a structured log entry to data/pipeline.log.
 * Format: {"timestamp":"ISO","step":"...","data":{...}}
 * Never throws — errors are silently ignored so the pipeline keeps running.
 */
export function pipelineLog(step: string, data: Record<string, unknown>): void {
  try {
    const entry = JSON.stringify({ timestamp: new Date().toISOString(), step, data });
    fs.appendFileSync(LOG_FILE, entry + '\n', 'utf-8');
  } catch {
    // non-fatal: log file write failure must not affect the pipeline
  }
}
