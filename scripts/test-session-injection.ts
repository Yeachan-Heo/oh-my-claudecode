import { tmpdir } from 'os';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// Create test notepad
const testDir = join(tmpdir(), `session-test-${Date.now()}`);
const omcDir = join(testDir, '.omc');
mkdirSync(omcDir, { recursive: true });

const notepadContent = `# Notepad

## Priority Context
Project uses pnpm not npm
API client at src/api/client.ts

## Working Memory

### 2026-01-19 12:00
Some working memory entry

## MANUAL
User notes here
`;

writeFileSync(join(omcDir, 'notepad.md'), notepadContent);

// Test priority context extraction (mimics session-start.mjs logic)
const content = readFileSync(join(omcDir, 'notepad.md'), 'utf-8');
const priorityMatch = content.match(/## Priority Context\n([\s\S]*?)(?=\n## [^#]|$)/);
const cleanContent = priorityMatch ? priorityMatch[1].replace(/<!--[\s\S]*?-->/g, '').trim() : '';

// Verify extraction
if (cleanContent.includes('pnpm') && cleanContent.includes('API client')) {
  console.log('✓ PASS: Priority Context extracted correctly');
} else {
  console.log('✗ FAIL: Priority Context not extracted');
  console.log('Got:', cleanContent);
}

// Clean up
rmSync(testDir, { recursive: true });
