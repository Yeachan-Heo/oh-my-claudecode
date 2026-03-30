import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/security-config.js', () => ({
  isRemoteMcpDisabled: vi.fn(),
}));

import { isRemoteMcpDisabled } from '../lib/security-config.js';
import { getDefaultMcpServers } from '../mcp/servers.js';

describe('Remote MCP disable via security config', () => {
  beforeEach(() => {
    vi.mocked(isRemoteMcpDisabled).mockReset();
  });

  it('should include Exa and Context7 by default (non-strict)', () => {
    vi.mocked(isRemoteMcpDisabled).mockReturnValue(false);
    const servers = getDefaultMcpServers();
    expect(servers.exa).toBeDefined();
    expect(servers.context7).toBeDefined();
  });

  it('should exclude Exa and Context7 in strict mode', () => {
    vi.mocked(isRemoteMcpDisabled).mockReturnValue(true);
    const servers = getDefaultMcpServers();
    expect(servers.exa).toBeUndefined();
    expect(servers.context7).toBeUndefined();
  });

  it('should still allow explicit enableExa=false to disable', () => {
    vi.mocked(isRemoteMcpDisabled).mockReturnValue(false);
    const servers = getDefaultMcpServers({ enableExa: false });
    expect(servers.exa).toBeUndefined();
    expect(servers.context7).toBeDefined();
  });
});
