import { randomUUID } from 'node:crypto';
import { getDatabase } from './index.js';
import type { User } from '../types.js';
import { loadConfig } from '../config.js';
import { logger } from '../utils/logger.js';

interface UserRow {
  id: string;
  telegram_id: string | null;
  username: string;
  role: string;
  created_at: string;
  settings: string | null;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    telegramId: row.telegram_id ?? undefined,
    username: row.username,
    role: row.role as User['role'],
    createdAt: new Date(row.created_at),
    settings: row.settings ? JSON.parse(row.settings) : undefined,
  };
}

export class UserRepository {
  create(data: {
    username: string;
    telegramId?: string;
    role?: User['role'];
  }): User {
    const db = getDatabase();
    const id = randomUUID();

    db.prepare(`
      INSERT INTO users (id, username, telegram_id, role)
      VALUES (?, ?, ?, ?)
    `).run(id, data.username, data.telegramId ?? null, data.role ?? 'user');

    return this.findById(id)!;
  }

  findById(id: string): User | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  findByTelegramId(telegramId: string): User | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  findOrCreate(data: {
    username: string;
    telegramId?: string;
  }): User {
    if (data.telegramId) {
      const existing = this.findByTelegramId(data.telegramId);
      if (existing) return existing;
    }

    // Determine role based on config or fallback
    let role: User['role'] = 'user';
    const config = loadConfig();

    if (config.adminTelegramIds && config.adminTelegramIds.length > 0) {
      // If allowlist is configured, only those IDs get admin
      if (data.telegramId && config.adminTelegramIds.includes(data.telegramId)) {
        role = 'admin';
      }
    }

    return this.create({ ...data, role });
  }

  updateRole(id: string, role: User['role']): void {
    const db = getDatabase();
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }

  linkTelegram(id: string, telegramId: string): void {
    const db = getDatabase();
    db.prepare('UPDATE users SET telegram_id = ? WHERE id = ?').run(telegramId, id);
  }

  all(): User[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[];
    return rows.map(rowToUser);
  }
}

export function isAdminConfigured(): boolean {
  const config = loadConfig();
  return !!(config.adminTelegramIds && config.adminTelegramIds.length > 0);
}
