import { describe, it, expect } from 'vitest';
import {
  selectVerificationTier,
  getVerificationAgent,
  detectArchitecturalChanges,
  detectSecurityImplications,
  buildChangeMetadata,
  type ChangeMetadata,
} from './tier-selector.js';

describe('selectVerificationTier', () => {
  it('returns LIGHT for small, well-tested changes', () => {
    const changes: ChangeMetadata = {
      filesChanged: 2,
      linesChanged: 50,
      hasArchitecturalChanges: false,
      hasSecurityImplications: false,
      testCoverage: 'full',
    };
    expect(selectVerificationTier(changes)).toBe('LIGHT');
  });

  it('returns THOROUGH for security changes regardless of size', () => {
    const changes: ChangeMetadata = {
      filesChanged: 1,
      linesChanged: 5,
      hasArchitecturalChanges: false,
      hasSecurityImplications: true,
      testCoverage: 'full',
    };
    expect(selectVerificationTier(changes)).toBe('THOROUGH');
  });

  it('returns THOROUGH for architectural changes', () => {
    const changes: ChangeMetadata = {
      filesChanged: 3,
      linesChanged: 80,
      hasArchitecturalChanges: true,
      hasSecurityImplications: false,
      testCoverage: 'partial',
    };
    expect(selectVerificationTier(changes)).toBe('THOROUGH');
  });

  it('returns STANDARD for medium changes without special flags', () => {
    const changes: ChangeMetadata = {
      filesChanged: 10,
      linesChanged: 200,
      hasArchitecturalChanges: false,
      hasSecurityImplications: false,
      testCoverage: 'partial',
    };
    expect(selectVerificationTier(changes)).toBe('STANDARD');
  });

  it('returns THOROUGH for >20 files', () => {
    const changes: ChangeMetadata = {
      filesChanged: 25,
      linesChanged: 100,
      hasArchitecturalChanges: false,
      hasSecurityImplications: false,
      testCoverage: 'full',
    };
    expect(selectVerificationTier(changes)).toBe('THOROUGH');
  });

  it('returns STANDARD when test coverage is not full', () => {
    const changes: ChangeMetadata = {
      filesChanged: 2,
      linesChanged: 50,
      hasArchitecturalChanges: false,
      hasSecurityImplications: false,
      testCoverage: 'partial',
    };
    expect(selectVerificationTier(changes)).toBe('STANDARD');
  });

  it('returns STANDARD when lines exceed 100', () => {
    const changes: ChangeMetadata = {
      filesChanged: 3,
      linesChanged: 150,
      hasArchitecturalChanges: false,
      hasSecurityImplications: false,
      testCoverage: 'full',
    };
    expect(selectVerificationTier(changes)).toBe('STANDARD');
  });
});

describe('getVerificationAgent', () => {
  it('returns architect-low for LIGHT tier', () => {
    const agent = getVerificationAgent('LIGHT');
    expect(agent.agent).toBe('architect-low');
    expect(agent.model).toBe('haiku');
  });

  it('returns architect-medium for STANDARD tier', () => {
    const agent = getVerificationAgent('STANDARD');
    expect(agent.agent).toBe('architect-medium');
    expect(agent.model).toBe('sonnet');
  });

  it('returns architect for THOROUGH tier', () => {
    const agent = getVerificationAgent('THOROUGH');
    expect(agent.agent).toBe('architect');
    expect(agent.model).toBe('opus');
  });
});

describe('detectArchitecturalChanges', () => {
  it('detects config files', () => {
    expect(detectArchitecturalChanges(['src/config.ts'])).toBe(true);
    expect(detectArchitecturalChanges(['app.config.json'])).toBe(true);
  });

  it('detects schema files', () => {
    expect(detectArchitecturalChanges(['prisma/schema.prisma'])).toBe(true);
    expect(detectArchitecturalChanges(['db/schema.sql'])).toBe(true);
  });

  it('detects definitions and types', () => {
    expect(detectArchitecturalChanges(['src/definitions.ts'])).toBe(true);
    expect(detectArchitecturalChanges(['src/types.ts'])).toBe(true);
  });

  it('detects package files', () => {
    expect(detectArchitecturalChanges(['package.json'])).toBe(true);
    expect(detectArchitecturalChanges(['tsconfig.json'])).toBe(true);
  });

  it('ignores regular source files', () => {
    expect(detectArchitecturalChanges(['src/utils/helper.ts'])).toBe(false);
    expect(detectArchitecturalChanges(['src/components/Button.tsx'])).toBe(false);
  });
});

describe('detectSecurityImplications', () => {
  it('detects auth files', () => {
    expect(detectSecurityImplications(['src/auth/login.ts'])).toBe(true);
    expect(detectSecurityImplications(['lib/auth/jwt.ts'])).toBe(true);
  });

  it('detects security-related paths', () => {
    expect(detectSecurityImplications(['src/security/encrypt.ts'])).toBe(true);
    expect(detectSecurityImplications(['src/permissions.ts'])).toBe(true);
  });

  it('detects credential and secret files', () => {
    expect(detectSecurityImplications(['credentials.json'])).toBe(true);
    expect(detectSecurityImplications(['secrets.ts'])).toBe(true);
  });

  it('detects env files', () => {
    expect(detectSecurityImplications(['.env'])).toBe(true);
    expect(detectSecurityImplications(['.env.local'])).toBe(true);
  });

  it('ignores regular source files', () => {
    expect(detectSecurityImplications(['src/utils/helper.ts'])).toBe(false);
    expect(detectSecurityImplications(['src/components/Button.tsx'])).toBe(false);
  });
});

describe('buildChangeMetadata', () => {
  it('builds metadata with auto-detection', () => {
    const files = ['src/auth/login.ts', 'src/config.ts'];
    const metadata = buildChangeMetadata(files, 100, 'full');

    expect(metadata.filesChanged).toBe(2);
    expect(metadata.linesChanged).toBe(100);
    expect(metadata.hasArchitecturalChanges).toBe(true);
    expect(metadata.hasSecurityImplications).toBe(true);
    expect(metadata.testCoverage).toBe('full');
  });

  it('defaults test coverage to partial', () => {
    const metadata = buildChangeMetadata(['src/util.ts'], 50);
    expect(metadata.testCoverage).toBe('partial');
  });
});

describe('boundary values', () => {
  it('returns STANDARD for exactly 5 files with full test coverage', () => {
    const changes: ChangeMetadata = {
      filesChanged: 5,
      linesChanged: 50,
      hasArchitecturalChanges: false,
      hasSecurityImplications: false,
      testCoverage: 'full',
    };
    // 5 files is at the boundary - should NOT qualify for LIGHT (which requires < 5)
    expect(selectVerificationTier(changes)).toBe('STANDARD');
  });

  it('returns STANDARD for exactly 100 lines with full test coverage', () => {
    const changes: ChangeMetadata = {
      filesChanged: 3,
      linesChanged: 100,
      hasArchitecturalChanges: false,
      hasSecurityImplications: false,
      testCoverage: 'full',
    };
    // 100 lines is at the boundary - should NOT qualify for LIGHT (which requires < 100)
    expect(selectVerificationTier(changes)).toBe('STANDARD');
  });

  it('returns THOROUGH for exactly 21 files', () => {
    const changes: ChangeMetadata = {
      filesChanged: 21,
      linesChanged: 100,
      hasArchitecturalChanges: false,
      hasSecurityImplications: false,
      testCoverage: 'full',
    };
    // 21 files exceeds > 20 threshold
    expect(selectVerificationTier(changes)).toBe('THOROUGH');
  });

  it('returns STANDARD for exactly 20 files', () => {
    const changes: ChangeMetadata = {
      filesChanged: 20,
      linesChanged: 100,
      hasArchitecturalChanges: false,
      hasSecurityImplications: false,
      testCoverage: 'full',
    };
    // 20 files does NOT exceed > 20 threshold
    expect(selectVerificationTier(changes)).toBe('STANDARD');
  });
});

describe('edge cases', () => {
  it('handles testCoverage: none', () => {
    const changes: ChangeMetadata = {
      filesChanged: 2,
      linesChanged: 50,
      hasArchitecturalChanges: false,
      hasSecurityImplications: false,
      testCoverage: 'none',
    };
    // No test coverage means it can't qualify for LIGHT
    expect(selectVerificationTier(changes)).toBe('STANDARD');
  });

  it('handles empty file list in buildChangeMetadata', () => {
    const metadata = buildChangeMetadata([], 0);
    expect(metadata.filesChanged).toBe(0);
    expect(metadata.linesChanged).toBe(0);
    expect(metadata.hasArchitecturalChanges).toBe(false);
    expect(metadata.hasSecurityImplications).toBe(false);
  });

  it('handles zero files and zero lines', () => {
    const changes: ChangeMetadata = {
      filesChanged: 0,
      linesChanged: 0,
      hasArchitecturalChanges: false,
      hasSecurityImplications: false,
      testCoverage: 'full',
    };
    // 0 files and 0 lines with full coverage qualifies for LIGHT
    expect(selectVerificationTier(changes)).toBe('LIGHT');
  });
});

describe('false-positive prevention', () => {
  describe('detectSecurityImplications', () => {
    it('does NOT flag tokenizer.ts as security file', () => {
      expect(detectSecurityImplications(['src/utils/tokenizer.ts'])).toBe(false);
    });

    it('does NOT flag StringTokenizer.ts as security file', () => {
      expect(detectSecurityImplications(['src/lexer/StringTokenizer.ts'])).toBe(false);
    });

    it('does NOT flag secretariat.ts as security file', () => {
      expect(detectSecurityImplications(['src/admin/secretariat.ts'])).toBe(false);
    });

    it('does NOT flag permissionless.ts as security file', () => {
      expect(detectSecurityImplications(['src/blockchain/permissionless.ts'])).toBe(false);
    });

    it('DOES flag auth/token.ts as security file', () => {
      expect(detectSecurityImplications(['src/auth/token.ts'])).toBe(true);
    });

    it('DOES flag secrets.yaml as security file', () => {
      expect(detectSecurityImplications(['config/secrets.yaml'])).toBe(true);
    });

    it('DOES flag .env.local as security file', () => {
      expect(detectSecurityImplications(['.env.local'])).toBe(true);
    });

    it('DOES flag permissions.ts as security file', () => {
      expect(detectSecurityImplications(['src/permissions.ts'])).toBe(true);
    });

    it('DOES flag oauth2.ts as security file', () => {
      expect(detectSecurityImplications(['src/auth/oauth2.ts'])).toBe(true);
    });

    it('DOES flag oauth2-client.ts as security file', () => {
      expect(detectSecurityImplications(['src/oauth2-client.ts'])).toBe(true);
    });

    it('DOES flag jwt_utils.ts as security file', () => {
      expect(detectSecurityImplications(['src/jwt_utils.ts'])).toBe(true);
    });
  });

  describe('detectArchitecturalChanges', () => {
    it('does NOT flag barrel index.ts as architectural', () => {
      expect(detectArchitecturalChanges(['src/components/index.ts'])).toBe(false);
    });

    it('does NOT flag nested barrel index.ts as architectural', () => {
      expect(detectArchitecturalChanges(['src/utils/helpers/index.ts'])).toBe(false);
    });

    it('DOES still flag config.ts as architectural', () => {
      expect(detectArchitecturalChanges(['src/config.ts'])).toBe(true);
    });

    it('DOES still flag package.json as architectural', () => {
      expect(detectArchitecturalChanges(['package.json'])).toBe(true);
    });

    it('DOES still flag tsconfig.json as architectural', () => {
      expect(detectArchitecturalChanges(['tsconfig.json'])).toBe(true);
    });
  });
});
