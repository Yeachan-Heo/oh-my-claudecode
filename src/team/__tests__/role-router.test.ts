import { describe, it, expect } from 'vitest';
import { inferLaneIntent, routeTaskToRole } from '../role-router.js';

describe('role-router', () => {
  describe('inferLaneIntent', () => {
    it('returns unknown for empty string', () => {
      expect(inferLaneIntent('')).toBe('unknown');
    });

    it('detects build-fix intent', () => {
      expect(inferLaneIntent('fix the failing build')).toBe('build-fix');
      expect(inferLaneIntent('build error needs fixing')).toBe('build-fix');
      expect(inferLaneIntent('fix CI')).toBe('build-fix');
      expect(inferLaneIntent('tsc error in types')).toBe('build-fix');
    });

    it('detects debug intent', () => {
      expect(inferLaneIntent('debug the auth flow')).toBe('debug');
      expect(inferLaneIntent('troubleshoot the login issue')).toBe('debug');
      expect(inferLaneIntent('investigate root cause')).toBe('debug');
    });

    it('detects docs intent', () => {
      expect(inferLaneIntent('write documentation for the API')).toBe('docs');
      expect(inferLaneIntent('update README')).toBe('docs');
      expect(inferLaneIntent('add jsdoc comments')).toBe('docs');
    });

    it('detects design intent', () => {
      expect(inferLaneIntent('design the authentication system')).toBe('design');
      expect(inferLaneIntent('architecture for the new service')).toBe('design');
      expect(inferLaneIntent('UI design for dashboard')).toBe('design');
    });

    it('detects cleanup intent', () => {
      expect(inferLaneIntent('refactor the payment module')).toBe('cleanup');
      expect(inferLaneIntent('clean up unused imports')).toBe('cleanup');
      expect(inferLaneIntent('simplify the router logic')).toBe('cleanup');
    });

    it('detects review intent', () => {
      expect(inferLaneIntent('review the auth PR')).toBe('review');
      expect(inferLaneIntent('code review for new feature')).toBe('review');
      expect(inferLaneIntent('audit the API endpoints')).toBe('review');
    });

    it('detects verification intent', () => {
      expect(inferLaneIntent('write unit tests for the service')).toBe('verification');
      expect(inferLaneIntent('add test coverage for login')).toBe('verification');
      expect(inferLaneIntent('verify the integration')).toBe('verification');
    });

    it('detects implementation intent', () => {
      expect(inferLaneIntent('implement the auth module')).toBe('implementation');
      expect(inferLaneIntent('add feature for user profile')).toBe('implementation');
    });

    it('returns unknown for ambiguous text', () => {
      expect(inferLaneIntent('do the thing')).toBe('unknown');
      expect(inferLaneIntent('task 1')).toBe('unknown');
    });
  });

  describe('routeTaskToRole', () => {
    it('routes build-fix intent to build-fixer', () => {
      const result = routeTaskToRole('fix build', '', 'executor');
      expect(result.role).toBe('build-fixer');
      expect(result.confidence).toBe('high');
    });

    it('routes debug intent to debugger', () => {
      const result = routeTaskToRole('debug the crash', '', 'executor');
      expect(result.role).toBe('debugger');
      expect(result.confidence).toBe('high');
    });

    it('routes docs intent to writer', () => {
      const result = routeTaskToRole('write documentation', '', 'executor');
      expect(result.role).toBe('writer');
      expect(result.confidence).toBe('high');
    });

    it('routes design intent to designer', () => {
      const result = routeTaskToRole('design the API', '', 'executor');
      expect(result.role).toBe('designer');
      expect(result.confidence).toBe('high');
    });

    it('routes cleanup intent to code-simplifier', () => {
      const result = routeTaskToRole('refactor the module', '', 'executor');
      expect(result.role).toBe('code-simplifier');
      expect(result.confidence).toBe('high');
    });

    it('routes review + security domain to security-reviewer', () => {
      const result = routeTaskToRole('review the auth security', 'check for XSS vulnerabilities', 'executor');
      expect(result.role).toBe('security-reviewer');
      expect(result.confidence).toBe('high');
    });

    it('routes review without security domain to quality-reviewer', () => {
      const result = routeTaskToRole('review the PR', '', 'executor');
      expect(result.role).toBe('quality-reviewer');
      expect(result.confidence).toBe('high');
    });

    it('routes verification intent to test-engineer', () => {
      const result = routeTaskToRole('write unit tests', '', 'executor');
      expect(result.role).toBe('test-engineer');
      expect(result.confidence).toBe('high');
    });

    it('keeps implementation + security domain on fallback role (not security-reviewer)', () => {
      const result = routeTaskToRole('implement auth', 'add authentication with JWT and authorization checks', 'executor');
      expect(result.role).toBe('executor');
      expect(result.confidence).toBe('medium');
    });

    it('uses fallback role with low confidence for unknown intent', () => {
      const result = routeTaskToRole('do the thing', '', 'executor');
      expect(result.role).toBe('executor');
      expect(result.confidence).toBe('low');
    });

    it('respects custom fallback role', () => {
      const result = routeTaskToRole('do the thing', '', 'my-custom-role');
      expect(result.role).toBe('my-custom-role');
    });

    it('includes a reason string in all results', () => {
      const cases = [
        routeTaskToRole('fix build', '', 'executor'),
        routeTaskToRole('debug crash', '', 'executor'),
        routeTaskToRole('write docs', '', 'executor'),
        routeTaskToRole('do the thing', '', 'executor'),
      ];
      for (const r of cases) {
        expect(typeof r.reason).toBe('string');
        expect(r.reason.length).toBeGreaterThan(0);
      }
    });
  });
});
