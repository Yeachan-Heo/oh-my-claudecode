/**
 * Tests for findNodeHeaders function (fix for #5111).
 * 
 * Ensures the function correctly prioritizes node header candidates:
 * 1. --headers= flag
 * 2. npm_config_nodedir
 * 3. Running node's own headers (new candidate)
 * 4. node-gyp cache
 * 5. System paths
 */

import { describe, it, expect } from 'vitest';
import { findNodeHeaders } from '../../scripts/lib/find-node-headers.mjs';

describe('findNodeHeaders (#5111)', () => {
  // Helper to create a mock exists function that tracks which paths are checked
  function createMockExists(filesMap: Record<string, boolean>) {
    return (path: string) => {
      return filesMap[path] ?? false;
    };
  }

  describe('scenario (a): running node headers with execPath', () => {
    it('returns the running node prefix include dir when available', () => {
      const tmpPrefix = '/tmp/node-prefix';
      const result = findNodeHeaders({
        argv: [],
        env: {},
        execPath: `${tmpPrefix}/bin/node`,
        version: '26.13.1',
        homedir: '/home/user',
        exists: createMockExists({
          [`${tmpPrefix}/include/node/node_api.h`]: true,
        }),
      });
      expect(result).toBe(`${tmpPrefix}/include/node`);
    });
  });

  describe('scenario (b): running node headers beat /usr/include/node', () => {
    it('prioritizes running node headers over system paths', () => {
      const tmpPrefix = '/tmp/node-prefix';
      const result = findNodeHeaders({
        argv: [],
        env: {},
        execPath: `${tmpPrefix}/bin/node`,
        version: '26.13.1',
        homedir: '/home/user',
        exists: createMockExists({
          [`${tmpPrefix}/include/node/node_api.h`]: true,
          '/usr/include/node/node_api.h': true,
        }),
      });
      // Should return the running node's headers, not the system path
      expect(result).toBe(`${tmpPrefix}/include/node`);
    });
  });

  describe('scenario (c): --headers and npm_config_nodedir still win', () => {
    it('--headers flag takes highest priority', () => {
      const tmpPrefix = '/tmp/node-prefix';
      const explicitHeaders = '/custom/headers';
      const result = findNodeHeaders({
        argv: [`--headers=${explicitHeaders}`],
        env: {},
        execPath: `${tmpPrefix}/bin/node`,
        version: '26.13.1',
        homedir: '/home/user',
        exists: createMockExists({
          [`${explicitHeaders}/node_api.h`]: true,
          [`${tmpPrefix}/include/node/node_api.h`]: true,
        }),
      });
      expect(result).toBe(explicitHeaders);
    });

    it('npm_config_nodedir (include/node) takes priority over running node', () => {
      const tmpPrefix = '/tmp/node-prefix';
      const nodedirPath = '/opt/node-custom';
      const result = findNodeHeaders({
        argv: [],
        env: { npm_config_nodedir: nodedirPath },
        execPath: `${tmpPrefix}/bin/node`,
        version: '26.13.1',
        homedir: '/home/user',
        exists: createMockExists({
          [`${nodedirPath}/include/node/node_api.h`]: true,
          [`${tmpPrefix}/include/node/node_api.h`]: true,
        }),
      });
      expect(result).toBe(`${nodedirPath}/include/node`);
    });

    it('npm_config_nodedir (src) takes priority over running node', () => {
      const tmpPrefix = '/tmp/node-prefix';
      const nodedirPath = '/opt/node-custom';
      const result = findNodeHeaders({
        argv: [],
        env: { npm_config_nodedir: nodedirPath },
        execPath: `${tmpPrefix}/bin/node`,
        version: '26.13.1',
        homedir: '/home/user',
        exists: createMockExists({
          [`${nodedirPath}/src/node_api.h`]: true,
          [`${tmpPrefix}/include/node/node_api.h`]: true,
        }),
      });
      expect(result).toBe(`${nodedirPath}/src`);
    });
  });

  describe('scenario (d): returns undefined when no candidate found', () => {
    it('returns undefined when no headers exist', () => {
      const tmpPrefix = '/tmp/node-prefix';
      const result = findNodeHeaders({
        argv: [],
        env: {},
        execPath: `${tmpPrefix}/bin/node`,
        version: '26.13.1',
        homedir: '/home/user',
        exists: createMockExists({}),
      });
      expect(result).toBeUndefined();
    });
  });

  describe('mutation proof: new candidate placement', () => {
    it('fails if running node candidate is removed (mutation: remove new candidate)', () => {
      // This is a documentation of the test that should fail if we revert the fix
      // The test demonstrates that the new candidate (running node headers) is essential
      const tmpPrefix = '/tmp/node-prefix';
      
      // Without the new candidate, this would not be found
      // But with it, it is found before system paths
      const result = findNodeHeaders({
        argv: [],
        env: {},
        execPath: `${tmpPrefix}/bin/node`,
        version: '26.13.1',
        homedir: '/home/user',
        exists: createMockExists({
          [`${tmpPrefix}/include/node/node_api.h`]: true,
        }),
      });
      
      expect(result).toBe(`${tmpPrefix}/include/node`);
    });

    it('fails if running node candidate is moved after /usr paths (mutation: move candidate after /usr)', () => {
      // This demonstrates that position matters - running node should be before system paths
      const tmpPrefix = '/tmp/node-prefix';
      
      // With proper ordering, running node wins over system
      const result = findNodeHeaders({
        argv: [],
        env: {},
        execPath: `${tmpPrefix}/bin/node`,
        version: '26.13.1',
        homedir: '/home/user',
        exists: createMockExists({
          [`${tmpPrefix}/include/node/node_api.h`]: true,
          '/usr/include/node/node_api.h': true,
          '/usr/local/include/node/node_api.h': true,
        }),
      });
      
      // Should prefer running node, not system path
      expect(result).toBe(`${tmpPrefix}/include/node`);
    });
  });

  describe('node-gyp cache precedence', () => {
    it('uses darwin node-gyp cache when found', () => {
      const tmpPrefix = '/tmp/node-prefix';
      const homedir = '/Users/test';
      const version = '26.13.1';
      const result = findNodeHeaders({
        argv: [],
        env: {},
        execPath: `${tmpPrefix}/bin/node`,
        version,
        homedir,
        exists: createMockExists({
          [`${homedir}/Library/Caches/node-gyp/${version}/include/node/node_api.h`]: true,
        }),
      });
      expect(result).toBe(`${homedir}/Library/Caches/node-gyp/${version}/include/node`);
    });

    it('uses linux node-gyp cache when found', () => {
      const tmpPrefix = '/tmp/node-prefix';
      const homedir = '/home/test';
      const version = '26.13.1';
      const result = findNodeHeaders({
        argv: [],
        env: {},
        execPath: `${tmpPrefix}/bin/node`,
        version,
        homedir,
        exists: createMockExists({
          [`${homedir}/.cache/node-gyp/${version}/include/node/node_api.h`]: true,
        }),
      });
      expect(result).toBe(`${homedir}/.cache/node-gyp/${version}/include/node`);
    });
  });

  describe('system paths fallback', () => {
    it('uses /usr/local/include/node as fallback', () => {
      const tmpPrefix = '/tmp/node-prefix';
      const result = findNodeHeaders({
        argv: [],
        env: {},
        execPath: `${tmpPrefix}/bin/node`,
        version: '26.13.1',
        homedir: '/home/user',
        exists: createMockExists({
          '/usr/local/include/node/node_api.h': true,
        }),
      });
      expect(result).toBe('/usr/local/include/node');
    });

    it('uses /usr/include/node as final fallback', () => {
      const tmpPrefix = '/tmp/node-prefix';
      const result = findNodeHeaders({
        argv: [],
        env: {},
        execPath: `${tmpPrefix}/bin/node`,
        version: '26.13.1',
        homedir: '/home/user',
        exists: createMockExists({
          '/usr/include/node/node_api.h': true,
        }),
      });
      expect(result).toBe('/usr/include/node');
    });
  });

  describe('--headers flag parsing', () => {
    it('extracts --headers= flag value correctly', () => {
      const customHeaders = '/my/custom/headers';
      const result = findNodeHeaders({
        argv: ['node', 'build.mjs', `--headers=${customHeaders}`],
        env: {},
        execPath: '/usr/bin/node',
        version: '26.13.1',
        homedir: '/home/user',
        exists: createMockExists({
          [`${customHeaders}/node_api.h`]: true,
        }),
      });
      expect(result).toBe(customHeaders);
    });
  });

  describe('npm_config_nodedir subdirectories', () => {
    it('checks both include/node and src subdirectories', () => {
      const tmpPrefix = '/tmp/node-prefix';
      const nodedirPath = '/opt/nodeconfig';
      
      // If only src has the header, use that
      const result = findNodeHeaders({
        argv: [],
        env: { npm_config_nodedir: nodedirPath },
        execPath: `${tmpPrefix}/bin/node`,
        version: '26.13.1',
        homedir: '/home/user',
        exists: createMockExists({
          [`${nodedirPath}/src/node_api.h`]: true,
        }),
      });
      expect(result).toBe(`${nodedirPath}/src`);
    });

    it('prefers include/node over src when both exist', () => {
      const tmpPrefix = '/tmp/node-prefix';
      const nodedirPath = '/opt/nodeconfig';
      
      // If both exist, include/node should be checked first
      const result = findNodeHeaders({
        argv: [],
        env: { npm_config_nodedir: nodedirPath },
        execPath: `${tmpPrefix}/bin/node`,
        version: '26.13.1',
        homedir: '/home/user',
        exists: createMockExists({
          [`${nodedirPath}/include/node/node_api.h`]: true,
          [`${nodedirPath}/src/node_api.h`]: true,
        }),
      });
      expect(result).toBe(`${nodedirPath}/include/node`);
    });
  });
});
