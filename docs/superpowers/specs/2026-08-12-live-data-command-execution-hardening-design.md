# Live-Data Command Execution Hardening Design

## Summary

The live-data command allowlist currently authorizes only the first whitespace-delimited token but executes the complete directive through a shell. A directive such as `!git status; attacker-command` therefore passes an `allowed_commands: ["git"]` policy and executes both commands. Slash-command `$ARGUMENTS` substitution can introduce the same payload into an otherwise trusted command template.

This change makes every single-line live-data directive shell-free. It parses an authorized directive into an executable and argument vector, then invokes `execFileSync` without a shell. Shell control syntax is rejected before authorization or execution.

## Goals

- Prevent shell-command injection through live-data directives and substituted slash-command arguments.
- Preserve ordinary live-data commands, quoted arguments, caching, conditions, output formatting, and existing security-policy fields.
- Fail closed on malformed quoting, shell control operators, command substitution, and control characters.
- Add no production dependency.
- Keep the patch focused on the confirmed live-data vulnerability.

## Non-Goals

- Changing multi-line live-data script-block behavior. Script blocks explicitly authorize and invoke a shell interpreter and remain outside this focused fix.
- Fixing the separately identified team-state path traversal, project-memory isolation, notification-secret handling, updater, CI pinning, or dependency advisories.
- Providing a general POSIX shell parser or preserving shell expansion in single-line directives.

## Threat Model

The attacker controls all or part of a slash-command argument or project command template. The operator has configured `allowed_commands` or `allowed_patterns` for ordinary live-data commands. The attacker attempts to append a second command, redirect data, create a pipeline, or invoke command substitution while retaining an allowed first executable.

The security boundary is the live-data policy plus the new shell-free parser. An allowed executable may still perform dangerous operations through its own legitimate arguments; that remains the policy author's responsibility. The fix guarantees that the authorization of one executable cannot implicitly authorize an additional shell program.

## Design

### Shell-Free Command Parser

Add an internal parser in `src/hooks/auto-slash-command/live-data.ts` that converts a command string into:

```ts
interface ParsedCommandInvocation {
  executable: string;
  args: string[];
}
```

The parser supports:

- unquoted arguments separated by ASCII whitespace;
- single-quoted literal arguments;
- double-quoted arguments;
- backslash escaping for the following character;
- empty quoted arguments.

The parser rejects:

- empty commands;
- unterminated quotes or a trailing escape;
- unquoted `;`, `&`, `&&`, `||`, `|`, `<`, and `>`;
- CR, LF, NUL, and other ASCII control characters;
- backtick command substitution;
- `$(` command substitution outside single-quoted literal text.

Quoted shell metacharacters are ordinary argument content. Environment-variable expansion, glob expansion, tilde expansion, and command substitution do not occur because no shell is started.

### Authorization Flow

For single-line directives:

1. Parse the directive command into an executable and arguments.
2. If parsing fails, render a blocked live-data result and do not call a process API.
3. Apply `denied_patterns` to the original command string.
4. Apply `denied_commands` to the parsed executable.
5. Authorize when either `allowed_commands` contains the executable or a safe `allowed_patterns` expression matches the original command string.
6. Execute only the parsed executable and argument vector.

This preserves both policy mechanisms while ensuring neither mechanism can re-enable shell interpretation.

### Execution

Replace shell-backed `execSync(command, options)` for single-line directives with:

```ts
execFileSync(invocation.executable, invocation.args, {
  shell: false,
  timeout: TIMEOUT_MS,
  maxBuffer: MAX_OUTPUT_BYTES + 1024,
  encoding: "utf-8",
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
```

The existing output truncation and error rendering remain unchanged. Cache keys and displayed command text continue to use the original normalized command so observable output remains stable.

### Multi-Line Script Blocks

Multi-line script blocks keep their current execution path. They are an explicitly shell-oriented feature: the policy author must allow the named interpreter, and the block body is intentionally supplied on standard input. This PR does not broaden or redesign that trust model.

## Error Handling

Parser failures return an escaped `<live-data ... error="true">` result beginning with `blocked:` and a stable reason. No process invocation occurs. Process failures continue to surface captured stderr or the thrown error message, using the existing HTML escaping and output-size limit.

The implementation must not echo unescaped directive content or error text into markup.

## Compatibility

Ordinary commands such as `git status`, `git log --oneline`, and `echo "hello world"` remain supported. Single-line directives that depend on shell pipelines, redirection, chaining, command substitution, variable expansion, globbing, or tilde expansion stop working and fail closed.

A repository search found no committed live-data command templates or policies that rely on those shell features. The compatibility impact is therefore limited to downstream user-authored templates.

## Testing

Use test-driven development in `src/__tests__/live-data.test.ts`:

- prove the current implementation executes an appended `;` payload;
- cover `&&`, `||`, pipe, redirects, newline, backticks, and `$()` as blocked inputs;
- verify no process API is called for blocked inputs;
- verify ordinary arguments, quoted arguments, escaped whitespace, and empty quoted arguments become the expected `execFileSync` argv;
- verify quoted metacharacters remain literal argument data;
- verify malformed quotes and trailing escapes fail closed;
- preserve denied-command, denied-pattern, allowed-command, allowed-pattern, cache, condition, formatting, truncation, and error behavior;
- add an executor-level regression proving injected `$ARGUMENTS` cannot trigger a second command.

After the targeted red-green cycle, run lint, TypeScript compilation, the full unit suite, the build, and generated-artifact verification required by the repository.

## Files Expected to Change

- `src/hooks/auto-slash-command/live-data.ts`: parser, authorization result, and shell-free execution.
- `src/__tests__/live-data.test.ts`: parser and injection regression coverage.
- The narrowest existing executor test file that can cover `$ARGUMENTS` substitution, if the behavior is not already covered through `resolveLiveData`.
- Generated bridge artifacts only when the repository build identifies them as derived from the modified source.

## Security Properties

The completed change must establish all of the following:

- an `allowed_commands` entry authorizes exactly one executable invocation;
- `allowed_patterns` cannot restore shell parsing;
- attacker-controlled arguments cannot add a second process through shell syntax;
- blocked directives never reach `execSync`, `execFileSync`, or another process API;
- normal authorized commands retain timeout, output-limit, escaping, and error semantics.
