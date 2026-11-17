/**
 * Directory Mapper
 * Detects and maps project directory structure and purposes
 */
import fs from 'fs/promises';
import path from 'path';
/**
 * Common directory purposes based on naming patterns
 */
const DIRECTORY_PURPOSES = {
    'src': 'Source code',
    'lib': 'Library code',
    'app': 'Application code',
    'components': 'UI components',
    'pages': 'Page components',
    'api': 'API routes',
    'routes': 'Route handlers',
    'controllers': 'Controllers',
    'models': 'Data models',
    'views': 'View templates',
    'services': 'Business logic services',
    'utils': 'Utility functions',
    'helpers': 'Helper functions',
    'middleware': 'Middleware',
    'config': 'Configuration files',
    'data': 'Data files',
    'assets': 'Static assets',
    'public': 'Public files',
    'static': 'Static files',
    'tests': 'Test files',
    'test': 'Test files',
    '__tests__': 'Test files',
    'spec': 'Test specifications',
    'docs': 'Documentation',
    'examples': 'Example code',
    'scripts': 'Build/utility scripts',
    'bin': 'Executable scripts',
    'dist': 'Distribution/build output',
    'build': 'Build output',
    'out': 'Build output',
    'node_modules': 'Dependencies',
    'vendor': 'Third-party code',
    'types': 'Type definitions',
    'typings': 'Type definitions',
    'schemas': 'Schema definitions',
    'migrations': 'Database migrations',
    'seeds': 'Database seeds',
    'fixtures': 'Test fixtures',
    'mocks': 'Mock data',
    'stubs': 'Stub implementations',
};
/**
 * Detect directory structure and purposes
 */
export async function mapDirectoryStructure(projectRoot) {
    const directoryMap = {};
    try {
        const entries = await fs.readdir(projectRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            // Skip hidden directories and common ignores
            if (entry.name.startsWith('.') || entry.name === 'node_modules')
                continue;
            const dirPath = path.join(projectRoot, entry.name);
            const relPath = entry.name;
            // Detect purpose
            const purpose = DIRECTORY_PURPOSES[entry.name.toLowerCase()] || null;
            // Count files
            const fileCount = await countFiles(dirPath);
            // Get key files (up to 5)
            const keyFiles = await getKeyFiles(dirPath, 5);
            directoryMap[relPath] = {
                path: relPath,
                purpose,
                fileCount,
                lastAccessed: Date.now(),
                keyFiles,
            };
        }
        // Also scan one level deeper for important patterns
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (entry.name.startsWith('.') || entry.name === 'node_modules')
                continue;
            const dirPath = path.join(projectRoot, entry.name);
            try {
                const subEntries = await fs.readdir(dirPath, { withFileTypes: true });
                for (const subEntry of subEntries.slice(0, 10)) {
                    if (!subEntry.isDirectory())
                        continue;
                    const subDirPath = path.join(dirPath, subEntry.name);
                    const relPath = path.join(entry.name, subEntry.name);
                    const purpose = DIRECTORY_PURPOSES[subEntry.name.toLowerCase()] || null;
                    if (purpose) {
                        const fileCount = await countFiles(subDirPath);
                        const keyFiles = await getKeyFiles(subDirPath, 3);
                        directoryMap[relPath] = {
                            path: relPath,
                            purpose,
                            fileCount,
                            lastAccessed: Date.now(),
                            keyFiles,
                        };
                    }
                }
            }
            catch {
                // Skip unreadable directories
            }
        }
    }
    catch (_error) {
        // Return empty map on error
    }
    return directoryMap;
}
/**
 * Count files in a directory (non-recursive)
 */
async function countFiles(dirPath) {
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        return entries.filter(e => e.isFile()).length;
    }
    catch {
        return 0;
    }
}
/**
 * Get key files from a directory
 */
async function getKeyFiles(dirPath, limit) {
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const files = entries
            .filter(e => e.isFile())
            .map(e => e.name)
            .filter(name => !name.startsWith('.'))
            .slice(0, limit);
        return files;
    }
    catch {
        return [];
    }
}
/**
 * Update directory last accessed time
 */
export function updateDirectoryAccess(directoryMap, dirPath) {
    if (directoryMap[dirPath]) {
        directoryMap[dirPath].lastAccessed = Date.now();
    }
}
//# sourceMappingURL=directory-mapper.js.map