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

// Helper: test sandbox import blocking by extracting only the relevant constants
// from gyoshu_bridge.py using AST parsing, avoiding full module initialization.
function executePythonInSandbox(code: string): string {
  const bridgePath = new URL('../../../../bridge/gyoshu_bridge.py', import.meta.url).pathname;
  const tmpScript = join(tmpdir(), `omc-sandbox-test-${Date.now()}.py`);
  const escapedBridgePath = JSON.stringify(bridgePath);
  const escapedCode = JSON.stringify(code);
  const lines = [
    'import ast, builtins',
    `_src = open(${escapedBridgePath}).read()`,
    '_tree = ast.parse(_src)',
    '_globals = {"__builtins__": builtins, "frozenset": frozenset}',
    'for _node in _tree.body:',
    '    if isinstance(_node, ast.Assign):',
    '        _targets = [t.id for t in _node.targets if isinstance(t, ast.Name)]',
    '        for _n in _targets:',
    '            if _n in ("SANDBOX_BLOCKED_MODULES", "SANDBOX_BLOCKED_BUILTINS", "_original_import"):',
    '                exec(compile(ast.Module(body=[_node], type_ignores=[]), "<bridge>", "exec"), _globals)',
    '    elif isinstance(_node, ast.FunctionDef):',
    '        if _node.name == "_sandbox_import":',
    '            exec(compile(ast.Module(body=[_node], type_ignores=[]), "<bridge>", "exec"), _globals)',
    '_sandbox_import = _globals["_sandbox_import"]',
    '_blocked = _globals["SANDBOX_BLOCKED_BUILTINS"]',
    'import builtins as _b',
    '_safe = {k: v for k, v in vars(_b).items() if k not in _blocked}',
    '_safe["__import__"] = _sandbox_import',
    'ns = {"__builtins__": _safe}',
    'try:',
    `    exec(compile(${escapedCode}, "<sandbox>", "exec"), ns)`,
    '    print("ok")',
    'except ImportError as e:',
    '    print(str(e))',
    'except Exception as e:',
    '    print(f"error: {e}")',
  ];
  writeFileSync(tmpScript, lines.join('\n'), 'utf-8');
  try {
    return execSync(`python3 ${tmpScript}`, { timeout: 10000 }).toString().trim();
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    return (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
  } finally {
    try { unlinkSync(tmpScript); } catch { /* ignore */ }
  }
}

describe('python-repl sandbox blocked modules (bypass prevention)', () => {
  it('should block importlib (bypass prevention)', () => {
    const result = executePythonInSandbox('import importlib');
    expect(result).toContain('blocked in sandbox mode');
  });

  it('should block sys module access', () => {
    const result = executePythonInSandbox('import sys');
    expect(result).toContain('blocked in sandbox mode');
  });

  it('should block io module', () => {
    const result = executePythonInSandbox('import io');
    expect(result).toContain('blocked in sandbox mode');
  });

  it('should block pathlib module', () => {
    const result = executePythonInSandbox('import pathlib');
    expect(result).toContain('blocked in sandbox mode');
  });

  it('should block signal module', () => {
    const result = executePythonInSandbox('import signal');
    expect(result).toContain('blocked in sandbox mode');
  });

  it('should block "from importlib import import_module" bypass', () => {
    const result = executePythonInSandbox('from importlib import import_module');
    expect(result).toContain('blocked in sandbox mode');
  });

  it('should block __import__("os") bypass via builtins removal', () => {
    // __import__ is replaced with _sandbox_import in the sandbox namespace,
    // so __import__("os") goes through the blocking hook
    const result = executePythonInSandbox('__import__("os")');
    expect(result).toContain('blocked in sandbox mode');
  });

  it('should block dotted submodule imports (http.server)', () => {
    const result = executePythonInSandbox('import http.server');
    expect(result).toContain('blocked in sandbox mode');
  });

  it('should block "from http.server import HTTPServer" bypass', () => {
    const result = executePythonInSandbox('from http.server import HTTPServer');
    expect(result).toContain('blocked in sandbox mode');
  });

  it('should block xmlrpc.server submodule import', () => {
    const result = executePythonInSandbox('import xmlrpc.server');
    expect(result).toContain('blocked in sandbox mode');
  });

  it('should block "from http import server" fromlist bypass', () => {
    const result = executePythonInSandbox('from http import server');
    expect(result).toContain('blocked in sandbox mode');
  });

  it('should block "from xmlrpc import server" fromlist bypass', () => {
    const result = executePythonInSandbox('from xmlrpc import server');
    expect(result).toContain('blocked in sandbox mode');
  });

  it('should allow non-blocked submodules (http.client)', () => {
    const result = executePythonInSandbox('import http.client');
    expect(result).toBe('ok');
  });
});

describe('python-repl sandbox bridge startup integration', () => {
  it('should load bridge with OMC_PYTHON_SANDBOX=1 and block os in sandbox namespace', () => {
    const bridgePath = new URL('../../../../bridge/gyoshu_bridge.py', import.meta.url).pathname;
    const tmpScript = join(tmpdir(), `omc-sandbox-bridge-${Date.now()}.py`);
    const escapedPath = JSON.stringify(bridgePath);
    // Load bridge as a module (not exec) with sandbox enabled,
    // then verify code in sandbox namespace can't import os
    const script = [
      'import os, importlib.util',
      'os.environ["OMC_PYTHON_SANDBOX"] = "1"',
      `spec = importlib.util.spec_from_file_location("gyoshu_bridge", ${escapedPath})`,
      'mod = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(mod)',
      '# Verify sandbox namespace blocks dangerous imports',
      'ns = mod.get_sandbox_namespace()',
      'try:',
      '    exec("import os", ns)',
      '    print("FAIL: os imported in sandbox")',
      'except ImportError as e:',
      '    print(f"PASS: {e}")',
    ].join('\n');
    writeFileSync(tmpScript, script, 'utf-8');
    try {
      const result = execSync(`python3 ${tmpScript} 2>&1`, { timeout: 10000 }).toString().trim();
      expect(result).toContain('PASS:');
      expect(result).toContain('blocked in sandbox mode');
    } finally {
      try { unlinkSync(tmpScript); } catch { /* ignore */ }
    }
  });
});
