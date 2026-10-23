import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildWindowsSupervisorSource } from '../worker-launch-ack.js';

describe('generated Windows worker supervisor', () => {
  it('keeps PowerShell line endings and C# literals valid across JavaScript generation', () => {
    const source = buildWindowsSupervisorSource();

    expect(source).toContain('\n');
    expect(source).not.toContain('`n');
    expect(source).toContain(String.raw`if (c == '\\')`);
    expect(source).toContain('[uint32]::MaxValue');
    expect(source).not.toContain('[uint32]0xffffffff');
    expect(source).toContain('[O]::ReadLineAsync()');
    expect(source).toContain('Task.Run(() => Console.In.ReadLine())');
    expect(source).not.toContain('[Console]::In.ReadLineAsync()');
    expect(source).toContain('CreateFileW("CONIN$",');
    expect(source).toContain('CreateFileW("CONOUT$",');
    expect(source).toContain('new IntPtr(0x20002)');
    expect(source).toContain('StartupInfo.hStdInput = input');
    expect(source).toContain('StartupInfo.hStdOutput = output');
    expect(source).toContain('true, 0x00000004 | 0x00000400 | 0x00080000');
    expect(source).toContain('exit_code=$exitCode');
  });

  it('routes a batch argv[0] through system cmd.exe with the line in the environment block', () => {
    const source = buildWindowsSupervisorSource();

    expect(source).toContain("if ($app -match '\\.(cmd|bat)[. ]*$') { $providerLine = [O]::BuildCmdLine($argv); $app = Join-Path ([Environment]::SystemDirectory) 'cmd.exe';");
    expect(source).toContain(`$cmd = '"' + $app + '" /d /v:off /s /c "set "_OMC_PROVIDER_LINE=" & %_OMC_PROVIDER_LINE%"' } else { $cmd = [O]::BuildCommandLine($argv) }`);
    expect(source).toContain("Where-Object { $_.Name -ne '_OMC_PROVIDER_LINE' }");
    expect(source).toContain('[O]::CreateConsoleProcess($app, $cmd, $envPtr, $payload.cwd, [ref]$pi)');
    expect(source).toContain(`if (c < ' ') throw new ArgumentException("worker_launch_provider_argv_invalid")`);
    expect(source).toContain('if (b.Length > 8000) throw new ArgumentException("worker_launch_provider_argv_too_long")');
  });

  it.runIf(process.platform === 'win32')('runs a batch provider through the generated launch lines without cmd reparsing its arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omc-supervisor-batch-'));
    try {
      const providerDir = join(root, 'bin (x86) åäö');
      await mkdir(providerDir, { recursive: true });
      const providerPath = join(providerDir, 'provider.cmd');
      const outputPath = join(root, 'argv.json');
      const canaryPath = join(root, 'injected.txt');
      await writeFile(providerPath, `@echo off\r\n"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1],JSON.stringify({argv:process.argv.slice(2),leaked:Object.keys(process.env).some(k=>k.toUpperCase().startsWith('_OMC_P'))}));process.exit(7)" %*\r\n`, 'utf8');
      const injection = `echo pwned>"${canaryPath}"`;
      const payload = [
        `--deny-tool=x" & ${injection} & rem "`, `a b & ${injection}`, `x\\" & ${injection} & \\"`, `"&${injection}`, `\\"&${injection}&rem \\"`,
        'hello world', 'say "hi"', '%USERPROFILE%', '%PATH:~0,1%', '100% ready', '!PATH!', '^', '', 'trail\\', 'åäö ü 漢字',
      ];
      const source = buildWindowsSupervisorSource();
      const lines = source.split('\n');
      const launchLines = ['  $argv = ', '  if ($app -match ', '  $envPairs = '].map(prefix => {
        const line = lines.find(candidate => candidate.startsWith(prefix));
        expect(line).toBeTruthy();
        return line!;
      });
      // The supervisor's own launch lines build $app, $cmd and the environment
      // block; the harness then calls CreateProcessW exactly as the supervisor
      // does, minus the console handles a test runner does not have. A
      // case-variant pre-set line variable and a hostile ComSpec are ignored.
      const harnessInput = JSON.stringify({
        source,
        launchLines,
        payload: {
          provider_argv: [providerPath, outputPath, ...payload],
          provider_env: { SystemRoot: process.env.SystemRoot, _omc_provider_line: injection, ComSpec: process.execPath },
          cwd: root,
        },
      }).replace(/[\u0080-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
      const harness = String.raw`
$ErrorActionPreference = 'Stop'
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($in.source, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw (($errors | ForEach-Object { $_.Message }) -join '; ') }
$commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-Type' }, $true))
Invoke-Expression $commands[0].Extent.Text
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class H {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct SI { public int cb; public IntPtr r; public IntPtr d; public IntPtr t; public int x; public int y; public int xs; public int ys; public int xc; public int yc; public int fa; public int f; public short sw; public short r2; public IntPtr r3; public IntPtr i; public IntPtr o; public IntPtr e; }
  [StructLayout(LayoutKind.Sequential)] public struct PI { public IntPtr hProcess; public IntPtr hThread; public uint pid; public uint tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref SI si, out PI pi);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
}
"@
$payload = $in.payload
foreach ($line in $in.launchLines) { Invoke-Expression $line }
$si = New-Object H+SI; $si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si); $pi = New-Object H+PI
if (-not [H]::CreateProcessW($app, (New-Object Text.StringBuilder $cmd), [IntPtr]::Zero, [IntPtr]::Zero, $false, 0x08000400, $envPtr, $payload.cwd, [ref]$si, [ref]$pi)) { throw 'create_process_failed' }
[H]::WaitForSingleObject($pi.hProcess, 30000) | Out-Null
$code = [uint32]0; [H]::GetExitCodeProcess($pi.hProcess, [ref]$code) | Out-Null
$rejections = @(@('a', ('x' + [char]0x1A + 'y')), @('a', ('A' * 8000))) | ForEach-Object { try { [O]::BuildCmdLine([string[]]$_) | Out-Null; 'accepted' } catch { $_.Exception.InnerException.Message } }
@{ app = $app; exit = $code; rejections = $rejections } | ConvertTo-Json -Compress
`;
      const output = execFileSync(
        join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(harness, 'utf16le').toString('base64')],
        { input: harnessInput, encoding: 'utf8', windowsHide: true, timeout: 60_000 },
      );
      const result = JSON.parse(output.trim()) as { app: string; exit: number; rejections: string[] };
      expect(result.app.toLowerCase()).toBe(join(process.env.SystemRoot!, 'System32', 'cmd.exe').toLowerCase());
      expect(result.exit).toBe(7);
      expect(result.rejections).toEqual(['worker_launch_provider_argv_invalid', 'worker_launch_provider_argv_too_long']);
      expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual({ argv: payload, leaked: false });
      expect(existsSync(canaryPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 65_000);

  it.runIf(process.platform === 'win32')('compiles in PowerShell 5.1 and rejects unresolved or non-executable providers', () => {
    // Parse the actual generated script, then execute only its Add-Type command.
    // This catches both script delimiters and layered C# escaping without
    // running the authority protocol or spawning a provider.
    const harness = String.raw`
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Expected Windows PowerShell 5.1' }
$source = [Console]::In.ReadToEnd()
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw (($errors | ForEach-Object { $_.Message }) -join '; ') }
$commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-Type' }, $true))
if ($commands.Count -ne 1) { throw 'Expected exactly one embedded Add-Type command' }
Invoke-Expression $commands[0].Extent.Text
$invalidProviders = @('codex', '.\codex.exe', 'C:codex.exe', '\codex.exe', ($env:SystemRoot + '\System32\codex.cmd'), ($env:SystemRoot + '\System32\codex'), ($env:SystemRoot + '\System32\omc-nonexistent-provider.exe'))
foreach ($app in $invalidProviders) {
  $pi = New-Object O+PROCESS_INFORMATION
  $rejected = $false
  try { [O]::CreateConsoleProcess($app, $app, [IntPtr]::Zero, $env:SystemRoot, [ref]$pi) }
  catch {
    if ($_.Exception.InnerException -isnot [ArgumentException] -or $_.Exception.InnerException.Message -ne 'worker_launch_provider_executable_invalid') { throw }
    $rejected = $true
  }
  if (-not $rejected -or $pi.hProcess -ne [IntPtr]::Zero) { throw 'Invalid provider was not rejected before native process creation' }
}
[O]::BuildCommandLine([string[]]@('', 'plain', 'space value', 'a"b', 'C:\dir with space\')) | ConvertTo-Json -Compress
`;
    const output = execFileSync(
      join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(harness, 'utf16le').toString('base64')],
      { input: buildWindowsSupervisorSource(), encoding: 'utf8', windowsHide: true, timeout: 30_000 },
    );
    expect(JSON.parse(output.trim())).toBe(String.raw`"" "plain" "space value" "a\"b" "C:\dir with space\\"`);
  }, 35_000);
});
