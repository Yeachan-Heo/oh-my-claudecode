import { describe, it, expect } from 'vitest';
import { parseSkillFile, generateSkillFrontmatter } from '../../hooks/learner/parser.js';

describe('Skill Parser', () => {
  it('should parse valid skill frontmatter', () => {
    const content = `---
id: "test-skill-001"
name: "Test Skill"
description: "A test skill"
source: extracted
createdAt: "2024-01-19T12:00:00Z"
triggers:
  - "test"
  - "demo"
tags:
  - "testing"
---

# Test Skill Content

This is the skill content.
`;

    const result = parseSkillFile(content);

    expect(result.valid).toBe(true);
    expect(result.metadata.id).toBe('test-skill-001');
    expect(result.metadata.name).toBe('Test Skill');
    expect(result.metadata.triggers).toEqual(['test', 'demo']);
    expect(result.content).toContain('Test Skill Content');
  });

  it('should reject skill without required fields', () => {
    const content = `---
name: "Incomplete Skill"
---

Content without required fields.
`;

    const result = parseSkillFile(content);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: id');
    expect(result.errors).toContain('Missing required field: triggers');
  });

  it('should generate valid frontmatter', () => {
    const metadata = {
      id: 'gen-skill-001',
      name: 'Generated Skill',
      description: 'A generated skill',
      source: 'extracted' as const,
      createdAt: '2024-01-19T12:00:00Z',
      triggers: ['generate', 'create'],
      tags: ['automation'],
    };

    const frontmatter = generateSkillFrontmatter(metadata);

    expect(frontmatter).toContain('id: "gen-skill-001"');
    expect(frontmatter).toContain('triggers:');
    expect(frontmatter).toContain('  - "generate"');
  });

  it('should reject content without frontmatter', () => {
    const content = `# Just content

No frontmatter here.
`;

    const result = parseSkillFile(content);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing YAML frontmatter');
  });

  it('should handle inline array triggers', () => {
    const content = `---
id: "inline-array"
name: "Inline Array Skill"
description: "Test inline arrays"
source: manual
triggers: ["alpha", "beta", "gamma"]
---

Content
`;

    const result = parseSkillFile(content);

    expect(result.valid).toBe(true);
    expect(result.metadata.triggers).toEqual(['alpha', 'beta', 'gamma']);
  });
});
