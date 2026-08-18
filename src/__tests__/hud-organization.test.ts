/**
 * OMC HUD - Organization Element Tests
 *
 * Covers resolving the Claude account organization from the local config and
 * rendering it as a statusline token.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getOrganizationName, renderOrganization } from '../hud/elements/organization.js';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/user'),
}));

vi.mock('../utils/config-dir.js', () => ({
  getClaudeConfigDir: vi.fn(() => '/home/user/.claude'),
}));

import { existsSync, readFileSync, statSync } from 'fs';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedStatSync = vi.mocked(statSync);

const PROFILE_CONFIG = '/home/user/.claude/.claude.json';
const HOME_CONFIG = '/home/user/.claude.json';

/** Strip ANSI so assertions describe content, not color. */
const plain = (value: string | null): string | null =>
  // eslint-disable-next-line no-control-regex
  value === null ? null : value.replace(/\u001b\[[0-9;]*m/g, '');

/** Serve `contents` for the given paths; every other path is "missing". */
function withConfigs(contents: Record<string, string>, size = 1024): void {
  mockedExistsSync.mockImplementation((path) => path.toString() in contents);
  mockedStatSync.mockImplementation(() => ({ size }) as ReturnType<typeof statSync>);
  mockedReadFileSync.mockImplementation((path) => {
    const found = contents[path.toString()];
    if (found === undefined) throw new Error('ENOENT');
    return found;
  });
}

const configWithOrg = (name: unknown): string =>
  JSON.stringify({
    userID: 'abc123',
    oauthAccount: {
      accountUuid: '00000000-0000-0000-0000-000000000000',
      emailAddress: 'someone@example.com',
      organizationUuid: '11111111-1111-1111-1111-111111111111',
      organizationName: name,
    },
  });

describe('Organization Element', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getOrganizationName', () => {
    it('reads the organization from the config-dir config', () => {
      withConfigs({ [PROFILE_CONFIG]: configWithOrg('Acme (Team)') });
      expect(getOrganizationName()).toBe('Acme (Team)');
    });

    it('prefers the config-dir config over the home config', () => {
      withConfigs({
        [PROFILE_CONFIG]: configWithOrg('Profile Org'),
        [HOME_CONFIG]: configWithOrg('Home Org'),
      });
      expect(getOrganizationName()).toBe('Profile Org');
    });

    it('falls back to the home config when the config-dir file is missing', () => {
      withConfigs({ [HOME_CONFIG]: configWithOrg('Home Org') });
      expect(getOrganizationName()).toBe('Home Org');
    });

    it('falls back to the home config when the config-dir file has no organization', () => {
      withConfigs({
        [PROFILE_CONFIG]: JSON.stringify({ oauthAccount: {} }),
        [HOME_CONFIG]: configWithOrg('Home Org'),
      });
      expect(getOrganizationName()).toBe('Home Org');
    });

    it('trims surrounding whitespace', () => {
      withConfigs({ [PROFILE_CONFIG]: configWithOrg('  Acme  ') });
      expect(getOrganizationName()).toBe('Acme');
    });

    it('returns null when no config exists', () => {
      withConfigs({});
      expect(getOrganizationName()).toBeNull();
    });

    it('returns null when there is no oauthAccount block (API-key auth)', () => {
      withConfigs({ [PROFILE_CONFIG]: JSON.stringify({ userID: 'abc123' }) });
      expect(getOrganizationName()).toBeNull();
    });

    it('returns null when organizationName is empty or not a string', () => {
      withConfigs({ [PROFILE_CONFIG]: configWithOrg('   ') });
      expect(getOrganizationName()).toBeNull();

      withConfigs({ [PROFILE_CONFIG]: configWithOrg(42) });
      expect(getOrganizationName()).toBeNull();
    });

    it('returns null on unparseable config instead of throwing', () => {
      withConfigs({ [PROFILE_CONFIG]: '{ not json' });
      expect(getOrganizationName()).toBeNull();
    });

    it('skips configs above the size cap', () => {
      withConfigs({ [PROFILE_CONFIG]: configWithOrg('Acme') }, 6 * 1024 * 1024);
      expect(getOrganizationName()).toBeNull();
      expect(mockedReadFileSync).not.toHaveBeenCalled();
    });
  });

  describe('renderOrganization', () => {
    it('collapses the trailing plan qualifier', () => {
      withConfigs({ [PROFILE_CONFIG]: configWithOrg('Acme (Team)') });
      expect(plain(renderOrganization())).toBe('org:Acme·team');
    });

    it('renders the name as-is when there is no qualifier', () => {
      withConfigs({ [PROFILE_CONFIG]: configWithOrg('Acme') });
      expect(plain(renderOrganization())).toBe('org:Acme');
    });

    it('elides names longer than the width cap', () => {
      withConfigs({ [PROFILE_CONFIG]: configWithOrg('A'.repeat(40)) });
      const rendered = plain(renderOrganization());
      expect(rendered).toBe(`org:${'A'.repeat(27)}…`);
      expect(rendered?.length).toBe('org:'.length + 28);
    });

    it('returns null when no organization is on record', () => {
      withConfigs({});
      expect(renderOrganization()).toBeNull();
    });

    it('never surfaces the account email or any UUID', () => {
      withConfigs({ [PROFILE_CONFIG]: configWithOrg('Acme (Team)') });
      const rendered = renderOrganization() ?? '';
      expect(rendered).not.toContain('someone@example.com');
      expect(rendered).not.toContain('00000000-0000-0000-0000-000000000000');
      expect(rendered).not.toContain('11111111-1111-1111-1111-111111111111');
    });

    it('colors the value and dims the label', () => {
      withConfigs({ [PROFILE_CONFIG]: configWithOrg('Acme') });
      expect(renderOrganization()).toContain('\u001b[');
    });
  });
});
