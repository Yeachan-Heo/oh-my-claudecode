import { describe, it, expect } from 'vitest';
import { loadConfig, getConfigValue } from '../../hooks/learner/config.js';

describe('Learner Config', () => {
  it('should return defaults when no config exists', () => {
    const config = loadConfig();

    expect(config.enabled).toBe(true);
    expect(config.detection.promptThreshold).toBe(60);
  });

  it('should have valid default detection config', () => {
    const config = loadConfig();

    expect(config.detection.enabled).toBe(true);
    expect(config.detection.promptCooldown).toBe(5);
  });

  it('should have valid default quality config', () => {
    const config = loadConfig();

    expect(config.quality.minScore).toBe(50);
    expect(config.quality.minProblemLength).toBe(10);
    expect(config.quality.minSolutionLength).toBe(20);
  });

  it('should have valid default storage config', () => {
    const config = loadConfig();

    expect(config.storage.maxSkillsPerScope).toBe(100);
    expect(config.storage.autoPrune).toBe(false);
    expect(config.storage.pruneDays).toBe(90);
  });

  it('should get specific config value', () => {
    const enabled = getConfigValue('enabled');
    expect(typeof enabled).toBe('boolean');
  });

  it('should get nested config value', () => {
    const detection = getConfigValue('detection');
    expect(detection).toHaveProperty('enabled');
    expect(detection).toHaveProperty('promptThreshold');
    expect(detection).toHaveProperty('promptCooldown');
  });
});
