import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_FLAGS } from "../run.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const jar = process.env.TLA2TOOLS;
export const skip = !jar && "set TLA2TOOLS to the path of tla2tools.jar to run TLC";

const RULES = /^(INVARIANTS?|PROPERTY|PROPERTIES|CHECK_DEADLOCK)$/;

const exitClass = (status: number | null) =>
  status === 0 ? 0 : status === 11 || status === 12 || status === 13 ? 1 : 2;

const stepsIn = (text: string) =>
  Math.max((text.match(/^State \d+: (?!Stuttering$)/gm)?.length ?? 0) - 1, 0) +
  (text.match(/^Back to state \d+: </gm)?.length ?? 0);

function properties(cfg: string) {
  const names: string[] = [];
  let section = "";
  for (const line of cfg.split("\n")) {
    section = line.match(/^[A-Z_]+/)?.[0] ?? section;
    if (/^PROPERT(Y|IES)$/.test(section))
      for (const word of line.trim().split(/\s+/)) if (word && word !== section) names.push(word);
  }
  return names;
}

function tlc(dir: string, module: string, cfg: string) {
  const run = `alone-${fs.readdirSync(dir).length}`;
  const file = path.join(dir, `${run}.cfg`);
  fs.writeFileSync(file, cfg);
  const tmp = path.join(dir, `${run}-tmp`);
  fs.mkdirSync(tmp);
  const r = spawnSync(
    process.env.JAVA ?? "java",
    [
      `-Djava.io.tmpdir=${tmp}`,
      "-cp",
      jar ?? "",
      "tlc2.TLC",
      ...PINNED_FLAGS,
      "-config",
      file,
      "-metadir",
      path.join(dir, `${run}-meta`),
      module,
    ],
    { cwd: dir, encoding: "utf8" },
  );
  const out = r.stdout + r.stderr;
  const temporal = properties(cfg);
  const broke =
    out.match(/^Error: (?:Invariant|Action property|Property) (\S+) is violated/m)?.[1] ??
    (/^Error: Deadlock reached\./m.test(out) ? "NoDeadlock" : undefined) ??
    (/^Error: Temporal properties were violated\./m.test(out) && temporal.length === 1
      ? temporal[0]
      : undefined);
  return { status: r.status, out, broke, steps: stepsIn(out) };
}

function alone(cfg: string, rule: string) {
  const lines: string[] = [];
  let section = "";
  for (const line of cfg.split("\n")) {
    section = line.match(/^[A-Z_]+/)?.[0] ?? section;
    if (!RULES.test(section)) lines.push(line);
  }
  if (rule !== "NoDeadlock")
    lines.push(
      `${properties(cfg).includes(rule) ? "PROPERTY" : "INVARIANT"} ${rule}`,
      "CHECK_DEADLOCK FALSE",
    );
  return `${lines.join("\n")}\n`;
}

export type Verdict = {
  status: number | null;
  breaks: Map<string, number>;
  holds: string[];
  unchecked: string[];
  chart: string;
  report: string;
};

export function agrees(module: string, files: { [name: string]: string[] }, cfg: string): Verdict {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statechart-plain-"));
  try {
    for (const [name, lines] of Object.entries(files))
      fs.writeFileSync(path.join(dir, `${name}.tla`), `${lines.join("\n")}\n`);
    fs.writeFileSync(path.join(dir, `${module}.cfg`), cfg);
    const out = path.join(dir, "out");
    const cli = spawnSync(
      process.execPath,
      [path.join(here, "../statechart.ts"), path.join(dir, `${module}.tla`), "--out", out],
      { encoding: "utf8" },
    );
    const plain = tlc(dir, module, cfg);
    const report = fs.existsSync(out) ? fs.readFileSync(path.join(out, "report.md"), "utf8") : "";
    const shown = `${cli.stderr}${report}`;
    assert.equal(
      cli.status,
      exitClass(plain.status),
      `TLC says:\n${plain.out}\nThe command says:\n${shown}`,
    );
    assert.doesNotMatch(shown, /Chart\w*Mark/);
    if (cli.status !== 2) assert.equal(cli.stderr, "");
    if (!report) assert.match(cli.stderr, /TLC could not check/);
    if (cli.status === 2) {
      const error = plain.out.match(/^Error: .*$/m)?.[0];
      assert.ok(
        error && shown.includes(error),
        `TLC says:\n${plain.out}\nThe command says:\n${shown}`,
      );
    }

    const breaks = new Map<string, number>();
    const bounded = new Set<string>();
    for (const [, rule, body] of report.matchAll(/^## (\S+) breaks\n(.*)$/gm)) {
      const said = body.match(/has (\d+) steps?:/)?.[1];
      const file = body.match(/ is in (tlc-\S+\.out)\./)?.[1];
      if (!file) {
        breaks.set(rule, Number(said));
        continue;
      }
      const text = fs.readFileSync(path.join(out, file), "utf8");
      if (said) assert.equal(Number(said), stepsIn(text), rule);
      if (/^Semantic processing of module ChartBound$/m.test(text)) bounded.add(rule);
      breaks.set(rule, stepsIn(text));
    }
    const list = (title: string) =>
      report
        .match(new RegExp(`^## ${title}\\n(.*)$`, "m"))?.[1]
        .split(", ")
        .sort() ?? [];
    const holds = list("Rules that hold");
    const unchecked = list("Rules not checked");
    const chartFile = path.join(out, "chart.mmd");
    const chart = fs.existsSync(chartFile) ? fs.readFileSync(chartFile, "utf8") : "";
    if (plain.broke) assert.equal(breaks.get(plain.broke), plain.steps, shown);
    for (const rule of holds) {
      const r = tlc(dir, module, alone(cfg, rule));
      assert.equal(r.status, 0, `${rule} holds in the report, but TLC says:\n${r.out}`);
    }
    for (const [rule, steps] of breaks) {
      const r = tlc(dir, module, alone(cfg, rule));
      assert.equal(r.broke, rule, `${rule} breaks in the report, but TLC says:\n${r.out}`);
      if (!bounded.has(rule)) assert.equal(steps, r.steps, rule);
    }
    return { status: cli.status, breaks, holds, unchecked, chart, report };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
