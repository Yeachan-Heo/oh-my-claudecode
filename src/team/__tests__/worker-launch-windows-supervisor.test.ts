import { execFileSync } from 'node:child_process';
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
