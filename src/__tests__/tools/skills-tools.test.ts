import { describe, it, expect } from 'vitest';
import { loadLocalTool, loadGlobalTool, listSkillsTool } from '../../tools/skills-tools.js';

describe('skills-tools', () => {
  describe('loadLocalTool', () => {
    it('should have correct name and description', () => {
      expect(loadLocalTool.name).toBe('load_omc_skills_local');
      expect(loadLocalTool.description).toContain('project-local');
    });

    it('should return content array from handler', async () => {
      const result = await loadLocalTool.handler({});
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
    });

    it('should reject path traversal in projectRoot', async () => {
      await expect(loadLocalTool.handler({ projectRoot: '../../etc' }))
        .rejects.toThrow('path traversal');
    });

    it('should reject absolute paths outside allowed dirs', async () => {
      await expect(loadLocalTool.handler({ projectRoot: '/etc' }))
        .rejects.toThrow('outside allowed directories');
    });

    it('should not expose absolute home paths in output', async () => {
      const result = await loadLocalTool.handler({});
      const text = result.content[0].text;
      // Output should use relativePath, not absolute paths
      expect(text).not.toMatch(/\/home\/[^/]+\//);
    });
  });

  describe('loadGlobalTool', () => {
    it('should have correct name and description', () => {
      expect(loadGlobalTool.name).toBe('load_omc_skills_global');
      expect(loadGlobalTool.description).toContain('global');
    });

    it('should return content array from handler', async () => {
      const result = await loadGlobalTool.handler({} as Record<string, never>);
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('listSkillsTool', () => {
    it('should have correct name and description', () => {
      expect(listSkillsTool.name).toBe('list_omc_skills');
      expect(listSkillsTool.description).toContain('all available');
    });

    it('should return content array from handler', async () => {
      const result = await listSkillsTool.handler({});
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
    });

    it('should reject path traversal in projectRoot', async () => {
      await expect(listSkillsTool.handler({ projectRoot: '../../../tmp' }))
        .rejects.toThrow('path traversal');
    });

    it('should reject absolute paths outside allowed dirs', async () => {
      await expect(listSkillsTool.handler({ projectRoot: '/tmp/evil' }))
        .rejects.toThrow('outside allowed directories');
    });
  });
});
