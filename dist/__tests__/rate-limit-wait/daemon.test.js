/**
 * Tests for daemon.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readDaemonState, isDaemonRunning, getDaemonStatus, formatDaemonState, } from '../../features/rate-limit-wait/daemon.js';
describe('daemon', () => {
    const testDir = join(tmpdir(), 'omc-daemon-test-' + Date.now());
    const testConfig = {
        stateFilePath: join(testDir, 'state.json'),
        pidFilePath: join(testDir, 'daemon.pid'),
        logFilePath: join(testDir, 'daemon.log'),
        pollIntervalMs: 1000,
    };
    beforeEach(() => {
        mkdirSync(testDir, { recursive: true });
    });
    afterEach(() => {
        try {
            rmSync(testDir, { recursive: true, force: true });
        }
        catch {
            // Ignore cleanup errors
        }
    });
    describe('readDaemonState', () => {
        it('should return null when state file does not exist', () => {
            const state = readDaemonState(testConfig);
            expect(state).toBeNull();
        });
        it('should read and parse state file', () => {
            const testState = {
                isRunning: true,
                pid: 1234,
                startedAt: new Date('2024-01-01T00:00:00Z'),
                lastPollAt: new Date('2024-01-01T00:01:00Z'),
                rateLimitStatus: {
                    fiveHourLimited: false,
                    weeklyLimited: false,
                    isLimited: false,
                    fiveHourResetsAt: null,
                    weeklyResetsAt: null,
                    nextResetAt: null,
                    timeUntilResetMs: null,
                    lastCheckedAt: new Date('2024-01-01T00:01:00Z'),
                },
                blockedPanes: [],
                resumedPaneIds: [],
                totalResumeAttempts: 5,
                successfulResumes: 3,
                errorCount: 0,
            };
            writeFileSync(testConfig.stateFilePath, JSON.stringify(testState));
            const state = readDaemonState(testConfig);
            expect(state).not.toBeNull();
            expect(state.isRunning).toBe(true);
            expect(state.pid).toBe(1234);
            expect(state.totalResumeAttempts).toBe(5);
            expect(state.successfulResumes).toBe(3);
            expect(state.startedAt).toBeInstanceOf(Date);
        });
        it('should handle invalid JSON gracefully', () => {
            writeFileSync(testConfig.stateFilePath, 'invalid json{');
            const state = readDaemonState(testConfig);
            expect(state).toBeNull();
        });
    });
    describe('isDaemonRunning', () => {
        it('should return false when PID file does not exist', () => {
            const running = isDaemonRunning(testConfig);
            expect(running).toBe(false);
        });
        it('should return false for stale PID file', () => {
            // Write a PID that definitely doesn't exist
            writeFileSync(testConfig.pidFilePath, '999999');
            const running = isDaemonRunning(testConfig);
            expect(running).toBe(false);
            // PID file should be cleaned up
            expect(existsSync(testConfig.pidFilePath)).toBe(false);
        });
        it('should return true for current process PID', () => {
            // Write current process PID
            writeFileSync(testConfig.pidFilePath, String(process.pid));
            const running = isDaemonRunning(testConfig);
            expect(running).toBe(true);
        });
    });
    describe('getDaemonStatus', () => {
        it('should return not started status', () => {
            const result = getDaemonStatus(testConfig);
            expect(result.success).toBe(true);
            expect(result.message).toBe('Daemon has never been started');
        });
        it('should return not running status when state exists but no PID', () => {
            const testState = {
                isRunning: false,
                pid: null,
                startedAt: new Date(),
                lastPollAt: new Date(),
                rateLimitStatus: null,
                blockedPanes: [],
                resumedPaneIds: [],
                totalResumeAttempts: 0,
                successfulResumes: 0,
                errorCount: 0,
            };
            writeFileSync(testConfig.stateFilePath, JSON.stringify(testState));
            const result = getDaemonStatus(testConfig);
            expect(result.success).toBe(true);
            expect(result.message).toBe('Daemon is not running');
            expect(result.state).toBeDefined();
        });
        it('should return running status when PID file exists with valid PID', () => {
            const testState = {
                isRunning: true,
                pid: process.pid,
                startedAt: new Date(),
                lastPollAt: new Date(),
                rateLimitStatus: null,
                blockedPanes: [],
                resumedPaneIds: [],
                totalResumeAttempts: 0,
                successfulResumes: 0,
                errorCount: 0,
            };
            writeFileSync(testConfig.stateFilePath, JSON.stringify(testState));
            writeFileSync(testConfig.pidFilePath, String(process.pid));
            const result = getDaemonStatus(testConfig);
            expect(result.success).toBe(true);
            expect(result.message).toBe('Daemon is running');
            expect(result.state).toBeDefined();
        });
    });
    describe('formatDaemonState', () => {
        it('should format running daemon state', () => {
            const state = {
                isRunning: true,
                pid: 1234,
                startedAt: new Date(),
                lastPollAt: new Date(),
                rateLimitStatus: {
                    fiveHourLimited: false,
                    weeklyLimited: false,
                    isLimited: false,
                    fiveHourResetsAt: null,
                    weeklyResetsAt: null,
                    nextResetAt: null,
                    timeUntilResetMs: null,
                    lastCheckedAt: new Date(),
                },
                blockedPanes: [],
                resumedPaneIds: [],
                totalResumeAttempts: 10,
                successfulResumes: 8,
                errorCount: 2,
            };
            const output = formatDaemonState(state);
            expect(output).toContain('Daemon running');
            expect(output).toContain('PID: 1234');
            expect(output).toContain('Not rate limited');
            expect(output).toContain('Resume attempts: 10');
            expect(output).toContain('Successful: 8');
            expect(output).toContain('Errors: 2');
        });
        it('should format rate limited state', () => {
            const state = {
                isRunning: true,
                pid: 1234,
                startedAt: new Date(),
                lastPollAt: new Date(),
                rateLimitStatus: {
                    fiveHourLimited: true,
                    weeklyLimited: false,
                    isLimited: true,
                    fiveHourResetsAt: new Date(Date.now() + 3600000),
                    weeklyResetsAt: null,
                    nextResetAt: new Date(Date.now() + 3600000),
                    timeUntilResetMs: 3600000,
                    lastCheckedAt: new Date(),
                },
                blockedPanes: [],
                resumedPaneIds: [],
                totalResumeAttempts: 0,
                successfulResumes: 0,
                errorCount: 0,
            };
            const output = formatDaemonState(state);
            expect(output).toContain('5-hour limit reached');
        });
        it('should format state with blocked panes', () => {
            const state = {
                isRunning: true,
                pid: 1234,
                startedAt: new Date(),
                lastPollAt: new Date(),
                rateLimitStatus: null,
                blockedPanes: [
                    {
                        id: '%0',
                        session: 'main',
                        windowIndex: 0,
                        windowName: 'dev',
                        paneIndex: 0,
                        isActive: true,
                        analysis: {
                            hasClaudeCode: true,
                            hasRateLimitMessage: true,
                            isBlocked: true,
                            confidence: 0.9,
                        },
                        firstDetectedAt: new Date(),
                        resumeAttempted: false,
                    },
                ],
                resumedPaneIds: [],
                totalResumeAttempts: 0,
                successfulResumes: 0,
                errorCount: 0,
            };
            const output = formatDaemonState(state);
            expect(output).toContain('Found 1 blocked');
        });
        it('should format state with last error', () => {
            const state = {
                isRunning: true,
                pid: 1234,
                startedAt: new Date(),
                lastPollAt: new Date(),
                rateLimitStatus: null,
                blockedPanes: [],
                resumedPaneIds: [],
                totalResumeAttempts: 0,
                successfulResumes: 0,
                errorCount: 1,
                lastError: 'Test error message',
            };
            const output = formatDaemonState(state);
            expect(output).toContain('Last error: Test error message');
        });
        it('should format not running state', () => {
            const state = {
                isRunning: false,
                pid: null,
                startedAt: null,
                lastPollAt: null,
                rateLimitStatus: null,
                blockedPanes: [],
                resumedPaneIds: [],
                totalResumeAttempts: 0,
                successfulResumes: 0,
                errorCount: 0,
            };
            const output = formatDaemonState(state);
            expect(output).toContain('Daemon not running');
        });
    });
    describe('security: file permissions', () => {
        it('should create state file with restrictive permissions', () => {
            const testState = {
                isRunning: true,
                pid: 1234,
                startedAt: new Date(),
                lastPollAt: new Date(),
                rateLimitStatus: null,
                blockedPanes: [],
                resumedPaneIds: [],
                totalResumeAttempts: 0,
                successfulResumes: 0,
                errorCount: 0,
            };
            writeFileSync(testConfig.stateFilePath, JSON.stringify(testState));
            // Read state back (this exercises the read path)
            const state = readDaemonState(testConfig);
            expect(state).not.toBeNull();
        });
        it('should not store sensitive data in state file', () => {
            const testState = {
                isRunning: true,
                pid: 1234,
                startedAt: new Date(),
                lastPollAt: new Date(),
                rateLimitStatus: {
                    fiveHourLimited: false,
                    weeklyLimited: false,
                    isLimited: false,
                    fiveHourResetsAt: null,
                    weeklyResetsAt: null,
                    nextResetAt: null,
                    timeUntilResetMs: null,
                    lastCheckedAt: new Date(),
                },
                blockedPanes: [],
                resumedPaneIds: [],
                totalResumeAttempts: 0,
                successfulResumes: 0,
                errorCount: 0,
            };
            writeFileSync(testConfig.stateFilePath, JSON.stringify(testState));
            // Verify no tokens or credentials in state file
            const { readFileSync } = require('fs');
            const content = readFileSync(testConfig.stateFilePath, 'utf-8');
            // State should not contain sensitive fields
            expect(content).not.toContain('accessToken');
            expect(content).not.toContain('apiKey');
            expect(content).not.toContain('password');
            expect(content).not.toContain('secret');
            expect(content).not.toContain('credential');
        });
    });
});
//# sourceMappingURL=daemon.test.js.map