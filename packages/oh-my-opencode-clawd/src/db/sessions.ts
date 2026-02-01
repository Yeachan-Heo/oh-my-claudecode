import { randomUUID } from 'node:crypto';
import { getDatabase } from './index.js';
import type { Session } from '../types.js';

interface SessionRow {
  id: string;
  name: string;
  tmux_session: string;
  tmux_window: number;
  claude_session_id: string | null;
  working_directory: string;
  status: string;
  created_by: string;
  created_at: string;
  last_active_at: string;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  metadata: string | null;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    tmuxSession: row.tmux_session,
    tmuxWindow: row.tmux_window,
    claudeSessionId: row.claude_session_id ?? undefined,
    workingDirectory: row.working_directory,
    status: row.status as Session['status'],
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    lastActiveAt: new Date(row.last_active_at),
    totalCostUsd: row.total_cost_usd,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

export class SessionRepository {
  create(data: {
    name: string;
    tmuxSession: string;
    workingDirectory: string;
    createdBy: string;
  }): Session {
    const db = getDatabase();
    const id = randomUUID();

    db.prepare(`
      INSERT INTO sessions (id, name, tmux_session, working_directory, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, data.name, data.tmuxSession, data.workingDirectory, data.createdBy);

    return this.findById(id)!;
  }

  findById(id: string): Session | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  findByName(name: string): Session | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM sessions WHERE name = ? AND status != ?').get(name, 'terminated') as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  findActive(): Session[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM sessions WHERE status = ? ORDER BY last_active_at DESC').all('active') as SessionRow[];
    return rows.map(rowToSession);
  }

  findByUser(userId: string): Session[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM sessions WHERE created_by = ? ORDER BY last_active_at DESC').all(userId) as SessionRow[];
    return rows.map(rowToSession);
  }

  updateStatus(id: string, status: Session['status']): void {
    const db = getDatabase();
    db.prepare('UPDATE sessions SET status = ?, last_active_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
  }

  updateClaudeSessionId(id: string, claudeSessionId: string): void {
    const db = getDatabase();
    db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run(claudeSessionId, id);
  }

  updateCost(id: string, inputTokens: number, outputTokens: number, costUsd: number): void {
    const db = getDatabase();
    db.prepare(`
      UPDATE sessions SET
        total_input_tokens = total_input_tokens + ?,
        total_output_tokens = total_output_tokens + ?,
        total_cost_usd = total_cost_usd + ?,
        last_active_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(inputTokens, outputTokens, costUsd, id);
  }

  delete(id: string): void {
    const db = getDatabase();
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  countActive(): number {
    const db = getDatabase();
    const row = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE status = ?').get('active') as { count: number };
    return row.count;
  }
}
