# Live-Data Command Execution Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent single-line live-data directives and substituted slash-command arguments from escaping an allowlisted executable into shell command execution.

**Architecture:** Parse each single-line directive once into an executable and argument vector, authorize the parsed executable plus the original command text, and invoke it with `execFileSync` without a shell. Keep multi-line script blocks on their existing explicit shell path and keep cache/display keys based on the original command string.

**Tech Stack:** TypeScript, Node.js `child_process`, Vitest, npm, ESLint, esbuild.

## Global Constraints

- Base feature work on `upstream/dev`; the repository contribution guide targets feature PRs to `dev`.
- Add no production dependency.
- Use TDD: every production behavior change must be preceded by a test that fails for the expected reason.
- Keep multi-line live-data script-block behavior unchanged.
- Preserve caching, conditions, output formatting, HTML escaping, timeout, and output-size behavior.
- Use English for file names, documentation, tests, and code comments.
- Do not commit generated `dist/` or `bridge/` artifacts in an ordinary PR; build them for verification, then restore them as required by `CONTRIBUTING.md`.
- Keep the PR limited to the live-data command-execution vulnerability.

---

## File Structure

- Modify `src/hooks/auto-slash-command/live-data.ts`: add the shell-free parser, pass the parsed executable into policy checks, and replace single-line `execSync` with `execFileSync`.
- Modify `src/__tests__/live-data.test.ts`: add injection/parser regressions and update ordinary single-line expectations to the shell-free process API while preserving script-block expectations on `execSync`.
- Create `src/__tests__/auto-slash-live-data-security.test.ts`: prove that `$ARGUMENTS` substitution cannot introduce a second command through a project-local slash command.
- Verify but do not commit generated changes beneath `dist/` and `bridge/`.

### Task 1: Secure single-line live-data execution

**Files:**

- Modify: `src/hooks/auto-slash-command/live-data.ts`
- Modify: `src/__tests__/live-data.test.ts`
- Create: `src/__tests__/auto-slash-live-data-security.test.ts`
- Reference: `docs/superpowers/specs/2026-08-12-live-data-command-execution-hardening-design.md`

**Interfaces:**

- Consumes: the existing `SecurityPolicy`, `ParsedDirective`, `resolveLiveData(content: string): string`, and `executeSlashCommand(parsed: ParsedSlashCommand): ExecuteResult` contracts.
- Produces internally: `ParsedCommandInvocation`, `CommandParseResult`, and `parseCommandInvocation(command: string): CommandParseResult`.
- Preserves publicly: `resolveLiveData`, `isLiveDataLine`, `clearCache`, and `resetSecurityPolicy` signatures.

- [ ] **Step 1: Rebase the documentation commits onto the current development branch**

Add the canonical upstream remote if it is absent, fetch it, and rebase the feature branch before implementation:

```bash
git remote add upstream https://github.com/Yeachan-Heo/oh-my-claudecode.git  # only when absent
git fetch upstream dev
git rebase upstream/dev
```

Expected: `git merge-base --is-ancestor upstream/dev HEAD` exits 0, and the two design commits remain on `fix/live-data-command-injection`.

- [ ] **Step 2: Install the reviewed dependency graph and establish a clean baseline**

Run:

```bash
npm ci
npm run test:run -- src/__tests__/live-data.test.ts src/__tests__/auto-slash-aliases.test.ts
```

Expected: dependency installation succeeds and the existing targeted tests pass before the new regression tests are added. If the baseline fails, stop and investigate rather than attributing failures to this change.

- [ ] **Step 3: Add failing shell-control regression tests**

In `src/__tests__/live-data.test.ts`, add a table-driven test under `resolveLiveData - security`:

```ts
it.each([
  ['semicolon', 'git status; node -e "process.exit(99)"'],
  ['background', 'git status & node -e "process.exit(99)"'],
  ['and', 'git status && node -e "process.exit(99)"'],
  ['or', 'git status || node -e "process.exit(99)"'],
  ['pipe', 'git status | node -e "process.exit(99)"'],
  ['input redirect', 'git status < secrets.txt'],
  ['output redirect', 'git status > stolen.txt'],
  ['carriage return', 'git status\rnode -e "process.exit(99)"'],
  ['backticks', 'git status `node -e "process.exit(99)"`'],
  ['command substitution', 'git status $(node -e "process.exit(99)")'],
])('blocks %s shell syntax before process execution', (_name, command) => {
  setupPolicy({ allowed_commands: ['git'] });

  const result = resolveLiveData(`!${command}`);

  expect(result).toContain('error="true"');
  expect(result).toContain('blocked:');
  expect(mockedExecSync).not.toHaveBeenCalled();
  expect(mockedExecFileSync).not.toHaveBeenCalled();
});
```

Add malformed-input cases:

```ts
it.each([
  ['unterminated single quote', "echo 'unterminated"],
  ['unterminated double quote', 'echo "unterminated'],
  ['trailing escape', 'echo trailing\\'],
])('fails closed for %s', (_name, command) => {
  setupPolicy({ allowed_commands: ['echo'] });
  const result = resolveLiveData(`!${command}`);
  expect(result).toContain('error="true"');
  expect(mockedExecSync).not.toHaveBeenCalled();
  expect(mockedExecFileSync).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Add a failing `$ARGUMENTS` end-to-end regression test**

Create `src/__tests__/auto-slash-live-data-security.test.ts` with an isolated project command and real policy files:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as childProcess from 'child_process';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
    execFileSync: vi.fn(),
  };
});

const mockedExecSync = vi.mocked(childProcess.execSync);
const mockedExecFileSync = vi.mocked(childProcess.execFileSync);
const originalCwd = process.cwd();
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
let projectDir: string;
let configDir: string;

describe('auto slash live-data security', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    projectDir = join(tmpdir(), `omc-live-data-project-${process.pid}-${Date.now()}`);
    configDir = join(tmpdir(), `omc-live-data-config-${process.pid}-${Date.now()}`);
    mkdirSync(join(projectDir, '.claude', 'commands'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(projectDir, '.claude', 'commands', 'live-test.md'),
      '---\ndescription: Security regression fixture\n---\n!git status $ARGUMENTS\n',
    );
    writeFileSync(
      join(projectDir, '.claude', 'live-data-policy.json'),
      JSON.stringify({ allowed_commands: ['git'] }),
    );
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('blocks shell syntax introduced through $ARGUMENTS', async () => {
    const { executeSlashCommand } = await import('../hooks/auto-slash-command/executor.js');

    const result = executeSlashCommand({
      command: 'live-test',
      args: '; node -e "process.exit(99)"',
      raw: '/live-test ; node -e "process.exit(99)"',
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('error="true"');
    expect(result.replacementText).toContain('blocked:');
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run the new tests and verify RED**

Run:

```bash
npm run test:run -- src/__tests__/live-data.test.ts src/__tests__/auto-slash-live-data-security.test.ts
```

Expected: the new injection tests fail because `execSync` executes the complete shell string. Confirm the failure is behavioral—not a fixture, import, or syntax error—before writing production code.

- [ ] **Step 6: Add the minimal shell-free parser**

In `src/hooks/auto-slash-command/live-data.ts`, remove `WHITESPACE_SPLIT_PATTERN` and add these internal result types near the other types:

```ts
interface ParsedCommandInvocation {
  executable: string;
  args: string[];
}

type CommandParseResult =
  | { ok: true; invocation: ParsedCommandInvocation }
  | { ok: false; reason: string };
```

Add `parseCommandInvocation(command: string): CommandParseResult` before the security-policy functions. Implement one left-to-right state machine with:

```ts
let quote: 'single' | 'double' | null = null;
let escaped = false;
let tokenStarted = false;
let token = '';
const tokens: string[] = [];
```

For each character:

1. Treat unquoted space and tab as token boundaries.
2. Preserve characters inside single quotes literally until the closing quote.
3. In double quotes, support backslash escaping but reject backticks and `$(`.
4. Outside quotes, support backslash escaping; reject backticks, `$(`, and any character in `;&|<>`.
5. Reject ASCII control characters other than an unquoted delimiter tab.
6. Track `tokenStarted` so `''` and `""` produce an empty argument.
7. At EOF, reject a pending escape or open quote, flush the final token, and reject an empty token list.

Return stable reasons such as `empty command`, `unterminated single quote`, `unterminated double quote`, `trailing escape`, `control character rejected`, `command substitution rejected`, or `shell operator rejected: ;`.

- [ ] **Step 7: Authorize the parsed executable instead of a whitespace prefix**

Change the security helper to accept the parsed executable:

```ts
function checkSecurity(
  command: string,
  executable: string,
): { allowed: boolean; reason?: string } {
  const policy = loadSecurityPolicy();
  // denied_patterns continue to inspect command
  // denied_commands and allowed_commands compare executable
}
```

Keep `allowed_patterns` and `denied_patterns` on the original command string and retain the existing `safe-regex` checks. For multi-line script blocks, call `checkSecurity(block.shell, block.shell)` so their behavior remains unchanged.

- [ ] **Step 8: Replace single-line shell execution with `execFileSync`**

Change the single-line executor to consume the parsed invocation:

```ts
function executeCommand(
  invocation: ParsedCommandInvocation,
): { stdout: string; error: boolean } {
  try {
    const stdout = execFileSync(invocation.executable, invocation.args, {
      shell: false,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES + 1024,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // retain the existing truncation logic
  } catch (err: unknown) {
    // retain the existing stderr/message handling
  }
}
```

In `resolveLiveData`, parse `directive.command` before `checkSecurity`. On parse failure, emit the existing escaped blocked-result shape and continue. On success, retain the parsed invocation and pass it to every `executeCommand` branch. Do not reparse per cache/condition branch.

- [ ] **Step 9: Update existing single-line test expectations without changing script-block coverage**

For ordinary single-line tests, return output from `mockedExecFileSync` and assert executable plus argv, for example:

```ts
mockedExecFileSync.mockReturnValue('hello world\n');
const result = resolveLiveData('!echo hello');
expect(result).toBe('<live-data command="echo hello">hello world\n</live-data>');
expect(mockedExecFileSync).toHaveBeenCalledWith(
  'echo',
  ['hello'],
  expect.objectContaining({ shell: false, timeout: 10_000, windowsHide: true }),
);
expect(mockedExecSync).not.toHaveBeenCalled();
```

Add argv parsing coverage:

```ts
it('parses quoted, escaped, and empty arguments without a shell', () => {
  mockedExecFileSync.mockReturnValue('ok\n');
  resolveLiveData(`!echo "two words" 'literal $HOME' escaped\\ space ""`);
  expect(mockedExecFileSync).toHaveBeenCalledWith(
    'echo',
    ['two words', 'literal $HOME', 'escaped space', ''],
    expect.objectContaining({ shell: false }),
  );
});

it('keeps quoted shell metacharacters as literal argument data', () => {
  mockedExecFileSync.mockReturnValue('ok\n');
  resolveLiveData('!echo "; & | < >"');
  expect(mockedExecFileSync).toHaveBeenCalledWith(
    'echo',
    ['; & | < >'],
    expect.objectContaining({ shell: false }),
  );
});
```

Update the existing tag-injection test so `<`, `>`, and `&` occur inside one quoted argument; its purpose is markup escaping, not shell syntax. Keep all multi-line script tests on `mockedExecSync`, including the `input` body assertion.

- [ ] **Step 10: Run targeted tests and verify GREEN**

Run:

```bash
npm run test:run -- src/__tests__/live-data.test.ts src/__tests__/auto-slash-live-data-security.test.ts src/__tests__/auto-slash-aliases.test.ts
```

Expected: all targeted tests pass, single-line assertions use `execFileSync`, script-block assertions use `execSync`, and output contains no unexpected warnings.

- [ ] **Step 11: Refactor only after GREEN**

Remove duplicated blocked-result construction only if a tiny helper makes parser and policy failures clearer. Keep parsing, authorization, execution, and formatting as distinct functions. Do not extract a general shell library or change public exports.

Re-run the targeted test command after refactoring and require the same green result.

- [ ] **Step 12: Commit the implementation task**

Run:

```bash
git add src/hooks/auto-slash-command/live-data.ts \
  src/__tests__/live-data.test.ts \
  src/__tests__/auto-slash-live-data-security.test.ts
git commit -m "fix(security): harden live-data command execution"
```

Expected: one focused implementation commit containing source and tests, with no generated artifacts.

### Task 2: Verify repository integration and PR hygiene

**Files:**

- Verify: all source and test files from Task 1
- Temporarily generate, then restore: `dist/`, `bridge/`
- Modify only if a verification or independent review identifies a defect: Task 1 files

**Interfaces:**

- Consumes: the completed Task 1 commit and repository build scripts.
- Produces: fresh verification evidence and a review-ready branch with no generated-artifact delta.

- [ ] **Step 1: Run static checks and the full test suite**

Run:

```bash
npm run lint
npx tsc --noEmit
npm run test:run
```

Expected: all commands exit 0. Record exact test counts from Vitest output for the final report.

- [ ] **Step 2: Build and verify the shipped surface**

Run:

```bash
npm run build
npm run plugin:shipping:verify
```

Expected: both commands exit 0 and generated code contains the shell-free execution path.

- [ ] **Step 3: Restore ordinary-PR generated artifacts and confirm the source diff remains intact**

Run:

```bash
git restore dist/ bridge/
git status --short
git diff upstream/dev...HEAD --check
```

Expected: `dist/` and `bridge/` are absent from status; only the approved design/plan and Task 1 source/test commits differ from `upstream/dev`.

- [ ] **Step 4: Request an independent code and security review**

Provide the reviewer with:

```text
DESCRIPTION: Replaced shell-backed single-line live-data execution with parsed argv and execFileSync; added shell-operator and $ARGUMENTS regressions.
PLAN: docs/superpowers/plans/2026-08-12-live-data-command-execution-hardening-implementation-plan.md
BASE_SHA: upstream/dev
HEAD_SHA: current feature HEAD
```

Require the reviewer to verify spec compliance first, then inspect parser edge cases, process API use, pattern authorization, output escaping, and unchanged multi-line script behavior. Fix every Critical or Important finding using a new RED/GREEN cycle, then request review again.

- [ ] **Step 5: Run final fresh verification after all review fixes**

Run again on the exact tree to be pushed:

```bash
npm run lint
npx tsc --noEmit
npm run test:run
npm run build
npm run plugin:shipping:verify
git restore dist/ bridge/
git diff upstream/dev...HEAD --check
git status --short --branch
```

Expected: every command exits 0, generated artifacts are restored, and the worktree is clean.

- [ ] **Step 6: Prepare the PR**

Use title:

```text
fix(security): harden live-data command execution
```

The PR body must include:

```markdown
## Summary
- execute single-line live-data commands without a shell
- reject shell control syntax before policy authorization
- cover direct and `$ARGUMENTS`-based command injection

## Security impact
An `allowed_commands` entry previously authorized only the first token while `execSync` executed the complete string, allowing appended commands to run with the OMC process privileges.

## Testing
- `npm run lint`
- `npx tsc --noEmit`
- `npm run test:run`
- `npm run build`
- `npm run plugin:shipping:verify`
```

Push `fix/live-data-command-injection` to the contributor fork and create the PR against `Yeachan-Heo/oh-my-claudecode:dev`. Keep the working branch for review feedback.
