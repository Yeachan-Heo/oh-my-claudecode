import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('team cli help text surfaces', () => {
  it('team.ts usage includes legacy and api surfaces', () => {
    const source = readFileSync(join(__dirname, '..', 'team.ts'), 'utf-8');
    expect(source).toContain('omc team resume <team_name>');
    expect(source).toContain('omc team shutdown <team_name>');
    expect(source).toContain('omc team api <operation>');
    expect(source).toContain('omc team [ralph] <N:agent-type[:role]>');
  });

  it('team.ts help text includes team api/resume/shutdown', () => {
    const source = readFileSync(join(__dirname, '..', 'team.ts'), 'utf-8');
    expect(source).toContain('omc team resume <team_name>');
    expect(source).toContain('omc team shutdown <team_name>');
    expect(source).toContain('omc team api <operation>');
  });

  it('team.ts help text documents opt-in worktree status fields', () => {
    const source = readFileSync(join(__dirname, '..', 'team.ts'), 'utf-8');
    expect(source).toContain('Native worker worktrees are opt-in/config-gated for runtime-v2');
    expect(source).toContain('workspace_mode');
    expect(source).toContain('worktree_mode');
    expect(source).toContain('team_state_root');
    expect(source).toContain('worker worktree metadata');
  });
});
