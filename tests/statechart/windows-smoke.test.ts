import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Windows end-to-end smoke for the statechart CLI, mirroring upstream's
// Windows CI job: chart the MediaPlayer corpus spec, whose committed rule
// breaks, with the pinned real TLC jar and the runner's Java 21. The
// POSIX-heavy cli.test.ts is skipped on win32, so this is the one place the
// CLI's real argument handling and Windows-only branches run pre-merge.
function nodeSupportsTypeStripping(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
}

function pinnedJar(): { url: string; sha256: string } {
  const source = readFileSync(join(import.meta.dirname, '..', '..', 'skills', 'statechart', 'scripts', 'run.ts'), 'utf8');
  const [, sha256, version] = /checksum=sha256:([0-9a-f]{64})\]@([^"]+)"/.exec(source) ?? [];
  expect(sha256, 'run.ts pins a checksummed TLC release').toBeTruthy();
  return { url: `https://github.com/tlaplus/tlaplus/releases/download/v${version}/tla2tools.jar`, sha256: sha256 as string };
}

const scriptsDir = join(import.meta.dirname, '..', '..', 'skills', 'statechart', 'scripts');
const corpus = join(scriptsDir, 'test', 'corpus', 'MediaPlayer');
const win32 = process.platform === 'win32';

describe.skipIf(!win32)('statechart Windows smoke', () => {
  it(
    'charts the MediaPlayer corpus case with real TLC',
    { timeout: 300_000 },
    (ctx) => {
      expect(existsSync(join(corpus, 'MediaPlayer.tla'))).toBe(true);
      const javaHome = process.env.JAVA_HOME_21_X64;
      if (!javaHome) {
        // A Windows box without the runner's Java 21 home (a contributor's
        // laptop) skips the smoke instead of failing it — CI always has it.
        ctx.skip();
      }
      const java = join(javaHome as string, 'bin', 'java.exe');
      const work = mkdtempSync(join(tmpdir(), 'statechart-smoke-'));
      try {
        // Fetch the pinned jar and verify its checksum, as the skill's
        // first-run guidance would.
        const { url, sha256 } = pinnedJar();
        const jar = join(work, 'tla2tools.jar');
        spawnSync('powershell', [
          '-NoProfile',
          '-Command',
          `Invoke-WebRequest -Uri '${url}' -OutFile '${jar}'`,
        ], { timeout: 120_000 });
        expect(existsSync(jar), 'the jar downloads').toBe(true);
        expect(
          createHash('sha256').update(readFileSync(jar)).digest('hex'),
        ).toBe(sha256);

        const entry = join(scriptsDir, 'statechart.ts');
        const base = ['--disable-warning=ExperimentalWarning'];
        const args = [
          ...(nodeSupportsTypeStripping() ? base : [...base, '--import', 'tsx']),
          entry,
          join(corpus, 'MediaPlayer.tla'),
          '--view',
          join(corpus, 'view.mjs'),
          '--out',
          join(work, 'MediaPlayer'),
        ];
        const r = spawnSync(process.execPath, args, {
          cwd: scriptsDir,
          encoding: 'utf8',
          maxBuffer: 1 << 26,
          timeout: 180_000,
          env: { ...process.env, JAVA: java, TLA2TOOLS: jar },
        });
        // The corpus rule breaks, so the committed smoke run exits 1. Any
        // other exit carries the CLI's own stderr into the failure message —
        // exit 2 is the command's validation error path, and without that
        // output the reason never reaches the CI log.
        const tail = (s: string | undefined) => (s ?? '').split('\n').slice(-25).join('\n');
        expect(
          r.status,
          `smoke exited ${r.status}\n--- stderr ---\n${tail(r.stderr)}\n--- stdout ---\n${tail(r.stdout)}`,
        ).toBe(1);
        const normalize = (s: string) => s.split('\r\n').join('\n');
        expect(normalize(readFileSync(join(work, 'MediaPlayer', 'report.md'), 'utf8'))).toBe(
          normalize(readFileSync(join(corpus, 'report.md'), 'utf8')),
        );
        expect(normalize(readFileSync(join(work, 'MediaPlayer', 'chart.mmd'), 'utf8'))).toBe(
          normalize(readFileSync(join(corpus, 'chart.mmd'), 'utf8')),
        );
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
});
