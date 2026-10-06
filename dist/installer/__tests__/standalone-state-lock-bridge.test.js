import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provisionStandaloneStateLockBridge } from '../index.js';
const PACKAGE_ROOT = process.cwd();
const PACKAGE_IDENTITY = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const BRIDGE_IMPORT_MARKER = 'const canonical = await import(pathToFileURL(HELPER_PATH).href);';
let fixtureDir;
let generatedBridge;
function fakeFileSystemModule(root, manifestPath, helperPath, manifestRealPath = manifestPath) {
    const manifestContent = JSON.stringify(JSON.stringify(PACKAGE_IDENTITY));
    return `
const root = ${JSON.stringify(root)};
const manifestPath = ${JSON.stringify(manifestPath)};
const helperPath = ${JSON.stringify(helperPath)};
const manifestRealPath = ${JSON.stringify(manifestRealPath)};
export function lstatSync(path) {
  if (path === root) return { isDirectory: () => true, isFile: () => false };
  if (path === manifestPath || path === helperPath) return { isDirectory: () => false, isFile: () => true };
  throw new Error('Unexpected path: ' + path);
}
export function realpathSync(path) {
  if (path === root) return root;
  if (path === manifestPath) return manifestRealPath;
  if (path === helperPath) return helperPath;
  throw new Error('Unexpected path: ' + path);
}
export function readFileSync(path) {
  if (path !== manifestPath) throw new Error('Unexpected path: ' + path);
  return ${manifestContent};
}
`;
}
function validationOnlySource(source) {
    const markerIndex = source.indexOf(BRIDGE_IMPORT_MARKER);
    if (markerIndex < 0)
        throw new Error('Generated bridge does not contain its helper import');
    return `${source.slice(0, markerIndex)}export { PACKAGE_JSON, HELPER_PATH };\n`;
}
function injectRuntimeModules(source, root, fsModulePath, pathModulePath) {
    return validationOnlySource(source)
        .replace(/^const PACKAGE_ROOT = .*;$/m, `const PACKAGE_ROOT = ${JSON.stringify(root)};`)
        .replace("from 'node:fs';", `from '${pathToFileURL(fsModulePath).href}';`)
        .replace("from 'node:path';", `from '${pathToFileURL(pathModulePath).href}';`);
}
async function importBridge(source) {
    const modulePath = join(fixtureDir, `${randomUUID()}.mjs`);
    writeFileSync(modulePath, source);
    return import(pathToFileURL(modulePath).href);
}
async function createPathModule(flavor) {
    const modulePath = join(fixtureDir, `${flavor}-path.mjs`);
    writeFileSync(modulePath, `export { join, relative, resolve, isAbsolute, sep } from 'node:path/${flavor}';\n`);
    return modulePath;
}
beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'omc-state-lock-bridge-'));
    const targetPath = join(fixtureDir, 'generated-bridge.mjs');
    provisionStandaloneStateLockBridge(PACKAGE_ROOT, targetPath);
    generatedBridge = readFileSync(targetPath, 'utf8');
});
afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
});
describe('generated standalone state-lock bridge paths', () => {
    it('validates POSIX paths with the POSIX path implementation', async () => {
        const root = '/opt/omc/package';
        const manifestPath = posix.join(root, 'package.json');
        const helperPath = posix.join(root, 'scripts', 'lib', 'state-lock.mjs');
        const fsModulePath = join(fixtureDir, 'posix-fs.mjs');
        writeFileSync(fsModulePath, fakeFileSystemModule(root, manifestPath, helperPath));
        const pathModulePath = await createPathModule('posix');
        const bridge = await importBridge(injectRuntimeModules(generatedBridge, root, fsModulePath, pathModulePath));
        expect(bridge.PACKAGE_JSON).toBe(manifestPath);
        expect(bridge.HELPER_PATH).toBe(helperPath);
    });
    it('validates Windows paths with the Win32 path implementation', async () => {
        const root = 'C:\\Program Files\\omc\\package';
        const manifestPath = win32.join(root, 'package.json');
        const helperPath = win32.join(root, 'scripts', 'lib', 'state-lock.mjs');
        const fsModulePath = join(fixtureDir, 'win32-fs.mjs');
        writeFileSync(fsModulePath, fakeFileSystemModule(root, manifestPath, helperPath));
        const pathModulePath = await createPathModule('win32');
        const bridge = await importBridge(injectRuntimeModules(generatedBridge, root, fsModulePath, pathModulePath));
        expect(bridge.PACKAGE_JSON).toBe(manifestPath);
        expect(bridge.HELPER_PATH).toBe(helperPath);
        expect(bridge.PACKAGE_JSON).not.toContain('/');
        expect(bridge.HELPER_PATH).not.toContain('/');
    });
    it('rejects a manifest whose real path no longer matches its installed identity', async () => {
        const root = '/opt/omc/package';
        const manifestPath = posix.join(root, 'package.json');
        const helperPath = posix.join(root, 'scripts', 'lib', 'state-lock.mjs');
        const changedManifestPath = '/opt/replaced/package.json';
        const fsModulePath = join(fixtureDir, 'changed-fs.mjs');
        writeFileSync(fsModulePath, fakeFileSystemModule(root, manifestPath, helperPath, changedManifestPath));
        const pathModulePath = await createPathModule('posix');
        await expect(importBridge(injectRuntimeModules(generatedBridge, root, fsModulePath, pathModulePath)))
            .rejects.toThrow('OMC state-lock bridge manifest identity changed');
    });
});
//# sourceMappingURL=standalone-state-lock-bridge.test.js.map