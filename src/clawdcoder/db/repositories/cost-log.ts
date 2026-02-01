import { getDatabase } from '../index.js';
import type { CostLogEntry } from '../../types.js';

interface CostLogRow {
  id: number;
  session_id: string;
  user_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  timestamp: string;
}

function rowToEntry(row: CostLogRow): CostLogEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    timestamp: new Date(row.timestamp),
  };
}

export class CostLogRepository {
  log(data: {
    sessionId: string;
    userId: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }): void {
    const db = getDatabase();

    db.prepare(`
      INSERT INTO cost_log (session_id, user_id, input_tokens, output_tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.sessionId, data.userId, data.inputTokens, data.outputTokens, data.costUsd);
  }

  findBySession(sessionId: string): CostLogEntry[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM cost_log WHERE session_id = ? ORDER BY timestamp DESC').all(sessionId) as CostLogRow[];
    return rows.map(rowToEntry);
  }

  findByUser(userId: string): CostLogEntry[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM cost_log WHERE user_id = ? ORDER BY timestamp DESC').all(userId) as CostLogRow[];
    return rows.map(rowToEntry);
  }

  getTotalBySession(sessionId: string): { inputTokens: number; outputTokens: number; costUsd: number } {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM cost_log WHERE session_id = ?
    `).get(sessionId) as { input_tokens: number; output_tokens: number; cost_usd: number };

    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costUsd: row.cost_usd,
    };
  }

  getTotalByUser(userId: string): { inputTokens: number; outputTokens: number; costUsd: number } {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM cost_log WHERE user_id = ?
    `).get(userId) as { input_tokens: number; output_tokens: number; cost_usd: number };

    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costUsd: row.cost_usd,
    };
  }
}
