import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:os.hostname so tests are deterministic across environments.
const hostnameMock = vi.fn<() => string>();
vi.mock('node:os', () => ({
  hostname: () => hostnameMock(),
}));

import { renderHostname } from '../elements/hostname.js';

describe('renderHostname', () => {
  beforeEach(() => {
    hostnameMock.mockReset();
  });

  it('returns null when the OS reports an empty hostname', () => {
    hostnameMock.mockReturnValue('');
    expect(renderHostname()).toBeNull();
  });

  it('returns null when splitting an FQDN yields an empty short name', () => {
    // Defensive: hostname starting with a dot would split to '' first.
    hostnameMock.mockReturnValue('.local');
    expect(renderHostname()).toBeNull();
  });

  it('returns a host:<name> label for a simple hostname', () => {
    hostnameMock.mockReturnValue('laptop');
    const result = renderHostname();
    expect(result).not.toBeNull();
    expect(result).toContain('host:laptop');
  });

  it('strips the FQDN suffix and keeps only the short hostname', () => {
    hostnameMock.mockReturnValue('gpu-box.lan.example.com');
    const result = renderHostname();
    expect(result).toContain('host:gpu-box');
    expect(result).not.toContain('lan.example.com');
  });

  it('applies cyan styling', () => {
    hostnameMock.mockReturnValue('laptop');
    const result = renderHostname();
    // cyan() wraps text in ANSI escape codes — just verify an escape
    // sequence is present rather than hard-coding the specific color code.
    expect(result).toMatch(/\x1b\[[0-9;]+m/);
  });
});
