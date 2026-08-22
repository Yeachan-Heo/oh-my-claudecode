import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isPythonSandboxEnabled, clearSecurityConfigCache } from '../../../lib/security-config.js';
describe('python-repl sandbox env propagation', () => {
    const originalSecurity = process.env.OMC_SECURITY;
    afterEach(() => {
        if (originalSecurity === undefined) {
            delete process.env.OMC_SECURITY;
        }
        else {
            process.env.OMC_SECURITY = originalSecurity;
        }
        clearSecurityConfigCache();
    });
    it('sandbox disabled by default', () => {
        delete process.env.OMC_SECURITY;
        clearSecurityConfigCache();
        expect(isPythonSandboxEnabled()).toBe(false);
    });
    it('sandbox enabled with OMC_SECURITY=strict', () => {
        process.env.OMC_SECURITY = 'strict';
        clearSecurityConfigCache();
        expect(isPythonSandboxEnabled()).toBe(true);
    });
});
function executeBridgeCode(code, sandboxEnv = false) {
    const bridgePath = new URL('../../../../bridge/gyoshu_bridge.py', import.meta.url).pathname;
    const tmpScript = join(tmpdir(), `omc-bridge-exec-test-${process.pid}-${Date.now()}.py`);
    const script = [
        'import importlib.util, json, os',
        sandboxEnv ? 'os.environ["OMC_PYTHON_SANDBOX"] = "1"' : 'os.environ.pop("OMC_PYTHON_SANDBOX", None)',
        `spec = importlib.util.spec_from_file_location("gyoshu_bridge", ${JSON.stringify(bridgePath)})`,
        'mod = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(mod)',
        'ns = mod.ExecutionState().namespace',
        `result = mod.execute_code(${JSON.stringify(code)}, ns, timeout=5)`,
        'print(json.dumps({"success": result["success"], "stdout": result["stdout"], "error": result.get("exception") and {"type": result["exception_type"], "message": result["exception"]}}))',
    ].join('\n');
    writeFileSync(tmpScript, script, 'utf-8');
    try {
        return JSON.parse(execSync(`python3 ${tmpScript}`, { timeout: 10000 }).toString().trim());
    }
    finally {
        try {
            unlinkSync(tmpScript);
        }
        catch { /* ignore */ }
    }
}
describe('gyoshu bridge execution builtins hardening', () => {
    it('allows normal calculation, printing, and persistent variables', () => {
        const result = executeBridgeCode('x = sum(range(5))\nprint(f"x={x}")');
        expect(result.success).toBe(true);
        expect(result.stdout.trim()).toBe('x=10');
    });
    it('computes variance and standard deviation with pure arithmetic (no library needed)', () => {
        // Grounds the scientist guidance: `variance ** 0.5` is a plain Pow
        // expression, so a square root needs no blocked import.
        const result = executeBridgeCode([
            'values = [2, 4, 4, 4, 5, 5, 7, 9]',
            'n = len(values)',
            'mean = sum(values) / n',
            'variance = sum((v - mean) ** 2 for v in values) / (n - 1)',
            'print(round(variance, 4), round(variance ** 0.5, 4))',
        ].join('\n'));
        expect(result.success).toBe(true);
        expect(result.stdout.trim()).toBe('4.5714 2.1381');
    });
    it('allows bridge memory helpers', () => {
        const result = executeBridgeCode('memory = get_memory()\nprint(isinstance(memory, dict))');
        expect(result.success).toBe(true);
        expect(result.stdout.trim()).toBe('True');
    });
    it('does not expose bridge helper function globals', () => {
        const result = executeBridgeCode('print(clean_memory.__globals__)');
        expect(result.success).toBe(false);
        expect(result.stdout).toBe('');
        expect(result.error?.type).toBe('GyoshuSecurityError');
        expect(result.error?.message).toContain('Dunder attribute access is not available');
    });
    it.each([
        ['import os'],
        ['import subprocess'],
        ['from pathlib import Path'],
        ['__import__("os")'],
    ])('blocks imports and import bypasses: %s', (code) => {
        const result = executeBridgeCode(code);
        expect(result.success).toBe(false);
        expect(result.error?.type).toBe('GyoshuSecurityError');
        expect(result.error?.message).toMatch(/Import statements|Builtin '__import__'/);
    });
    it.each([
        ['open("/etc/passwd").read()'],
        ['eval("1 + 1")'],
        ['exec("x = 1")'],
        ['compile("x = 1", "<x>", "exec")'],
        ['globals()'],
        ['locals()'],
        ['vars()'],
        ['getattr(1, "real")'],
    ])('blocks dangerous builtin: %s', (code) => {
        const result = executeBridgeCode(code);
        expect(result.success).toBe(false);
        expect(result.error?.type).toBe('GyoshuSecurityError');
        expect(result.error?.message).toContain('not available in the Gyoshu bridge execution namespace');
    });
    it('blocks object-model dunder traversal used to recover ambient capabilities', () => {
        const result = executeBridgeCode('().__class__.__mro__[1].__subclasses__()');
        expect(result.success).toBe(false);
        expect(result.error?.type).toBe('GyoshuSecurityError');
        expect(result.error?.message).toContain('Dunder attribute access is not available');
    });
    it('blocks string format field traversal used to recover dunder attributes', () => {
        const result = executeBridgeCode('"{0.__class__.__mro__[1].__subclasses__}".format(())');
        expect(result.success).toBe(false);
        expect(result.error?.type).toBe('GyoshuSecurityError');
        expect(result.error?.message).toContain('String format field traversal is not available');
    });
    it('uses the same locked-down execution namespace when OMC_PYTHON_SANDBOX=1', () => {
        const result = executeBridgeCode('print("ok")\nimport os', true);
        expect(result.success).toBe(false);
        expect(result.stdout).toBe('');
        expect(result.error?.type).toBe('GyoshuSecurityError');
        expect(result.error?.message).toContain('Import statements are not available');
    });
    it.each([
        ['import numpy as np'],
        ['import pandas'],
        ['import matplotlib'],
    ])('blocks the advertised scientific imports: %s', (code) => {
        const result = executeBridgeCode(code);
        expect(result.success).toBe(false);
        expect(result.error?.type).toBe('GyoshuSecurityError');
        expect(result.error?.message).toContain('Import statements are not available');
    });
    it.each([
        ['print(numpy.array([1, 2, 3]).sum())'],
        ['print(pandas.DataFrame())'],
        ['print(matplotlib)'],
    ])('does not prebind the advertised scientific module: %s', (code) => {
        const result = executeBridgeCode(code);
        expect(result.success).toBe(false);
        expect(result.error?.type).toBe('NameError');
    });
});
// Multi-step harness: exercise namespace seeding, execution, and reset in one
// bridge process so persistence/isolation semantics are observable. The
// execution core (namespace init, execute_code, reset) is pure stdlib Python
// and runs identically on macOS, Linux, and Windows; the Windows-specific TCP
// socket fallback is covered separately by tcp-fallback.test.ts.
function runBridgeLifecycle(seedCode) {
    const bridgePath = new URL('../../../../bridge/gyoshu_bridge.py', import.meta.url).pathname;
    const tmpScript = join(tmpdir(), `omc-bridge-lifecycle-${process.pid}-${Date.now()}.py`);
    const script = [
        'import importlib.util, json',
        `spec = importlib.util.spec_from_file_location("gyoshu_bridge", ${JSON.stringify(bridgePath)})`,
        'mod = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(mod)',
        'state = mod.ExecutionState()',
        'ns = state.namespace',
        'SCIENTIFIC = ("numpy", "pandas", "matplotlib")',
        'def user_vars(ns):',
        '    return sorted(k for k in ns if not k.startswith("_") and k not in ("clean_memory", "get_memory"))',
        'initialScientific = sorted(n for n in SCIENTIFIC if n in ns)',
        'initialVariables = user_vars(ns)',
        `seed = mod.execute_code(${JSON.stringify(seedCode)}, ns, timeout=5)`,
        'scientificAfterSeed = sorted(n for n in SCIENTIFIC if n in ns)',
        'variablesAfterSeed = user_vars(ns)',
        'reset = state.reset()',
        'ns2 = state.namespace',
        'scientificAfterReset = sorted(n for n in SCIENTIFIC if n in ns2)',
        'variablesAfterReset = user_vars(ns2)',
        'post = mod.execute_code("print(numpy.array([1, 2, 3]).sum())", ns2, timeout=5)',
        'print(json.dumps({',
        '    "initialScientific": initialScientific,',
        '    "initialVariables": initialVariables,',
        '    "seedSuccess": seed["success"],',
        '    "seedStdout": seed["stdout"],',
        '    "seedErrorType": seed.get("exception_type"),',
        '    "scientificAfterSeed": scientificAfterSeed,',
        '    "variablesAfterSeed": variablesAfterSeed,',
        '    "resetStatus": reset.get("status"),',
        '    "scientificAfterReset": scientificAfterReset,',
        '    "variablesAfterReset": variablesAfterReset,',
        '    "postResetSuccess": post["success"],',
        '    "postResetErrorType": post.get("exception_type"),',
        '    "postResetError": post.get("exception"),',
        '}))',
    ].join('\n');
    writeFileSync(tmpScript, script, 'utf-8');
    try {
        return JSON.parse(execSync(`python3 ${tmpScript}`, { timeout: 10000 }).toString().trim());
    }
    finally {
        try {
            unlinkSync(tmpScript);
        }
        catch { /* ignore */ }
    }
}
describe('gyoshu bridge advertised scientific modules (#3682)', () => {
    it('never prebinds numpy, pandas, or matplotlib in the execution namespace', () => {
        const result = runBridgeLifecycle('total = sum([1, 2, 3])');
        expect(result.initialScientific).toEqual([]);
        expect(result.scientificAfterSeed).toEqual([]);
        expect(result.scientificAfterReset).toEqual([]);
    });
    it('persists user variables across calls and clears them on reset', () => {
        const result = runBridgeLifecycle('total = sum([1, 2, 3])');
        expect(result.seedSuccess).toBe(true);
        expect(result.seedStdout.trim()).toBe('');
        expect(result.variablesAfterSeed).toEqual(['total']);
        expect(result.resetStatus).toBe('reset');
        expect(result.variablesAfterReset).toEqual([]);
    });
    it('leaves the advertised modules unreachable after reset while the positive control still runs', () => {
        const result = runBridgeLifecycle('print(sum([1, 2, 3]))');
        expect(result.seedSuccess).toBe(true);
        expect(result.seedStdout.trim()).toBe('6');
        expect(result.postResetSuccess).toBe(false);
        expect(result.postResetErrorType).toBe('NameError');
        expect(result.postResetError).toContain('numpy');
    });
});
//# sourceMappingURL=python-sandbox.test.js.map