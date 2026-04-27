import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('mcp-team-bridge spawn args', () => {
  const source = readFileSync(join(__dirname, '..', 'mcp-team-bridge.ts'), 'utf-8');

  it('includes bypass approvals/sandbox and --skip-git-repo-check for Codex bridge spawns', () => {
    expect(source).toContain('"exec"');
    expect(source).toContain('"--dangerously-bypass-approvals-and-sandbox"');
    expect(source).toContain('"--skip-git-repo-check"');
  });

  it('keeps Gemini bridge spawn args with --approval-mode yolo', () => {
    expect(source).toContain('"--approval-mode"');
    expect(source).toContain('"yolo"');
    expect(source).not.toContain('"-i"');
    expect(source).toMatch(/cmd = "gemini";/);
  });

  it('spawns vibe with -p prompt + streaming output + auto-approve agent for mistral', () => {
    expect(source).toMatch(/cmd = "vibe";/);
    expect(source).toContain('"-p"');
    expect(source).toContain('"streaming"');
    expect(source).toContain('"auto-approve"');
  });

  it('does not push --model for mistral (vibe selects model via agent profile)', () => {
    // Locate the mistral branch in spawnCliProcess and verify it does not push --model.
    // Vibe rejects --model as an unknown flag — model selection happens via --agent
    // mapping to ~/.vibe/agents/<name>.toml.
    const mistralBranch = source.match(/provider === "mistral"\) \{[\s\S]*?\} else \{/);
    expect(mistralBranch).not.toBeNull();
    expect(mistralBranch![0]).not.toMatch(/args\.push\("--model"/);
  });
});
