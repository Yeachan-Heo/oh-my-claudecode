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
    } else {
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

function executeBridgeCode(code: string, sandboxEnv = false): { success: boolean; stdout: string; error?: { type: string; message: string } } {
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
  } finally {
    try { unlinkSync(tmpScript); } catch { /* ignore */ }
  }
}

describe('gyoshu bridge execution builtins hardening', () => {
  it('allows normal calculation, printing, and persistent variables', () => {
    const result = executeBridgeCode('x = sum(range(5))\nprint(f"x={x}")');
    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('x=10');
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
});
