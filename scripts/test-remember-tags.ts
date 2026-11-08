import { tmpdir } from 'os';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

// Create test directory
const testDir = join(tmpdir(), `remember-tag-test-${Date.now()}`);
const omcDir = join(testDir, '.omc');
mkdirSync(omcDir, { recursive: true });

console.log('Testing remember tag processing in post-tool-verifier.mjs\n');

// Helper to run the post-tool-verifier
async function runHook(input: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [
      join(import.meta.dirname, 'post-tool-verifier.mjs')
    ], {
      cwd: testDir
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

// Test 1: Regular remember tag
console.log('Test 1: Regular <remember> tag');
try {
  const input1 = {
    toolName: 'Task',
    toolOutput: 'Agent completed task.\n<remember>This project uses pnpm</remember>\nDone.',
    sessionId: 'test-session',
    directory: testDir
  };

  await runHook(input1);

  const notepadPath = join(omcDir, 'notepad.md');
  if (existsSync(notepadPath)) {
    const content = readFileSync(notepadPath, 'utf-8');
    if (content.includes('pnpm') && content.includes('Working Memory')) {
      console.log('✓ PASS: Regular remember tag saved to Working Memory\n');
    } else {
      console.log('✗ FAIL: Remember tag not saved correctly');
      console.log('Content:', content.slice(0, 200));
    }
  } else {
    console.log('✗ FAIL: notepad.md not created\n');
  }
} catch (err) {
  console.log('✗ FAIL:', (err as Error).message);
}

// Test 2: Priority remember tag
console.log('Test 2: Priority <remember priority> tag');
try {
  const input2 = {
    toolName: 'Task',
    toolOutput: '<remember priority>API endpoint is /api/v2</remember>',
    sessionId: 'test-session',
    directory: testDir
  };

  await runHook(input2);

  const notepadPath = join(omcDir, 'notepad.md');
  const content = readFileSync(notepadPath, 'utf-8');
  if (content.includes('API endpoint') && content.includes('Priority Context')) {
    console.log('✓ PASS: Priority remember tag saved to Priority Context\n');
  } else {
    console.log('✗ FAIL: Priority tag not saved correctly');
    console.log('Content:', content.slice(0, 300));
  }
} catch (err) {
  console.log('✗ FAIL:', (err as Error).message);
}

// Test 3: Non-Task tool should not process tags
console.log('Test 3: Non-Task tool should not process tags');
try {
  // Clean up first
  rmSync(testDir, { recursive: true });
  mkdirSync(omcDir, { recursive: true });

  const input3 = {
    toolName: 'Bash',
    toolOutput: '<remember>Should not be saved</remember>',
    sessionId: 'test-session',
    directory: testDir
  };

  await runHook(input3);

  const notepadPath = join(omcDir, 'notepad.md');
  if (!existsSync(notepadPath)) {
    console.log('✓ PASS: Bash tool did not trigger remember tag processing\n');
  } else {
    console.log('✗ FAIL: Bash tool incorrectly triggered remember processing\n');
  }
} catch (err) {
  console.log('✗ FAIL:', (err as Error).message);
}

// Clean up
rmSync(testDir, { recursive: true });
console.log('All tests completed.');
