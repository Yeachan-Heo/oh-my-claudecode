import { dirname, join } from 'node:path';

/**
 * Pure function to find Node development headers.
 * 
 * This is extracted into a separate module for testability (can be tested without compilation).
 * 
 * @param {Object} options
 * @param {string[]} options.argv - process.argv
 * @param {Record<string, string>} options.env - process.env
 * @param {string} options.execPath - process.execPath
 * @param {string} options.version - process.versions.node
 * @param {string} options.homedir - homedir() result
 * @param {Function} options.exists - function that checks if a file exists: (path: string) => boolean
 * @returns {string|undefined} - path to include/node directory, or undefined if not found
 */
export function findNodeHeaders({ argv, env, execPath, version, homedir, exists }) {
  
  // Extract --headers= flag if present
  const explicit = argv.find(arg => arg.startsWith('--headers='))?.slice('--headers='.length);
  
  // Build candidate list in priority order:
  // 1. Explicit --headers= flag
  // 2. npm_config_nodedir (include/node and src subdirectories)
  // 3. Running node's own headers (new in fix for #5111)
  // 4. node-gyp cache for the exact version
  // 5. System paths
  const candidates = [
    explicit,
    env.npm_config_nodedir && join(env.npm_config_nodedir, 'include', 'node'),
    env.npm_config_nodedir && join(env.npm_config_nodedir, 'src'),
    join(dirname(execPath), '..', 'include', 'node'),
    join(homedir, 'Library', 'Caches', 'node-gyp', version, 'include', 'node'),
    join(homedir, '.cache', 'node-gyp', version, 'include', 'node'),
    '/usr/local/include/node',
    '/usr/include/node',
  ].filter(Boolean);

  // Find the first candidate that has node_api.h
  for (const candidate of candidates) {
    if (exists(join(candidate, 'node_api.h'))) {
      return candidate;
    }
  }

  return undefined;
}
