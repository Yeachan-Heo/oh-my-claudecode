
import { build } from 'esbuild';
import { builtinModules } from 'module';

build({
  entryPoints: ['src/mcp/openclaw-standalone-server.ts'],
  bundle: true,
  outfile: 'bridge/openclaw-server.cjs',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: [...builtinModules, 'better-sqlite3'], // Exclude native modules
  banner: {
    js: `
// Resolve global npm modules for native package imports
try {
  var _cp = require('child_process');
  var _Module = require('module');
  var _globalRoot = _cp.execSync('npm root -g', { encoding: 'utf8', timeout: 5000 }).trim();
  if (_globalRoot) {
    process.env.NODE_PATH = _globalRoot + (process.env.NODE_PATH ? ':' + process.env.NODE_PATH : '');
    _Module._initPaths();
  }
} catch (_e) { /* npm not available - native modules will gracefully degrade */ }
`
  }
}).catch(() => process.exit(1));
