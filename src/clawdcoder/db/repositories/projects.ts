import { randomUUID } from 'node:crypto';
import { getDatabase } from '../index.js';
import type { Project } from '../../types.js';

interface ProjectRow {
  id: string;
  name: string;
  directory: string;
  git_repo: string | null;
  default_branch: string;
  created_by: string;
  created_at: string;
  settings: string | null;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    directory: row.directory,
    gitRepo: row.git_repo ?? undefined,
    defaultBranch: row.default_branch,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    settings: row.settings ? JSON.parse(row.settings) : undefined,
  };
}

export class ProjectRepository {
  create(data: {
    name: string;
    directory: string;
    createdBy: string;
    gitRepo?: string;
    defaultBranch?: string;
  }): Project {
    const db = getDatabase();
    const id = randomUUID();

    db.prepare(`
      INSERT INTO projects (id, name, directory, created_by, git_repo, default_branch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data.name, data.directory, data.createdBy, data.gitRepo ?? null, data.defaultBranch ?? 'main');

    return this.findById(id)!;
  }

  findById(id: string): Project | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? rowToProject(row) : null;
  }

  findByName(name: string): Project | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as ProjectRow | undefined;
    return row ? rowToProject(row) : null;
  }

  all(): Project[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM projects ORDER BY name').all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  delete(id: string): void {
    const db = getDatabase();
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}
