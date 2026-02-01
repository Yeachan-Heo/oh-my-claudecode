import { randomUUID } from 'node:crypto';
import { getDatabase } from '../index.js';
import type { User } from '../../types.js';

interface UserRow {
  id: string;
  discord_id: string | null;
  telegram_id: string | null;
  username: string;
  role: string;
  created_at: string;
  settings: string | null;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    discordId: row.discord_id ?? undefined,
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
    discordId?: string;
    telegramId?: string;
    role?: User['role'];
  }): User {
    const db = getDatabase();
    const id = randomUUID();

    db.prepare(`
      INSERT INTO users (id, username, discord_id, telegram_id, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, data.username, data.discordId ?? null, data.telegramId ?? null, data.role ?? 'user');

    return this.findById(id)!;
  }

  findById(id: string): User | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  findByDiscordId(discordId: string): User | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  findByTelegramId(telegramId: string): User | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  findOrCreate(data: {
    username: string;
    discordId?: string;
    telegramId?: string;
  }): User {
    if (data.discordId) {
      const existing = this.findByDiscordId(data.discordId);
      if (existing) return existing;
    }
    if (data.telegramId) {
      const existing = this.findByTelegramId(data.telegramId);
      if (existing) return existing;
    }

    // Check if this is the first user (make them admin)
    const db = getDatabase();
    const count = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    const role: User['role'] = count.count === 0 ? 'admin' : 'user';

    return this.create({ ...data, role });
  }

  updateRole(id: string, role: User['role']): void {
    const db = getDatabase();
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }

  linkDiscord(id: string, discordId: string): void {
    const db = getDatabase();
    db.prepare('UPDATE users SET discord_id = ? WHERE id = ?').run(discordId, id);
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
