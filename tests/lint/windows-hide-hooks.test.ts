import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const CHILD_PROCESS_METHODS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']);
const INSTALLED_HOOK_TEMPLATE_ROOT = 'templates/hooks';

interface ProductionSource {
  path: string;
  content: string;
}

function toForwardSlash(path: string): string {
  return path.split(sep).join('/');
}

function walkFiles(directory: string, predicate: (path: string) => boolean): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : walkFiles(path, predicate);
    }
    return entry.isFile() && predicate(path) ? [path] : [];
  });
}

/**
 * This is intentionally a production manifest rather than a repository-wide scan:
 * source-reachable TypeScript, scripts registered by hooks/hooks.json, and every
 * installed hook template. Release/build/developer scripts are therefore excluded.
 */
function productionManifest(): ProductionSource[] {
  const sourceFiles = walkFiles(join(REPO_ROOT, 'src'), (path) =>
    path.endsWith('.ts') &&
    !/\.(?:test|spec)\.ts$/.test(path) &&
    toForwardSlash(relative(REPO_ROOT, path)) !== 'src/lib/release-generation.ts',
  );
  const registeredScripts = new Set(
    [...readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8').matchAll(/scripts\/([\w-]+\.mjs)/g)]
      .map((match) => join(REPO_ROOT, 'scripts', match[1]!)),
  );
  const installedTemplates = walkFiles(join(REPO_ROOT, INSTALLED_HOOK_TEMPLATE_ROOT), (path) => path.endsWith('.mjs'));

  return [...new Set([...sourceFiles, ...registeredScripts, ...installedTemplates])]
    .sort()
    .map((path) => ({ path: toForwardSlash(relative(REPO_ROOT, path)), content: readFileSync(path, 'utf8') }));
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

function stringValue(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  expression = unwrap(expression);
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) ? expression.text : undefined;
}

function isGitCommand(expression: ts.Expression | undefined): boolean {
  const value = stringValue(expression);
  return value !== undefined && /(?:^|[\\/])git(?:\.exe)?$/i.test(value);
}

function isGitShellCommand(expression: ts.Expression | undefined): boolean {
  if (!expression) return false;
  expression = unwrap(expression);
  const value = ts.isTemplateExpression(expression) ? expression.head.text : stringValue(expression);
  return value !== undefined && /(?:^|\s)git(?:\.exe)?(?:\s|$)/i.test(value);
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!('name' in property) || !property.name) return undefined;
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
}

function isGitCondition(expression: ts.Expression, commandParameter?: string): boolean {
  if (!commandParameter) return false;
  const text = expression.getText();
  return new RegExp(`\\b${commandParameter}\\s*={2,3}\\s*['\"]git['\"]|['\"]git['\"]\\s*={2,3}\\s*${commandParameter}\\b`).test(text);
}

function optionValue(
  expression: ts.Expression | undefined,
  name: 'windowsHide' | 'shell',
  declarations: Map<string, ts.Expression>,
  commandParameter?: string,
  seen = new Set<string>(),
): boolean {
  if (!expression) return false;
  expression = unwrap(expression);

  if (ts.isIdentifier(expression)) {
    if (seen.has(expression.text)) return false;
    const declaration = declarations.get(expression.text);
    if (!declaration) return false;
    seen.add(expression.text);
    return optionValue(declaration, name, declarations, commandParameter, seen);
  }

  if (ts.isConditionalExpression(expression)) {
    if (isGitCondition(expression.condition, commandParameter)) {
      return optionValue(expression.whenTrue, name, declarations, commandParameter, seen);
    }
    return false;
  }

  if (!ts.isObjectLiteralExpression(expression)) return false;
  for (const property of [...expression.properties].reverse()) {
    if (ts.isPropertyAssignment(property) && propertyName(property) === name) {
      return property.initializer.kind === ts.SyntaxKind.TrueKeyword;
    }
    if (ts.isSpreadAssignment(property)) {
      // An unresolved spread could overwrite the option, so only a proven value is effective.
      return optionValue(property.expression, name, declarations, commandParameter, seen);
    }
  }
  return false;
}

function collectDeclarations(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const declarations = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function childProcessCallees(sourceFile: ts.SourceFile): Map<string, string> {
  const callees = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ['child_process', 'node:child_process'].includes(stringValue(node.moduleSpecifier) ?? '')) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (CHILD_PROCESS_METHODS.has(imported)) callees.set(element.name.text, imported);
        }
      }
      if (bindings && ts.isNamespaceImport(bindings)) callees.set(bindings.name.text, '*');
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'require' &&
        ['child_process', 'node:child_process'].includes(stringValue(node.initializer.arguments[0]) ?? '')) {
      if (ts.isIdentifier(node.name)) callees.set(node.name.text, '*');
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const imported = element.propertyName?.getText() ?? element.name.getText();
          if (CHILD_PROCESS_METHODS.has(imported) && ts.isIdentifier(element.name)) callees.set(element.name.text, imported);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'promisify' && ts.isIdentifier(node.initializer.arguments[0]) &&
        CHILD_PROCESS_METHODS.has(node.initializer.arguments[0].text)) {
      callees.set(node.name.text, node.initializer.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return callees;
}

function callKind(call: ts.CallExpression, callees: Map<string, string>): string | undefined {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return callees.get(expression.text);
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) &&
      callees.get(expression.expression.text) === '*' && CHILD_PROCESS_METHODS.has(expression.name.text)) {
    return expression.name.text;
  }
  return undefined;
}

function enclosingRunCommand(call: ts.CallExpression): string | undefined {
  let node: ts.Node | undefined = call.parent;
  while (node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'runCommand') {
      return node.parameters[0] && ts.isIdentifier(node.parameters[0].name) ? node.parameters[0].name.text : undefined;
    }
    node = node.parent;
  }
  return undefined;
}

function scanGitProcessCalls(path: string, content: string): string[] {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const declarations = collectDeclarations(sourceFile);
  const callees = childProcessCallees(sourceFile);
  const violations: string[] = [];

  const report = (node: ts.Node, message: string) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    violations.push(`${path}:${line}: ${message}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = callKind(node, callees);
      const helperCommand = ts.isIdentifier(node.expression) && node.expression.text === 'runCommand';
      const directGit = kind !== undefined && (kind === 'exec' || kind === 'execSync'
        ? isGitShellCommand(node.arguments[0])
        : isGitCommand(node.arguments[0]));
      const helperGit = helperCommand && isGitCommand(node.arguments[0]);
      const commandParameter = kind ? enclosingRunCommand(node) : undefined;
      const helperProcessCall = kind !== undefined && commandParameter !== undefined;

      if (directGit || helperProcessCall) {
        const options = kind === 'exec' || kind === 'execSync' ? node.arguments[1] : node.arguments[2];
        if (optionValue(options, 'shell', declarations, commandParameter)) {
          report(node, `${kind} runs Git with shell: true`);
        }
        if (!optionValue(options, 'windowsHide', declarations, commandParameter)) {
          report(node, `${kind} runs Git without effective windowsHide: true`);
        }
      }
      if (helperGit) {
        // The helper body is assessed above, including conditional Git-only spreads.
        const declaration = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === 'runCommand',
        );
        if (!declaration || !declaration.body) report(node, 'runCommand Git helper has no local implementation');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('Windows Git child-process hardening', () => {
  it('scans the defined production manifest and excludes developer automation', () => {
    const manifest = productionManifest();
    const paths = manifest.map(({ path }) => path);

    expect(paths).toContain('src/hooks/persistent-mode/idle-repo-state.ts');
    expect(paths).toContain('scripts/persistent-mode.mjs');
    expect(paths).toContain('templates/hooks/persistent-mode.mjs');
    expect(paths).not.toContain('scripts/release.ts');
    expect(paths).not.toContain('src/__tests__/context-guard-stop.test.ts');
    expect(manifest.flatMap(({ path, content }) => scanGitProcessCalls(path, content))).toEqual([]);
  });

  it('rejects owned Git shell strings, shell mode, missing options, aliases, and unsafe helpers', () => {
    const violations = scanGitProcessCalls('seed.ts', `
      import { execSync as execute, execFileSync } from 'node:child_process';
      import * as cp from 'node:child_process';
      execute(\`git status\`);
      execFileSync('git', ['status'], { shell: true, windowsHide: true });
      cp.spawnSync('git', ['status'], {});
      function runCommand(command: string, args: string[]) { return execFileSync(command, args, {}); }
      runCommand('git', ['status']);
      const execFileAsync = promisify(execFile);
      execFileAsync('git', ['status'], {});
    `);

    expect(violations).toHaveLength(5);
    expect(violations.join('\n')).toContain('execSync runs Git without effective windowsHide: true');
    expect(violations.join('\n')).toContain('execFileSync runs Git with shell: true');
    expect(violations.join('\n')).toContain('spawnSync runs Git without effective windowsHide: true');
  });

  it('accepts multiline three-argument calls and referenced/spread Git-safe options', () => {
    const violations = scanGitProcessCalls('seed.ts', `
      import { execFileSync } from 'node:child_process';
      const hidden = { windowsHide: true };
      const options = { encoding: 'utf8', ...hidden };
      execFileSync(
        'git',
        ['status', '--porcelain'],
        options,
      );
      function runCommand(command: string, args: string[]) {
        return execFileSync(command, args, { ...(command === 'git' ? { windowsHide: true } : {}) });
      }
      runCommand('git', ['status']);
    `);

    expect(violations).toEqual([]);
  });

  it('permits generic user shell execution and unowned commands', () => {
    const violations = scanGitProcessCalls('seed.ts', `
      import { execSync, execFileSync } from 'node:child_process';
      execSync(userSuppliedCommand, { shell: true });
      execFileSync('npm', ['test'], { shell: true });
    `);

    expect(violations).toEqual([]);
  });
});
