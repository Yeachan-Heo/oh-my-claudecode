import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { shimRuntimeArgs } from "../run.ts";

// The java.ts shim is a .ts file that the CLI spawns from a temp working
// directory. On a node without type stripping the spawn must carry the
// absolute tsx loader (a bare "tsx" specifier would resolve against the
// shim's temp cwd and fail); on a stripping-native node no loader is added.

test("a bare tsx import is replaced by the absolute loader url", () => {
  const args = shimRuntimeArgs(["--disable-warning=ExperimentalWarning", "--import", "tsx"], {
    typescript: undefined,
  });
  assert.ok(!args.includes("tsx"), `bare tsx survived: ${args}`);
  const imported = args[args.indexOf("--import") + 1];
  assert.match(imported, /^file:\/\//);
  assert.match(imported, /tsx\/dist\/loader\.mjs$/);
});

test("a stripping-less node with no tsx flag gains the loader", () => {
  const before = ["--disable-warning=ExperimentalWarning"];
  const args = shimRuntimeArgs(before, { typescript: undefined });
  const imported = args[args.indexOf("--import") + 1];
  assert.match(imported, /^file:\/\//);
  assert.match(imported, /tsx\/dist\/loader\.mjs$/);
  assert.deepEqual(args.slice(0, before.length), before);
});

test("a stripping-native node still makes a bare tsx import absolute", () => {
  // The bare specifier booted THIS process from the scripts directory; the
  // shim's temp cwd cannot resolve it, stripping or not.
  const args = shimRuntimeArgs(["--import", "tsx"], { typescript: "strip" });
  assert.ok(!args.includes("tsx"), `bare tsx survived: ${args}`);
  const imported = args[args.indexOf("--import") + 1];
  assert.match(imported, /^file:\/\//);
});

test("an absolute loader already in execArgv is left alone", () => {
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const before = ["--import", loader];
  const args = shimRuntimeArgs(before, { typescript: "strip" });
  assert.deepEqual(args, before);
});

test("the --test flag is filtered from the child's runtime args", () => {
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const args = shimRuntimeArgs(["--test", "--import", loader], { typescript: "strip" });
  assert.ok(!args.includes("--test"), `--test leaked: ${args}`);
  assert.deepEqual(args, ["--import", loader]);
});
