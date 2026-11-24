// Table of the shell constructs that tools/diagnostics/check_classifier.mjs reads around a check (`npm test` and its aliases):
// pipelines, lists, groups, substitutions, compound commands, redirections, prefixes, runner aliases and narrowing flags.
// A row is a command and five letters: C (a check) or - (none), H (the exit status is hidden) or V (visible), N (narrowed) or .,
// and the verdict for the tool result `exit 0` with no output and for `exit 1` with no output (p passed, f failed, u undetermined).
// The `-` rows are read as no evidence at all, which is the safe side for a construct that is not parsed. Bash is the oracle for the
// two claims that matter: where the verdict is `p` at exit 0 the check really ran when the shell exited 0, and where it is `f` at
// exit 1 a check that exits 0 leaves the shell at 0, so the failing status cannot come from anything but the check. Every program
// of a row is a stub that records its run and exits with the status it is given, so the test depends on no tool of the host.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { classifyCheckResult, classifyCommand } from '../../tools/diagnostics/check_classifier.mjs';

const hasBash = spawnSync('bash', ['--version']).status === 0;
const VERDICT: Record<string, string> = { p: 'passed', f: 'failed', u: 'undetermined' };

const ROWS: Array<[string, string]> = [
  ["npm test | tail -5", 'CH.uu'],
  ["npm test | cat", 'CH.uu'],
  ["npm test |& tee log", 'CH.uu'],
  ["npm test 2>&1 | tee log", 'CH.uu'],
  ["false | npm test", 'CV.pf'],
  ["npm test | npm test", 'CV.pf'],
  ["! npm test", '-V.uu'],
  ["! npm test | tail", '-V.uu'],
  ["time npm test", 'CV.pf'],
  ["time -p npm test", 'CV.pf'],
  ["time npm test | tail", 'CH.uu'],
  ["npm test ; echo", 'CH.uu'],
  ["npm test ;", 'CV.pf'],
  ["npm test &", 'CH.uu'],
  ["npm test & wait", 'CH.uu'],
  ["npm test && echo ok", 'CV.pf'],
  ["npm test || echo bad", 'CH.uu'],
  ["npm test || true", 'CH.uu'],
  ["false || npm test", 'CH.uu'],
  ["true && npm test", 'CV.pf'],
  ["false && npm test", 'CV.pu'],
  ["false; npm test", 'CV.pf'],
  ["npm test\necho x", 'CH.uu'],
  ["echo x\nnpm test", 'CV.pf'],
  ["npm test &&\n echo", 'CV.pf'],
  ["( npm test )", '-V.uu'],
  ["(npm test)", '-V.uu'],
  ["{ npm test; }", '-V.uu'],
  ["{ npm test ; } | tail", '-V.uu'],
  ["( npm test ) | tail", '-V.uu'],
  ["( npm test ); echo", '-V.uu'],
  ["( npm test ) && echo", '-V.uu'],
  ["{ false; npm test; }", 'CH.uu'],
  ["( cd x && npm test )", 'CV.pu'],
  ["echo $(npm test)", '-V.uu'],
  ["x=$(npm test)", '-V.uu'],
  ["echo `npm test`", '-V.uu'],
  ["cat <(npm test)", '-V.uu'],
  ["npm test > >(tee log)", 'CV.pf'],
  ["$(echo npm test)", '-V.uu'],
  ["echo \"$(npm test)\"", '-V.uu'],
  ["if npm test; then echo y; fi", '-V.uu'],
  ["if npm test; then echo y; else echo n; fi", '-V.uu'],
  ["while npm test; do :; done", '-V.uu'],
  ["until npm test; do :; done", '-V.uu'],
  ["for i in 1; do npm test; done", '-V.uu'],
  ["for i in 1 2; do npm test; done", '-V.uu'],
  ["case x in x) npm test;; esac", '-V.uu'],
  ["f() { npm test; }; f", '-V.uu'],
  ["f() { npm test; }", '-V.uu'],
  ["[ -f x ] && npm test", 'CV.pu'],
  ["[[ -f x ]] && npm test", 'CV.pu'],
  ["npm test > out", 'CV.pf'],
  ["npm test >> out", 'CV.pf'],
  ["npm test 2>&1", 'CV.pf'],
  ["npm test &> out", 'CV.pf'],
  ["npm test < in", 'CV.pf'],
  ["npm test <<< x", 'CV.pf'],
  ["npm test <<EOF\nx\nEOF", 'CV.pf'],
  ["> out npm test", 'CV.pf'],
  ["2>&1 npm test", 'CV.pf'],
  ["npm test 2>/dev/null", 'CV.pf'],
  ["npm test >/dev/null 2>&1", 'CV.pf'],
  ["npm test | tee out", 'CH.uu'],
  ["A=1 npm test", 'CV.pf'],
  ["A=1 B=2 npm test", 'CV.pf'],
  ["A=$(date) npm test", 'CV.pf'],
  ["env A=1 npm test", 'CV.pf'],
  ["env -i npm test", 'CV.pf'],
  ["sudo npm test", 'CV.pf'],
  ["sudo -u x npm test", 'CV.pf'],
  ["nohup npm test", 'CV.pf'],
  ["exec npm test", 'CV.pf'],
  ["command npm test", 'CV.pf'],
  ["nice npm test", 'CV.pf'],
  ["timeout 5 npm test", 'CV.pf'],
  ["xargs npm test", '-V.uu'],
  ["builtin npm test", '-V.uu'],
  ["stdbuf -o0 npm test", '-V.uu'],
  ["bash -c \"npm test\"", '-V.uu'],
  ["sh -c 'npm test'", '-V.uu'],
  ["bash -c 'npm test | tail'", '-V.uu'],
  ["eval \"npm test\"", '-V.uu'],
  ["cd x && npm test", 'CV.pu'],
  ["cd x; npm test", 'CV.pf'],
  ["export A=1 && npm test", 'CV.pf'],
  ["export A=1; npm test", 'CV.pf'],
  ["set -e; npm test", 'CV.pf'],
  ["set -e\nnpm test; echo", 'CH.uu'],
  ["npm run test", 'CV.pf'],
  ["npm run-script test", '-V.uu'],
  ["npm t", '-V.uu'],
  ["npm tst", '-V.uu'],
  ["npm test --silent", 'CV.pf'],
  ["npm --silent test", 'CV.pf'],
  ["npm run test -- --run", 'CV.pf'],
  ["pnpm test", 'CV.pf'],
  ["pnpm run test", 'CV.pf'],
  ["pnpm -r test", 'CV.pf'],
  ["pnpm --filter x test", 'CVNuf'],
  ["pnpm exec vitest", 'CV.pf'],
  ["pnpm dlx vitest", 'CV.pf'],
  ["yarn test", 'CV.pf'],
  ["yarn run test", 'CV.pf'],
  ["yarn workspace a test", '-V.uu'],
  ["bun test", 'CV.pf'],
  ["bun run test", 'CV.pf'],
  ["bunx vitest run", 'CV.pf'],
  ["npx vitest run", 'CV.pf'],
  ["npx --no-install vitest", '-V.uu'],
  ["npm exec vitest", '-V.uu'],
  ["npm x -- vitest", '-V.uu'],
  ["npm test:unit", 'CV.pf'],
  ["npm run test:unit", 'CV.pf'],
  ["npm run build", 'CV.pf'],
  ["npm run build:prod", 'CV.pf'],
  ["npm run lint", 'CV.pf'],
  ["npm run typecheck", 'CV.pf'],
  ["npm run test-all", 'CV.pf'],
  ["npm run testing", '-V.uu'],
  ["npm run pretest", '-V.uu'],
  ["npm test -- --grep x", 'CVNuf'],
  ["npm test -- -t x", 'CVNuf'],
  ["npm test --if-present", 'CVNuf'],
  ["npm test -w a", 'CVNuf'],
  ["npm test -- a.test.ts", 'CVNuf'],
  ["npm test a.test.ts", 'CVNuf'],
  ["npm test -- tests/", 'CV.pf'],
  ["vitest run -t x", 'CVNuf'],
  ["vitest run --changed", 'CVNuf'],
  ["vitest run a.test.ts", 'CVNuf'],
  ["vitest run --passWithNoTests", 'CVNuf'],
  ["vitest run --bail 1", 'CV.pf'],
  ["pytest -k x", 'CVNuf'],
  ["pytest tests/a.py", 'CVNuf'],
  ["pytest -x", 'CV.pf'],
  ["pytest --co", 'CVNuf'],
  ["jest --onlyChanged", 'CVNuf'],
  ["jest -t x", 'CVNuf'],
  ["node --test a.js", 'CVNuf'],
  ["node --test --test-name-pattern x", 'CVNuf'],
  ["go test ./...", 'CV.pf'],
  ["go test -run X ./pkg", 'CVNuf'],
  ["go test ./pkg", 'CV.pf'],
  ["cargo test -p x", 'CVNuf'],
  ["cargo test", 'CV.pf'],
  ["make test", 'CV.pf'],
  ["make test -n", '-V.uu'],
  ["make test -i", 'CVNuf'],
  ["npm test 2>&1|tail", 'CH.uu'],
  ["npm test|tail", 'CH.uu'],
  ["npm test&&echo", 'CV.pf'],
  ["npm test;echo", 'CH.uu'],
  ["npm test>out;echo", 'CH.uu'],
  ["npm test >out&&echo", 'CV.pf'],
  ["npm test&", 'CH.uu'],
  ["npm test &>/dev/null", 'CV.pf'],
  ["npm test >&2", 'CV.pf'],
  ["npm test 2>&1 &", 'CH.uu'],
  ["npm test |& tail -5", 'CH.uu'],
  ["set -o pipefail; npm test |& tail -5", 'CH.uu'],
  ["set -o pipefail; npm test | tail", 'CV.pf'],
  ["set -eo pipefail; npm test | tail", 'CV.pf'],
  ["set -euo pipefail; npm test | tail", 'CV.pf'],
  ["set -o errexit -o pipefail; npm test | tail", 'CH.uu'],
  ["set -o pipefail; npm test | cat", 'CH.uu'],
  ["set -o pipefail; npm test | tail | cat", 'CV.pu'],
  ["set -o pipefail; false | npm test | tail", 'CV.pu'],
  ["set -o pipefail; npm test | tail -n 5 missing", 'CH.uu'],
  ["set -o pipefail\nnpm test | tail", 'CV.pf'],
  ["bash -o pipefail -c 'npm test | tail'", '-V.uu'],
  ["npm test # c", 'CV.pf'],
  ["npm test # c | tail", 'CV.pf'],
  ["npm test ; # c", 'CV.pf'],
  ["npm test\n# c\necho", 'CH.uu'],
  ["npm test \\\n | tail", 'CH.uu'],
  ["npm test \\\n --silent", 'CV.pf'],
  ["npm test\n", 'CV.pf'],
  ["npm test\n\n", 'CV.pf'],
  ["npm test\r\n", 'CV.pf'],
  ["npm test\r\necho", 'CH.uu'],
  ["{ npm test; } 2>&1", '-V.uu'],
  ["npm test || exit 1", 'CH.uu'],
  ["npm test && npm run build", 'CV.pu'],
  ["npm test; npm run build", 'CV.pf'],
  ["npm test || npm run build", 'CH.uu'],
  ["npm test && npm run build | tail", 'CH.uu'],
  ["npm run build && npm test | tail", 'CH.uu'],
  ["npm test; echo $?", 'CH.uu'],
  ["npm test; echo \"rc=$?\"", 'CH.uu'],
  ["npm test | tee log; echo \"rc=${PIPESTATUS[0]}\"", 'CH.uu'],
  ["npm test | tee log; echo \"rc=$?\"", 'CH.uu'],
  ["trap 'exit 0' EXIT; npm test", 'CH.uu'],
  ["trap - EXIT; npm test", 'CH.uu'],
  ["true ||\nnpm test", 'CH.uu'],
  ["true ||\n\nnpm test", 'CH.uu'],
  ["true &&\nnpm test", 'CV.pf'],
  ["true |\nnpm test", 'CV.pf'],
  ["! printf x | npm test", '-V.uu'],
  ["! true | node --check a.js", '-V.uu'],
  ["echo ! | npm test", 'CV.pf'],
  ["node --test-reporter=tap -e x", '-V.uu'],
  ["node --test", 'CV.pf'],
  ["exit 0; npm test", 'CH.uu'],
  ["(exit 0; npm test)", 'CH.uu'],
  ["{ exit 0; npm test; }", 'CH.uu'],
  ["return 0; npm test", 'CH.uu'],
  ["[ -f x ] && exit 0; npm test", 'CH.uu'],
  ["echo exit; npm test", 'CV.pf'],
  ["cd . && exit; npm test | tail", 'CH.uu'],
  ["npm test; exit 0", 'CH.uu'],
  ["npm test; true", 'CH.uu'],
  ["npm test && true", 'CV.pf'],
  ["npm test || :", 'CH.uu'],
  ["true | npm test", 'CV.pf'],
  ["echo x | npm test", 'CV.pf'],
  ["cat x | npm test", 'CV.pf'],
  ["npm test <(true)", 'CV.pf'],
  ["npm test 2> >(cat)", 'CV.pf'],
  ["echo ok; npm test", 'CV.pf'],
  ["echo ok && npm test", 'CV.pf'],
  ["echo \"a;b\" && npm test", 'CV.pf'],
  ["echo 'a|b'; npm test", 'CV.pf'],
  ["echo a;b; npm test", 'CV.pf'],
  ["echo \"$(true; false)\" ; npm test", 'CV.pf'],
  ["echo `false` && npm test", 'CV.pf'],
  ["x=`false` npm test", 'CV.pf'],
  ["FOO=1 npm test -- --run", 'CV.pf'],
  ["NODE_OPTIONS=\"--x y\" npm test", 'CV.pf'],
  ["CI=1 npx vitest run", 'CV.pf'],
  ["env CI=1 npx vitest run | tail", 'CH.uu'],
  ["sudo -E npm test", 'CV.pf'],
  ["nice -n 5 npm test", 'CV.pf'],
  ["timeout -s KILL 5 npm test", 'CV.pf'],
  ["timeout 5 npm test | tail", 'CH.uu'],
  ["nohup npm test &", 'CH.uu'],
  ["nohup npm test > log 2>&1 &", 'CH.uu'],
  ["pnpm --filter ./pkg test", 'CVNuf'],
  ["pnpm -F x test", 'CVNuf'],
  ["pnpm -w test", 'CV.pf'],
  ["pnpm -r --if-present test", 'CVNuf'],
  ["pnpm --recursive test", 'CV.pf'],
  ["yarn --cwd pkg test", 'CV.pf'],
  ["yarn test --watchAll=false", 'CV.pf'],
  ["bun run --filter x test", '-V.uu'],
  ["bun run -F x test", '-V.uu'],
  ["bun test --bail", 'CV.pf'],
  ["bun test a.test.ts", 'CVNuf'],
  ["npm test --workspaces --if-present", 'CVNuf'],
  ["npm test --workspaces", 'CV.pf'],
  ["npm test -ws", 'CV.pf'],
  ["npm run test -w a -w b", 'CVNuf'],
  ["npm test -w=a", 'CVNuf'],
  ["npm test --workspace a", 'CVNuf'],
  ["npm -w a run test", 'CVNuf'],
  ["npm --workspace=a run test", 'CVNuf'],
  ["npm --prefix pkg test", 'CV.pf'],
  ["npm -C pkg test", 'CV.pf'],
  ["npm test --prefix pkg", 'CV.pf'],
  ["npm test --if-present=false", 'CV.pf'],
  ["npm test --no-if-present", 'CV.pf'],
  ["npm run test --if-present --silent", 'CVNuf'],
  ["yarn run --if-present test", '-V.uu'],
  ["pnpm run --if-present test", '-V.uu'],
  ["pnpm test --if-present", 'CVNuf'],
];

// Rows that cannot run in bash with the status the verdict assumes (the classifier is only asked what it would say), and `env -i`,
// which clears the PATH of the stubs.
const ORACLE_SKIP = new Set(['false && npm test', 'set -o pipefail; false | npm test | tail', 'env -i npm test']);

describe('the shell constructs around a check, one row each', () => {
  it('every row reads as the table says', () => {
    const wrong = ROWS.flatMap(([command, cells]) => {
      const got = classifyCommand(command);
      const v0 = classifyCheckResult({ command, output: '', isError: false, exitCode: 0 }).verdict;
      const v1 = classifyCheckResult({ command, output: '', isError: true, exitCode: 1 }).verdict;
      const read = `${got.isCheck ? 'C' : '-'}${got.exitHidden ? 'H' : 'V'}${got.narrowed ? 'N' : '.'}`;
      const ok = read === cells.slice(0, 3) && v0 === VERDICT[cells[3]] && v1 === VERDICT[cells[4]];
      return ok ? [] : [`${JSON.stringify(command)}: ${read} ${v0} ${v1}, wanted ${cells}`];
    });
    assert.deepEqual(wrong, []);
    assert.ok(ROWS.length > 200);
    assert.equal(new Set(ROWS.map(([command]) => command)).size, ROWS.length, 'no row twice');
  });

  it.skipIf(!hasBash)('bash agrees: a passed verdict at exit 0 ran the check, and a failed one at exit 1 can come from the check only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'construct-table-'));
    try {
      const bin = join(dir, 'bin');
      const work = join(dir, 'work');
      mkdirSync(bin);
      mkdirSync(join(work, 'x'), { recursive: true });
      writeFileSync(join(work, 'in'), 'x\n');
      const mark = join(dir, 'mark');
      const stub = '#!/bin/sh\necho run >> "$MARK"\nexit "${RC:-0}"\n';
      for (const name of ['npm', 'pnpm', 'yarn', 'bun', 'bunx', 'npx', 'vitest', 'pytest', 'jest', 'node', 'go', 'cargo', 'make']) {
        writeFileSync(join(bin, name), stub);
        chmodSync(join(bin, name), 0o755);
      }
      writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nwhile [ "${1#-}" != "$1" ]; do [ "$1" = -u ] && shift; shift; done\nexec "$@"\n');
      chmodSync(join(bin, 'sudo'), 0o755);
      const run = (command: string, rc: number) => {
        rmSync(mark, { force: true });
        const result = spawnSync('bash', ['-c', command.replace(/\[+ -f x \]+/g, (m) => m.replace('-f', '-d'))], {
          cwd: work, encoding: 'utf8', timeout: 20000, input: '',
          env: { PATH: `${bin}:/usr/bin:/bin`, MARK: mark, RC: String(rc), HOME: dir },
        });
        return { status: result.status, ran: existsSync(mark) };
      };
      const wrong: string[] = [];
      let passed = 0;
      let failed = 0;
      for (const [command, cells] of ROWS) {
        if (ORACLE_SKIP.has(command)) continue;
        if (cells[3] === 'p') {
          passed += 1;
          const got = run(command, 0);
          if (got.status !== 0 || !got.ran) wrong.push(`${JSON.stringify(command)}: passed at exit 0, but bash gave ${got.status} and ran=${got.ran}`);
        }
        if (cells[4] === 'f') {
          failed += 1;
          const got = run(command, 0);
          if (got.status !== 0) wrong.push(`${JSON.stringify(command)}: failed at exit 1, but a check that exits 0 leaves ${got.status}`);
        }
      }
      assert.deepEqual(wrong, []);
      assert.ok(passed > 80 && failed > 80, `rows checked: ${passed} passed, ${failed} failed`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
