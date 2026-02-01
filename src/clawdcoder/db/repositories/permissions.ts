import { getDatabase } from '../index.js';
import type { Permission } from '../../types.js';

interface PermissionRow {
  id: number;
  user_id: string;
  project_id: string;
  level: string;
  granted_by: string;
  granted_at: string;
}

function rowToPermission(row: PermissionRow): Permission {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    level: row.level as Permission['level'],
    grantedBy: row.granted_by,
    grantedAt: new Date(row.granted_at),
  };
}

export class PermissionRepository {
  grant(data: {
    userId: string;
    projectId: string;
    level: Permission['level'];
    grantedBy: string;
  }): Permission {
    const db = getDatabase();

    db.prepare(`
      INSERT OR REPLACE INTO permissions (user_id, project_id, level, granted_by)
      VALUES (?, ?, ?, ?)
    `).run(data.userId, data.projectId, data.level, data.grantedBy);

    const row = db.prepare('SELECT * FROM permissions WHERE user_id = ? AND project_id = ?').get(data.userId, data.projectId) as PermissionRow;
    return rowToPermission(row);
  }

  revoke(userId: string, projectId: string): void {
    const db = getDatabase();
    db.prepare('DELETE FROM permissions WHERE user_id = ? AND project_id = ?').run(userId, projectId);
  }

  findByUser(userId: string): Permission[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM permissions WHERE user_id = ?').all(userId) as PermissionRow[];
    return rows.map(rowToPermission);
  }

  findByProject(projectId: string): Permission[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM permissions WHERE project_id = ?').all(projectId) as PermissionRow[];
    return rows.map(rowToPermission);
  }

  check(userId: string, projectId: string): Permission['level'] | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM permissions WHERE user_id = ? AND project_id = ?').get(userId, projectId) as PermissionRow | undefined;
    return row ? row.level as Permission['level'] : null;
  }

  hasAccess(userId: string, projectId: string, requiredLevel: Permission['level']): boolean {
    const level = this.check(userId, projectId);
    if (!level) return false;

    const LEVEL_ORDER = { read: 1, write: 2, admin: 3 };
    return LEVEL_ORDER[level] >= LEVEL_ORDER[requiredLevel];
  }
}
