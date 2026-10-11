import { describe, it, expect } from 'vitest';
import { detectProvider, parseRemoteUrl } from '../../providers/index.js';

describe('detectProvider', () => {
  it('detects GitHub from HTTPS URL', () => {
    expect(detectProvider('https://github.com/user/repo.git')).toBe('github');
  });

  it('detects GitHub from SSH URL', () => {
    expect(detectProvider('git@github.com:user/repo.git')).toBe('github');
  });

  it('detects GitLab from HTTPS URL', () => {
    expect(detectProvider('https://gitlab.com/group/project.git')).toBe('gitlab');
  });

  it('detects GitLab from SSH URL', () => {
    expect(detectProvider('git@gitlab.com:group/project.git')).toBe('gitlab');
  });

  it('detects Bitbucket from HTTPS URL', () => {
    expect(detectProvider('https://bitbucket.org/workspace/repo.git')).toBe('bitbucket');
  });

  it('detects Bitbucket from SSH URL', () => {
    expect(detectProvider('git@bitbucket.org:workspace/repo.git')).toBe('bitbucket');
  });

  it('detects Azure DevOps from HTTPS URL', () => {
    expect(detectProvider('https://dev.azure.com/org/project/_git/repo')).toBe('azure-devops');
  });

  it('detects Azure DevOps from SSH URL', () => {
    expect(detectProvider('git@ssh.dev.azure.com:v3/org/project/repo')).toBe('azure-devops');
  });

  it('should detect Azure DevOps from legacy visualstudio.com HTTPS', () => {
    expect(detectProvider('https://myorg.visualstudio.com/MyProject/_git/MyRepo')).toBe('azure-devops');
  });

  it('detects self-hosted GitLab by hostname heuristic', () => {
    expect(detectProvider('https://my-gitlab.company.com/group/repo.git')).toBe('gitlab');
  });

  it('should detect Gitea from self-hosted hostname', () => {
    expect(detectProvider('https://gitea.example.com/owner/repo')).toBe('gitea');
  });

  it('should detect Forgejo from self-hosted hostname', () => {
    expect(detectProvider('https://forgejo.example.org/owner/repo')).toBe('forgejo');
  });

  it('should detect Gitea from subdomain', () => {
    expect(detectProvider('git@my-gitea.company.com:owner/repo.git')).toBe('gitea');
  });

  it('should not false-positive on unrelated hostnames', () => {
    expect(detectProvider('https://example.com/owner/repo')).toBe('unknown');
  });

  it('returns unknown for unrecognized hosts', () => {
    expect(detectProvider('https://random-host.com/user/repo.git')).toBe('unknown');
  });
});

describe('parseRemoteUrl', () => {
  it('parses GitHub HTTPS URL', () => {
    const result = parseRemoteUrl('https://github.com/user/repo.git');
    expect(result).toEqual({
      provider: 'github',
      host: 'github.com',
      owner: 'user',
      repo: 'repo',
    });
  });

  it('parses GitHub SSH URL', () => {
    const result = parseRemoteUrl('git@github.com:user/repo.git');
    expect(result).toEqual({
      provider: 'github',
      host: 'github.com',
      owner: 'user',
      repo: 'repo',
    });
  });

  it('parses GitLab HTTPS URL', () => {
    const result = parseRemoteUrl('https://gitlab.com/group/project.git');
    expect(result).toEqual({
      provider: 'gitlab',
      host: 'gitlab.com',
      owner: 'group',
      repo: 'project',
    });
  });

  it('parses Azure DevOps HTTPS URL', () => {
    const result = parseRemoteUrl('https://dev.azure.com/org/project/_git/repo');
    expect(result).toEqual({
      provider: 'azure-devops',
      host: 'dev.azure.com',
      owner: 'org/project',
      repo: 'repo',
    });
  });

  it('detects and parses Azure DevOps HTTPS URLs with userinfo', () => {
    const url = 'https://build-user:pat@dev.azure.com/org/project/_git/repo';
    expect(detectProvider(url)).toBe('azure-devops');
    expect(parseRemoteUrl(url)).toEqual({
      provider: 'azure-devops',
      host: 'dev.azure.com',
      owner: 'org/project',
      repo: 'repo',
    });
  });

  it('parses Azure DevOps SSH URL', () => {
    const result = parseRemoteUrl('git@ssh.dev.azure.com:v3/org/project/repo');
    expect(result).toEqual({
      provider: 'azure-devops',
      host: 'dev.azure.com',
      owner: 'org/project',
      repo: 'repo',
    });
  });

  it('should parse Azure DevOps legacy visualstudio.com HTTPS URL', () => {
    const result = parseRemoteUrl('https://myorg.visualstudio.com/MyProject/_git/MyRepo');
    expect(result).toEqual({
      provider: 'azure-devops',
      host: 'myorg.visualstudio.com',
      owner: 'myorg/MyProject',
      repo: 'MyRepo',
    });
  });

  it('should parse SSH URL with port', () => {
    const result = parseRemoteUrl('ssh://git@gitlab.company.com:2222/group/repo.git');
    expect(result).toEqual({
      provider: 'gitlab',
      host: 'gitlab.company.com',
      owner: 'group',
      repo: 'repo',
    });
  });

  it('strips .git suffix from repo name', () => {
    const result = parseRemoteUrl('https://github.com/user/my-repo.git');
    expect(result?.repo).toBe('my-repo');
  });

  it('handles URLs without .git suffix', () => {
    const result = parseRemoteUrl('https://github.com/user/my-repo');
    expect(result?.repo).toBe('my-repo');
  });

  it('returns null for invalid URLs', () => {
    expect(parseRemoteUrl('not-a-url')).toBeNull();
    expect(parseRemoteUrl('')).toBeNull();
  });

  it('handles trailing whitespace and newlines', () => {
    const result = parseRemoteUrl('https://github.com/user/repo.git\n');
    expect(result).toEqual({
      provider: 'github',
      host: 'github.com',
      owner: 'user',
      repo: 'repo',
    });
  });

  it('handles trailing whitespace with spaces', () => {
    const result = parseRemoteUrl('  https://github.com/user/repo.git  ');
    expect(result).toEqual({
      provider: 'github',
      host: 'github.com',
      owner: 'user',
      repo: 'repo',
    });
  });

  it('parses GitLab nested group HTTPS URL', () => {
    const result = parseRemoteUrl('https://gitlab.com/group/subgroup/repo.git');
    expect(result).toEqual({
      provider: 'gitlab',
      host: 'gitlab.com',
      owner: 'group/subgroup',
      repo: 'repo',
    });
  });

  it('parses GitLab nested group SSH URL', () => {
    const result = parseRemoteUrl('git@gitlab.com:group/subgroup/repo.git');
    expect(result).toEqual({
      provider: 'gitlab',
      host: 'gitlab.com',
      owner: 'group/subgroup',
      repo: 'repo',
    });
  });

  it('parses GitLab deeply nested group HTTPS URL', () => {
    const result = parseRemoteUrl('https://gitlab.com/a/b/c/repo.git');
    expect(result).toEqual({
      provider: 'gitlab',
      host: 'gitlab.com',
      owner: 'a/b/c',
      repo: 'repo',
    });
  });

  it('parses GitLab nested group SSH URL-style', () => {
    const result = parseRemoteUrl('ssh://git@gitlab.com/group/subgroup/repo.git');
    expect(result).toEqual({
      provider: 'gitlab',
      host: 'gitlab.com',
      owner: 'group/subgroup',
      repo: 'repo',
    });
  });
});

describe('Azure provider hostname identity', () => {
  it.each([
    'https://dev.azure.com.evil.invalid/org/proj/_git/repo',
    'https://notdev.azure.com/org/proj/_git/repo',
    'git@notssh.dev.azure.com:v3/org/proj/repo',
  ])('does not classify a lookalike host as Azure DevOps: %s', (url) => {
    expect(detectProvider(url)).toBe('unknown');
    expect(parseRemoteUrl(url)?.provider).toBe('unknown');
  });
});
