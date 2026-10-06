import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { buildRouteTableFull, buildRouteTableNarrow, runFactoryInit, validateFactoryPrerequisites, } from '../factory.js';
import { readProjectRoutes } from '../../../hooks/session-end/chain-enqueuer.js';
const tempRoots = [];
/** Isolated git repo: getOmcRoot resolves `.omc` inside it, like the real project. */
function tempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'omc-factory-init-'));
    tempRoots.push(dir);
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
    return dir;
}
afterEach(() => {
    for (const dir of tempRoots)
        rmSync(dir, { recursive: true, force: true });
    tempRoots.length = 0;
});
function seedPrerequisites(dir) {
    mkdirSync(join(dir, '.omc', 'state'), { recursive: true });
    mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
}
function routesPath(dir) {
    return join(dir, '.omc', 'factory-routes.json');
}
describe('buildRouteTableNarrow', () => {
    it('is exactly the listener intake route table', () => {
        expect(buildRouteTableNarrow()).toEqual({ 'success:intake': { stage: 'intent', skill: 'intent' } });
    });
});
describe('buildRouteTableFull', () => {
    it('widens the starter loop into the intent -> launch -> diagnose progression', () => {
        const table = buildRouteTableFull();
        expect(table['success:intake']).toEqual({ stage: 'intent', skill: 'intent' });
        expect(table['success:intent']).toEqual({ stage: 'launch', skill: 'launch' });
        expect(table['success:launch']).toEqual({ stage: 'diagnose', skill: 'diagnose' });
    });
});
describe('validateFactoryPrerequisites', () => {
    it('reports missing .omc/state/ and docs/design/, and passes when both exist', () => {
        const dir = tempDir();
        const missing = validateFactoryPrerequisites(dir);
        expect(missing.ok).toBe(false);
        expect(missing.missing).toContain('.omc/state/');
        expect(missing.missing).toContain('docs/design/');
        seedPrerequisites(dir);
        expect(validateFactoryPrerequisites(dir)).toEqual({ ok: true, missing: [] });
    });
});
describe('runFactoryInit', () => {
    it('writes the narrow starter table by default and it round-trips through the route reader', () => {
        const dir = tempDir();
        seedPrerequisites(dir);
        const result = runFactoryInit({ cwd: dir });
        expect(result.exitCode).toBe(0);
        expect(existsSync(routesPath(dir))).toBe(true);
        expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual(buildRouteTableNarrow());
        expect(readProjectRoutes(dir)).toEqual(buildRouteTableNarrow());
    });
    it('writes the full widening template with narrow: false', () => {
        const dir = tempDir();
        seedPrerequisites(dir);
        const result = runFactoryInit({ cwd: dir, narrow: false });
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual(buildRouteTableFull());
    });
    it('refuses to overwrite an existing table (content untouched) and --force replaces it', () => {
        const dir = tempDir();
        seedPrerequisites(dir);
        const existing = { 'success:*': { stage: 'mine', skill: 'mine' } };
        writeFileSync(routesPath(dir), JSON.stringify(existing), 'utf8');
        const refused = runFactoryInit({ cwd: dir });
        expect(refused.exitCode).toBe(1);
        expect(refused.message).toContain('--force');
        expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual(existing);
        const forced = runFactoryInit({ cwd: dir, force: true });
        expect(forced.exitCode).toBe(0);
        expect(JSON.parse(readFileSync(routesPath(dir), 'utf8'))).toEqual(buildRouteTableNarrow());
    });
    it('refuses and writes nothing when prerequisites are missing', () => {
        const dir = tempDir();
        const result = runFactoryInit({ cwd: dir });
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain('.omc/state/');
        expect(existsSync(routesPath(dir))).toBe(false);
    });
});
//# sourceMappingURL=factory-init.test.js.map