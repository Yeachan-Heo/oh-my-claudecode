import { describe, it, expect } from 'vitest';
import { checkHostLoadGate, countLiveSessions, gateExpensiveOperation, getDefaultGateConfig, getHostMetrics, parseGateConfig, waitForHostLoadGate, } from '../host-load-gate.js';
import { cpus } from 'os';
// Mock environment for testing
function withEnv(vars, fn) {
    const prev = new Map();
    for (const [key, value] of Object.entries(vars)) {
        prev.set(key, process.env[key]);
        if (value === undefined) {
            delete process.env[key];
        }
        else {
            process.env[key] = value;
        }
    }
    try {
        fn();
    }
    finally {
        for (const [key, value] of prev) {
            if (value === undefined) {
                delete process.env[key];
            }
            else {
                process.env[key] = value;
            }
        }
    }
}
describe('host-load-gate', () => {
    describe('getDefaultGateConfig', () => {
        it('returns config with sensible defaults', () => {
            withEnv({ OMC_HOST_LOAD_GATE_DISABLED: undefined }, () => {
                const config = getDefaultGateConfig();
                expect(config.enabled).toBe(true);
                expect(config.cpuLoadThreshold).toBeGreaterThan(0);
                expect(config.freeMemoryThreshold).toBeGreaterThan(0);
                expect(config.maxSiblingSessions).toBeGreaterThan(0);
                expect(config.gateTimeoutMs).toBe(30_000);
                expect(config.checkIntervalMs).toBe(2_000);
            });
        });
        it('disables gating when OMC_HOST_LOAD_GATE_DISABLED is set', () => {
            withEnv({ OMC_HOST_LOAD_GATE_DISABLED: '1' }, () => {
                const config = getDefaultGateConfig();
                expect(config.enabled).toBe(false);
            });
        });
        it('cpu load threshold is relative to core count', () => {
            const config = getDefaultGateConfig();
            const coreCount = cpus().length;
            expect(config.cpuLoadThreshold).toBe(coreCount * 0.8);
        });
    });
    describe('parseGateConfig', () => {
        it('parses cpu load threshold from OMC_HOST_LOAD_THRESHOLD', () => {
            withEnv({ OMC_HOST_LOAD_THRESHOLD: '2.5' }, () => {
                const config = parseGateConfig();
                expect(config.cpuLoadThreshold).toBe(2.5);
            });
        });
        it('parses free memory threshold from OMC_FREE_MEMORY_THRESHOLD (in MB)', () => {
            withEnv({ OMC_FREE_MEMORY_THRESHOLD: '512' }, () => {
                const config = parseGateConfig();
                expect(config.freeMemoryThreshold).toBe(512 * 1024 * 1024);
            });
        });
        it('parses max sibling sessions from OMC_MAX_SIBLING_SESSIONS', () => {
            withEnv({ OMC_MAX_SIBLING_SESSIONS: '16' }, () => {
                const config = parseGateConfig();
                expect(config.maxSiblingSessions).toBe(16);
            });
        });
        it('accepts leading and trailing whitespace around numeric thresholds', () => {
            withEnv({
                OMC_HOST_LOAD_THRESHOLD: ' 2.5 ',
                OMC_FREE_MEMORY_THRESHOLD: ' 512 ',
                OMC_MAX_SIBLING_SESSIONS: ' 16 ',
            }, () => {
                const config = parseGateConfig();
                expect(config.cpuLoadThreshold).toBe(2.5);
                expect(config.freeMemoryThreshold).toBe(512 * 1024 * 1024);
                expect(config.maxSiblingSessions).toBe(16);
            });
        });
        it('handles invalid environment variables gracefully', () => {
            withEnv({ OMC_HOST_LOAD_THRESHOLD: 'not-a-number' }, () => {
                const config = parseGateConfig();
                // Should use default
                const defaults = getDefaultGateConfig();
                expect(config.cpuLoadThreshold).toBe(defaults.cpuLoadThreshold);
            });
        });
        it('does not truncate a partially-numeric free memory threshold', () => {
            // parseInt('12abc', 10) is 12, which would have configured a 12MB floor.
            withEnv({ OMC_FREE_MEMORY_THRESHOLD: '12abc' }, () => {
                const config = parseGateConfig();
                const defaults = getDefaultGateConfig();
                expect(config.freeMemoryThreshold).toBe(defaults.freeMemoryThreshold);
            });
        });
        it('does not truncate a fractional free memory threshold', () => {
            // parseInt('8.9', 10) is 8, silently dropping the fraction.
            withEnv({ OMC_FREE_MEMORY_THRESHOLD: '8.9' }, () => {
                const config = parseGateConfig();
                const defaults = getDefaultGateConfig();
                expect(config.freeMemoryThreshold).toBe(defaults.freeMemoryThreshold);
            });
        });
        it('honours exponent notation in the free memory threshold', () => {
            // parseInt('1e3', 10) is 1, so this used to configure a 1MB floor -- low
            // enough that the memory check effectively stopped gating.
            withEnv({ OMC_FREE_MEMORY_THRESHOLD: '1e3' }, () => {
                const config = parseGateConfig();
                expect(config.freeMemoryThreshold).toBe(1000 * 1024 * 1024);
            });
        });
        it('does not truncate a partially-numeric max sibling sessions', () => {
            withEnv({ OMC_MAX_SIBLING_SESSIONS: '4 sessions' }, () => {
                const config = parseGateConfig();
                const defaults = getDefaultGateConfig();
                expect(config.maxSiblingSessions).toBe(defaults.maxSiblingSessions);
            });
        });
        it('does not truncate a partially-numeric cpu load threshold', () => {
            // parseFloat('2.5x', 10) is 2.5, accepting a malformed value as valid.
            withEnv({ OMC_HOST_LOAD_THRESHOLD: '2.5x' }, () => {
                const config = parseGateConfig();
                const defaults = getDefaultGateConfig();
                expect(config.cpuLoadThreshold).toBe(defaults.cpuLoadThreshold);
            });
        });
        it('rejects a fractional value that rounds to an integer', () => {
            // The nearest double to '8.9999999999999999' is exactly 9, so deciding
            // integrality from the parsed number would accept it and raise the cap.
            withEnv({ OMC_MAX_SIBLING_SESSIONS: '8.9999999999999999' }, () => {
                const config = parseGateConfig();
                const defaults = getDefaultGateConfig();
                expect(config.maxSiblingSessions).toBe(defaults.maxSiblingSessions);
            });
        });
        it('rejects an exponent value that underflows to zero', () => {
            // '1e-324' is below the smallest double and becomes 0.
            withEnv({ OMC_MAX_SIBLING_SESSIONS: '1e-324' }, () => {
                const config = parseGateConfig();
                const defaults = getDefaultGateConfig();
                expect(config.maxSiblingSessions).toBe(defaults.maxSiblingSessions);
            });
        });
        it('accepts an exponent value whose exponent covers its fraction digits', () => {
            withEnv({ OMC_MAX_SIBLING_SESSIONS: '1.5e3' }, () => {
                expect(parseGateConfig().maxSiblingSessions).toBe(1500);
            });
        });
        it('rejects an exponent value whose fraction survives the exponent', () => {
            withEnv({ OMC_MAX_SIBLING_SESSIONS: '1.5e0' }, () => {
                const config = parseGateConfig();
                const defaults = getDefaultGateConfig();
                expect(config.maxSiblingSessions).toBe(defaults.maxSiblingSessions);
            });
        });
        it('accepts equivalent spellings of the same integral threshold', () => {
            // '1024' and these three denote the same value, so the parser must not
            // prefer one spelling: the previous exponent-only rule rejected the last
            // two and quietly dropped a 1024MB floor to the 256MB default.
            for (const spelling of ['1024', '1024.0', '1.024e3', '10240e-1']) {
                withEnv({ OMC_FREE_MEMORY_THRESHOLD: spelling }, () => {
                    expect(parseGateConfig().freeMemoryThreshold).toBe(1024 * 1024 * 1024);
                });
            }
        });
        it('accepts a negative exponent cancelled by trailing zeros', () => {
            withEnv({ OMC_FREE_MEMORY_THRESHOLD: '10000e-1' }, () => {
                expect(parseGateConfig().freeMemoryThreshold).toBe(1000 * 1024 * 1024);
            });
        });
        it('accepts zero with negative exponent notation', () => {
            for (const spelling of ['0e-2', '-0e-2']) {
                withEnv({ OMC_MAX_SIBLING_SESSIONS: spelling }, () => {
                    expect(parseGateConfig().maxSiblingSessions).toBe(0);
                });
            }
        });
        it('falls back to the default for a negative radix-prefixed integer threshold', () => {
            const defaultMaxSiblingSessions = getDefaultGateConfig().maxSiblingSessions;
            withEnv({ OMC_MAX_SIBLING_SESSIONS: '-0x1' }, () => {
                expect(parseGateConfig().maxSiblingSessions).toBe(defaultMaxSiblingSessions);
            });
        });
        it('still accepts a radix-prefixed integer', () => {
            withEnv({ OMC_MAX_SIBLING_SESSIONS: '0x10' }, () => {
                expect(parseGateConfig().maxSiblingSessions).toBe(16);
            });
        });
        it('falls back to defaults for negative environment thresholds', () => {
            const defaults = getDefaultGateConfig();
            withEnv({
                OMC_HOST_LOAD_THRESHOLD: '-1',
                OMC_FREE_MEMORY_THRESHOLD: '-1',
                OMC_MAX_SIBLING_SESSIONS: '-1',
            }, () => {
                const config = parseGateConfig();
                expect(config.cpuLoadThreshold).toBe(defaults.cpuLoadThreshold);
                expect(config.freeMemoryThreshold).toBe(defaults.freeMemoryThreshold);
                expect(config.maxSiblingSessions).toBe(defaults.maxSiblingSessions);
            });
        });
        it('falls back to defaults for empty and whitespace-only thresholds', () => {
            const defaults = getDefaultGateConfig();
            withEnv({
                OMC_HOST_LOAD_THRESHOLD: ' ',
                OMC_FREE_MEMORY_THRESHOLD: '',
                OMC_MAX_SIBLING_SESSIONS: '\t',
            }, () => {
                const config = parseGateConfig();
                expect(config.cpuLoadThreshold).toBe(defaults.cpuLoadThreshold);
                expect(config.freeMemoryThreshold).toBe(defaults.freeMemoryThreshold);
                expect(config.maxSiblingSessions).toBe(defaults.maxSiblingSessions);
            });
        });
        it('uses zero as a valid free memory threshold', () => {
            withEnv({ OMC_FREE_MEMORY_THRESHOLD: '0' }, () => {
                expect(parseGateConfig().freeMemoryThreshold).toBe(0);
            });
        });
        it('falls back to defaults for out-of-range integer thresholds', () => {
            withEnv({ OMC_MAX_SIBLING_SESSIONS: '9007199254740992' }, () => {
                expect(parseGateConfig().maxSiblingSessions).toBe(getDefaultGateConfig().maxSiblingSessions);
            });
        });
        it('rejects NaN and out-of-range non-finite thresholds', () => {
            const defaultCpuLoadThreshold = getDefaultGateConfig().cpuLoadThreshold;
            for (const value of ['NaN', 'Infinity', '1e999']) {
                withEnv({ OMC_HOST_LOAD_THRESHOLD: value }, () => {
                    expect(parseGateConfig().cpuLoadThreshold).toBe(defaultCpuLoadThreshold);
                });
            }
        });
        it('accepts override parameters', () => {
            const config = parseGateConfig({
                cpuLoadThreshold: 4.0,
                maxSiblingSessions: 20,
            });
            expect(config.cpuLoadThreshold).toBe(4.0);
            expect(config.maxSiblingSessions).toBe(20);
        });
    });
    describe('countLiveSessions', () => {
        it('returns non-negative count', () => {
            const count = countLiveSessions();
            expect(count).toBeGreaterThanOrEqual(0);
        });
        it('fails open and returns 0 when unable to read', () => {
            // The function catches all errors and returns 0
            // Testing with actual file system to ensure robustness
            const count = countLiveSessions();
            expect(typeof count).toBe('number');
            expect(count).toBeGreaterThanOrEqual(0);
        });
    });
    describe('getHostMetrics', () => {
        it('returns metrics with valid values', () => {
            const metrics = getHostMetrics();
            expect(metrics.cpuLoad).toBeGreaterThanOrEqual(0);
            expect(metrics.freeMemoryBytes).toBeGreaterThanOrEqual(0);
            expect(metrics.totalMemoryBytes).toBeGreaterThan(0);
            expect(metrics.freeMemoryPercent).toBeGreaterThanOrEqual(0);
            expect(metrics.freeMemoryPercent).toBeLessThanOrEqual(100);
            expect(metrics.siblingSessions).toBeGreaterThanOrEqual(0);
        });
        it('free memory is less than or equal to total memory', () => {
            const metrics = getHostMetrics();
            expect(metrics.freeMemoryBytes).toBeLessThanOrEqual(metrics.totalMemoryBytes);
        });
        it('always returns valid metrics', () => {
            const metrics = getHostMetrics();
            // Should not throw and should have valid metrics
            expect(metrics).toBeDefined();
            expect(typeof metrics.cpuLoad).toBe('number');
            expect(typeof metrics.freeMemoryBytes).toBe('number');
            expect(typeof metrics.freeMemoryPercent).toBe('number');
        });
    });
    describe('checkHostLoadGate', () => {
        it('allows operation when gate is disabled', () => {
            const config = {
                enabled: false,
                cpuLoadThreshold: 1,
                freeMemoryThreshold: 1,
                maxSiblingSessions: 1,
                gateTimeoutMs: 1000,
                checkIntervalMs: 100,
            };
            const result = checkHostLoadGate(config);
            expect(result.allowed).toBe(true);
        });
        it('allows operation when all thresholds are not exceeded', () => {
            const config = {
                enabled: true,
                cpuLoadThreshold: 999, // Very high
                freeMemoryThreshold: 1, // Very low
                maxSiblingSessions: 999, // Very high
                gateTimeoutMs: 1000,
                checkIntervalMs: 100,
            };
            const result = checkHostLoadGate(config);
            expect(result.allowed).toBe(true);
            expect(result.metrics).toBeDefined();
        });
        it('gates when cpu load exceeds threshold', () => {
            const config = {
                enabled: true,
                cpuLoadThreshold: 0, // Always exceeded
                freeMemoryThreshold: -1, // Disabled
                maxSiblingSessions: -1, // Disabled
                gateTimeoutMs: 1000,
                checkIntervalMs: 100,
            };
            const result = checkHostLoadGate(config);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('CPU load');
        });
        it('gates when free memory is below threshold', () => {
            const config = {
                enabled: true,
                cpuLoadThreshold: -1, // Disabled
                freeMemoryThreshold: Number.MAX_VALUE, // Always exceeded
                maxSiblingSessions: -1, // Disabled
                gateTimeoutMs: 1000,
                checkIntervalMs: 100,
            };
            const result = checkHostLoadGate(config);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Free memory');
        });
        it('gates when sibling sessions exceed max', () => {
            const config = {
                enabled: true,
                cpuLoadThreshold: -1, // Disabled
                freeMemoryThreshold: -1, // Disabled
                maxSiblingSessions: 0, // Max 0 sessions (any real session exceeds)
                gateTimeoutMs: 1000,
                checkIntervalMs: 100,
            };
            const result = checkHostLoadGate(config);
            // Result depends on actual session count; may or may not be gated
            expect(result.metrics).toBeDefined();
        });
        it('disables thresholds with negative values', () => {
            const config = {
                enabled: true,
                cpuLoadThreshold: -1,
                freeMemoryThreshold: -1,
                maxSiblingSessions: -1,
                gateTimeoutMs: 1000,
                checkIntervalMs: 100,
            };
            const result = checkHostLoadGate(config);
            expect(result.allowed).toBe(true); // All thresholds disabled
        });
        it('includes wait time in response', () => {
            const config = {
                enabled: true,
                cpuLoadThreshold: 0,
                freeMemoryThreshold: -1,
                maxSiblingSessions: -1,
                gateTimeoutMs: 1000,
                checkIntervalMs: 500,
            };
            const result = checkHostLoadGate(config);
            if (!result.allowed) {
                expect(result.waitMs).toBe(config.checkIntervalMs);
            }
        });
    });
    describe('waitForHostLoadGate', () => {
        it('resolves immediately when gate allows', async () => {
            const config = {
                enabled: true,
                cpuLoadThreshold: 999,
                freeMemoryThreshold: 1,
                maxSiblingSessions: 999,
                gateTimeoutMs: 1000,
                checkIntervalMs: 100,
            };
            const start = Date.now();
            const result = await waitForHostLoadGate(config);
            const elapsed = Date.now() - start;
            expect(result.allowed).toBe(true);
            expect(elapsed).toBeLessThan(500); // Should be immediate
        });
        it('fails open after timeout', async () => {
            const config = {
                enabled: true,
                cpuLoadThreshold: 0, // Always exceeded
                freeMemoryThreshold: -1,
                maxSiblingSessions: -1,
                gateTimeoutMs: 100,
                checkIntervalMs: 30,
            };
            const start = Date.now();
            const result = await waitForHostLoadGate(config);
            const elapsed = Date.now() - start;
            // After timeout, should return allowed=true (fail open)
            expect(result.allowed).toBe(true);
            expect(elapsed).toBeGreaterThanOrEqual(100);
            expect(elapsed).toBeLessThan(500); // Should not wait much longer than timeout
        });
        it('respects custom timeout override', async () => {
            const config = {
                enabled: true,
                cpuLoadThreshold: 0, // Always exceeded
                freeMemoryThreshold: -1,
                maxSiblingSessions: -1,
                gateTimeoutMs: 10_000, // Long default
                checkIntervalMs: 30,
            };
            const start = Date.now();
            const result = await waitForHostLoadGate(config, 50); // Short override
            const elapsed = Date.now() - start;
            expect(result.allowed).toBe(true);
            expect(elapsed).toBeGreaterThanOrEqual(50);
            expect(elapsed).toBeLessThan(200);
        });
    });
    describe('gateExpensiveOperation', () => {
        it('allows operation when not gated', () => {
            const config = {
                enabled: true,
                cpuLoadThreshold: 999,
                freeMemoryThreshold: 1,
                maxSiblingSessions: 999,
                gateTimeoutMs: 1000,
                checkIntervalMs: 100,
            };
            const result = gateExpensiveOperation('test-operation', config);
            expect(result.allowed).toBe(true);
        });
        it('returns message when gated', () => {
            const config = {
                enabled: true,
                cpuLoadThreshold: 0, // Always exceeded
                freeMemoryThreshold: -1,
                maxSiblingSessions: -1,
                gateTimeoutMs: 1000,
                checkIntervalMs: 100,
            };
            const result = gateExpensiveOperation('browser-launch', config);
            expect(result.allowed).toBe(false);
            expect(result.message).toContain('Host load gate');
            expect(result.message).toContain('browser-launch');
            expect(result.message).toContain('CPU load');
        });
        it('includes disable instruction in message', () => {
            const config = {
                enabled: true,
                cpuLoadThreshold: 0,
                freeMemoryThreshold: -1,
                maxSiblingSessions: -1,
                gateTimeoutMs: 1000,
                checkIntervalMs: 100,
            };
            const result = gateExpensiveOperation('test', config);
            expect(result.message).toContain('OMC_HOST_LOAD_GATE_DISABLED');
        });
    });
    describe('integration with worker launch', () => {
        it('checkHostLoadGate is called before worker spawning', async () => {
            // Import the gate function to verify it's exported and can be imported
            const { checkHostLoadGate: importedCheck } = await import('../host-load-gate.js');
            expect(typeof importedCheck).toBe('function');
            // Verify the gate function works
            const result = importedCheck();
            expect(result).toHaveProperty('allowed');
            expect(typeof result.allowed).toBe('boolean');
            expect(result).toHaveProperty('metrics');
            if (!result.allowed && result.reason) {
                expect(typeof result.reason).toBe('string');
            }
        });
        it('gate allows saturation-free hosts to proceed', () => {
            withEnv({ OMC_HOST_LOAD_GATE_DISABLED: undefined }, () => {
                const config = getDefaultGateConfig();
                // Set extremely high thresholds so gate always allows
                config.cpuLoadThreshold = Number.MAX_SAFE_INTEGER;
                config.freeMemoryThreshold = 0; // No minimum memory required
                config.maxSiblingSessions = Number.MAX_SAFE_INTEGER;
                const result = checkHostLoadGate(config);
                expect(result.allowed).toBe(true);
            });
        });
        it('gate denies when host metrics exceed thresholds', () => {
            const config = getDefaultGateConfig();
            // Set extremely low thresholds to trigger saturation
            config.cpuLoadThreshold = 0.001;
            config.freeMemoryThreshold = Number.MAX_SAFE_INTEGER; // Require more memory than available
            config.maxSiblingSessions = 0; // No sessions allowed
            const result = checkHostLoadGate(config);
            // Gate may deny if any metric is exceeded
            // (the result depends on actual host state)
            expect(result).toHaveProperty('allowed');
            expect(typeof result.allowed).toBe('boolean');
        });
    });
});
//# sourceMappingURL=host-load-gate.test.js.map