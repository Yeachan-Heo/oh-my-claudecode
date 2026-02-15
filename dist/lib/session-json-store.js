/**
 * Session JSON Store
 *
 * Generic session-scoped JSON persistence.
 * Eliminates duplicated load/save/clear patterns across hook storage modules.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
export class SessionJsonStore {
    storageDir;
    constructor(options) {
        this.storageDir = options.storageDir;
    }
    getPath(sessionId) {
        return join(this.storageDir, `${sessionId}.json`);
    }
    load(sessionId) {
        const filePath = this.getPath(sessionId);
        if (!existsSync(filePath))
            return null;
        try {
            return JSON.parse(readFileSync(filePath, 'utf-8'));
        }
        catch {
            return null;
        }
    }
    save(sessionId, data) {
        if (!existsSync(this.storageDir)) {
            mkdirSync(this.storageDir, { recursive: true });
        }
        writeFileSync(this.getPath(sessionId), JSON.stringify(data, null, 2));
    }
    clear(sessionId) {
        const filePath = this.getPath(sessionId);
        if (existsSync(filePath))
            unlinkSync(filePath);
    }
}
//# sourceMappingURL=session-json-store.js.map