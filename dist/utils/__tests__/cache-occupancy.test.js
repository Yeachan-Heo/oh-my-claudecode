import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { publishCacheOccupancy, readOccupiedPluginRoots } from '../cache-occupancy.js';
describe('cache occupancy registry', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omc-occupancy-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
    it('publishes an atomic, privacy-bounded record and reads the occupied root', async () => {
        const root = join(dir, 'plugins', '1.0.0');
        mkdirSync(root, { recursive: true });
        expect(await publishCacheOccupancy(root, dir)).toBe(true);
        const result = readOccupiedPluginRoots(dir);
        expect(result.unavailable).toBe(false);
        expect(result.roots).toEqual(new Set([root]));
        const files = readdirSync(join(dir, '.omc', 'cache-occupancy'));
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    });
    it('drops corrupt records without exposing their contents', () => {
        const registry = join(dir, '.omc', 'cache-occupancy');
        mkdirSync(registry, { recursive: true });
        writeFileSync(join(registry, `${'a'.repeat(64)}.json`), '{broken');
        expect(readOccupiedPluginRoots(dir).roots.size).toBe(0);
        expect(readdirSync(registry)).toEqual([]);
    });
});
//# sourceMappingURL=cache-occupancy.test.js.map