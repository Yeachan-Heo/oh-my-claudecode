/**
 * Session JSON Store
 *
 * Generic session-scoped JSON persistence.
 * Eliminates duplicated load/save/clear patterns across hook storage modules.
 */
export interface SessionJsonStoreOptions {
    storageDir: string;
}
export declare class SessionJsonStore<T> {
    private readonly storageDir;
    constructor(options: SessionJsonStoreOptions);
    private getPath;
    load(sessionId: string): T | null;
    save(sessionId: string, data: T): void;
    clear(sessionId: string): void;
}
//# sourceMappingURL=session-json-store.d.ts.map