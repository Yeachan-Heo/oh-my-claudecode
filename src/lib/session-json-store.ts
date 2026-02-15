/**
 * Session JSON Store
 *
 * Generic session-scoped JSON persistence.
 * Eliminates duplicated load/save/clear patterns across hook storage modules.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

export interface SessionJsonStoreOptions {
  storageDir: string;
}

export class SessionJsonStore<T> {
  private readonly storageDir: string;

  constructor(options: SessionJsonStoreOptions) {
    this.storageDir = options.storageDir;
  }

  private getPath(sessionId: string): string {
    return join(this.storageDir, `${sessionId}.json`);
  }

  load(sessionId: string): T | null {
    const filePath = this.getPath(sessionId);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
    } catch {
      return null;
    }
  }

  save(sessionId: string, data: T): void {
    if (!existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
    }
    writeFileSync(this.getPath(sessionId), JSON.stringify(data, null, 2));
  }

  clear(sessionId: string): void {
    const filePath = this.getPath(sessionId);
    if (existsSync(filePath)) unlinkSync(filePath);
  }
}
