import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

    expect(source).toContain("if ($app -match '\\.(cmd|bat)[. ]*$') { [O]::RequireBatchProvider($app); $providerLine = [O]::BuildCmdLine($argv); $app = Join-Path ([Environment]::SystemDirectory) 'cmd.exe';");
    expect(source).toContain(`$cmd = '"' + $app + '" /d /v:off /s /c "set "_OMC_PROVIDER_LINE=" & %_OMC_PROVIDER_LINE%"' } else { $cmd = [O]::BuildCommandLine($argv) }`);
    expect(source).toContain("Where-Object { $_.Name -ne '_OMC_PROVIDER_LINE' -and $_.Name -ne 'NoDefaultCurrentDirectoryInExePath' }");
    expect(source).toContain("$envPairs += [pscustomobject]@{ Name = 'NoDefaultCurrentDirectoryInExePath'; Value = '1' }; if ($null -ne $providerLine) {");
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

  // Runs the supervisor's own launch lines, then CreateProcessW exactly as the
  // supervisor does minus the console handles a test runner does not have.
  // The provider environment is only what the payload carries, so the test
  // host's own NoDefaultCurrentDirectoryInExePath never leaks in.
  function runLaunchLines(payload: { provider_argv: string[]; provider_env: Record<string, string>; cwd: string }): void {
    const source = buildWindowsSupervisorSource();
    const lines = source.split('\n');
    const launchLines = ['  $argv = ', '  if ($app -match ', '  $envPairs = '].map(prefix => lines.find(candidate => candidate.startsWith(prefix))!);
    const harnessInput = JSON.stringify({ source, launchLines, payload });
    const harness = String.raw`
$ErrorActionPreference = 'Stop'
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($in.source, [ref]$tokens, [ref]$errors)
$commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-Type' }, $true))
Invoke-Expression $commands[0].Extent.Text
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class H {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct SI { public int cb; public IntPtr r; public IntPtr d; public IntPtr t; public int x; public int y; public int xs; public int ys; public int xc; public int yc; public int fa; public int f; public short sw; public short r2; public IntPtr r3; public IntPtr i; public IntPtr o; public IntPtr e; }
  [StructLayout(LayoutKind.Sequential)] public struct PI { public IntPtr hProcess; public IntPtr hThread; public uint pid; public uint tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref SI si, out PI pi);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
}
"@
$payload = $in.payload
foreach ($line in $in.launchLines) { Invoke-Expression $line }
$si = New-Object H+SI; $si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si); $pi = New-Object H+PI
if (-not [H]::CreateProcessW($app, (New-Object Text.StringBuilder $cmd), [IntPtr]::Zero, [IntPtr]::Zero, $false, 0x08000400, $envPtr, $payload.cwd, [ref]$si, [ref]$pi)) { throw 'create_process_failed' }
[H]::WaitForSingleObject($pi.hProcess, 30000) | Out-Null
`;
    execFileSync(
      join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(harness, 'utf16le').toString('base64')],
      { input: harnessInput, encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    );
  }

  const minimalPath = () => `${dirname(process.execPath)};${join(process.env.SystemRoot!, 'System32')}`;

  it.runIf(process.platform === 'win32')('runs the PATH node for an npm-style shim even when the cwd holds a planted node.cmd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omc-supervisor-cwd-'));
    try {
      const shimDir = join(root, 'npm');
      await mkdir(shimDir, { recursive: true });
      const shimPath = join(shimDir, 'codex.cmd');
      const outputPath = join(root, 'ran.txt');
      const canaryPath = join(root, 'planted.txt');
      // npm's cmd-shim falls back to a bare `node` when no node.exe sits beside it.
      await writeFile(shimPath, `@ECHO off\r\nSETLOCAL\r\nIF EXIST "%~dp0\\node.exe" (SET "_prog=%~dp0\\node.exe") ELSE (SET "_prog=node")\r\n"%_prog%" -e "require('fs').writeFileSync(process.argv[1],'real')" %*\r\n`, 'utf8');
      await writeFile(join(root, 'node.cmd'), `@echo off\r\necho planted>"${canaryPath}"\r\n`, 'utf8');
      runLaunchLines({ provider_argv: [shimPath, outputPath], provider_env: { SystemRoot: process.env.SystemRoot!, PATH: minimalPath() }, cwd: root });
      expect(existsSync(canaryPath)).toBe(false);
      expect(await readFile(outputPath, 'utf8')).toBe('real');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 65_000);

  it.runIf(process.platform === 'win32')('keeps a cmd.exe child of an .exe provider from running a git.cmd planted in the cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omc-supervisor-child-cmd-'));
    try {
      const canaryPath = join(root, 'planted.txt');
      const donePath = join(root, 'done.txt');
      await writeFile(join(root, 'git.cmd'), `@echo off\r\necho cmd>"${canaryPath}"\r\n`, 'utf8');
      const cmdPath = join(process.env.SystemRoot!, 'System32', 'cmd.exe');
      const script = `const cp=require('child_process');cp.spawnSync(${JSON.stringify(cmdPath)},['/d','/c','git']);require('fs').writeFileSync(${JSON.stringify(donePath)},'done')`;
      runLaunchLines({ provider_argv: [process.execPath, '-e', script], provider_env: { SystemRoot: process.env.SystemRoot!, PATH: minimalPath() }, cwd: root });
      expect(await readFile(donePath, 'utf8')).toBe('done');
      expect(existsSync(canaryPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 65_000);

  // libuv 1.48+ (Node 21.7+/22+) skips the cwd when the spawning process's own env sets
  // NoDefaultCurrentDirectoryInExePath, which the supervisor gives the provider. libuv 1.46
  // (Node 20) ignores the variable, so there the plant still runs: the known gap from #4746.
  const [uvMajor, uvMinor] = process.versions.uv.split('.').map(Number);
  const libuvHonorsNoCwdSearch = uvMajor > 1 || uvMinor >= 48;
  it.runIf(process.platform === 'win32')('keeps a libuv bare-name spawn from a provider child from running a git.exe planted in the cwd (libuv 1.48+)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omc-supervisor-child-exe-'));
    try {
      const canaryPath = join(root, 'planted.txt');
      const donePath = join(root, 'done.txt');
      const plant = `require('fs').writeFileSync(${JSON.stringify(canaryPath)},'exe')`;
      // A copy of node.exe named git.exe runs the -e script the child hands it. A hard
      // link would share the running test runner's image, which Windows refuses to unlink.
      await copyFile(process.execPath, join(root, 'git.exe'));
      const script = `require('child_process').spawnSync('git',['-e',${JSON.stringify(plant)}]);require('fs').writeFileSync(${JSON.stringify(donePath)},'done')`;
      runLaunchLines({ provider_argv: [process.execPath, '-e', script], provider_env: { SystemRoot: process.env.SystemRoot!, PATH: minimalPath() }, cwd: root });
      expect(await readFile(donePath, 'utf8')).toBe('done');
      expect(existsSync(canaryPath)).toBe(!libuvHonorsNoCwdSearch);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 65_000);

  it.runIf(process.platform === 'win32')('sets NoDefaultCurrentDirectoryInExePath for every launch even when the provider clears it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omc-supervisor-nodefault-'));
    try {
      const shimPath = join(root, 'provider.cmd');
      await writeFile(shimPath, `@echo off\r\n>"%~1" echo [%NoDefaultCurrentDirectoryInExePath%]\r\n`, 'utf8');
      const batchOut = join(root, 'batch.txt');
      const exeOut = join(root, 'exe.txt');
      const providerEnv = { SystemRoot: process.env.SystemRoot!, PATH: minimalPath(), nodefaultcurrentdirectoryinexepath: '' };
      runLaunchLines({ provider_argv: [shimPath, batchOut], provider_env: providerEnv, cwd: root });
      runLaunchLines({ provider_argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(exeOut)},String(process.env.NoDefaultCurrentDirectoryInExePath))`], provider_env: providerEnv, cwd: root });
      expect((await readFile(batchOut, 'utf8')).trim()).toBe('[1]');
      expect(await readFile(exeOut, 'utf8')).toBe('1');
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
foreach ($app in @('codex.cmd', '.\codex.cmd', 'C:codex.cmd', '\codex.bat', ($env:SystemRoot + '\System32\omc-nonexistent-provider.cmd'))) {
  try { [O]::RequireBatchProvider($app); throw 'Unqualified batch provider was not rejected' }
  catch { if ($_.Exception.InnerException -isnot [ArgumentException] -or $_.Exception.InnerException.Message -ne 'worker_launch_provider_executable_invalid') { throw } }
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
