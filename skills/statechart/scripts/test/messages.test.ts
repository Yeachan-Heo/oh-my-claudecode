import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { plainText, runtime } from "../backends/plain-text.ts";
import { readMessages } from "../frontends/messages.ts";
import { readVerdict } from "../frontends/verdict.ts";

const tool = (code: number, level: number, ...lines: string[]) =>
  [`@!@!@STARTMSG ${code}:${level} @!@!@`, ...lines, `@!@!@ENDMSG ${code} @!@!@`].join("\n");

const plain = (text: string) => [...plainText(readMessages(text))].join("");

test("TLC's -tool output prints as plain TLC prints it", () => {
  const text = [
    tool(2262, 0, "TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)"),
    tool(2401, 3, "Please run the Java VM with a throughput optimized garbage collector."),
    tool(2220, 0, "Starting SANY..."),
    "Parsing file /tmp/Spec.tla",
    "<<",
    '"chart",',
    ">>",
    tool(2219, 0, "SANY finished."),
    tool(2154, 3, "The spec has no TypeOK."),
    tool(2200, 0, "Progress(1) at 2026-10-25 12:58:36: 3 states generated."),
    tool(2116, 1, "Temporal properties were violated.", ""),
    tool(2217, 4, "1: <Initial predicate>", "/\\ x = 0", ""),
    tool(2217, 4, "2: <Next line 5, col 9 to line 5, col 20 of module Spec>", "/\\ x = 1", ""),
    tool(2122, 4, "1: Back to state: <Back line 6, col 9 to line 6, col 23 of module Spec>", ""),
    tool(2218, 4, "3: Stuttering"),
    tool(1000, 2, "This was a bug."),
    tool(2200, 0, "Progress(2) at 2026-10-25 12:58:37: 3 states generated."),
    tool(2199, 0, "3 states generated."),
    tool(2186, 0, "Finished in 61000ms at (2026-10-25 12:58:37)"),
    "",
  ].join("\n");
  assert.equal(
    plain(text),
    [
      "TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)",
      "Warning: Please run the Java VM with a throughput optimized garbage collector.",
      "(Use the -nowarning option to disable this warning.)",
      "Parsing file /tmp/Spec.tla",
      "<<",
      '"chart",',
      ">>",
      "Warning: The spec has no TypeOK.",
      "Progress(1) at 2026-10-25 12:58:36: 3 states generated.",
      "Error: Temporal properties were violated.",
      "",
      "State 1: <Initial predicate>",
      "/\\ x = 0",
      "",
      "State 2: <Next line 5, col 9 to line 5, col 20 of module Spec>",
      "/\\ x = 1",
      "",
      "Back to state 1: <Back line 6, col 9 to line 6, col 23 of module Spec>",
      "",
      "State 3: Stuttering",
      "TLC Bug: This was a bug.",
      "3 states generated.",
      "Finished in 01min 01s at (2026-10-25 12:58:37)",
      "",
    ].join("\n"),
  );
});

test("a message that TLC prints inside another prints as plain TLC prints it", () => {
  const assertion = "The first argument of Assert evaluated to FALSE; the second argument was:";
  const text = [
    tool(
      2111,
      1,
      "Evaluating invariant Bad failed.",
      tool(2179, 0, "The second argument of \\div is 0."),
    ),
    tool(2121, 1, "The behavior up to this point is:"),
    tool(1000, 1, tool(2132, 0, assertion, '"left @!@!@STARTMSG 9999:1 @!@!@ right"')),
    tool(1000, 1, tool(2132, 0, assertion, '"@!@!@ENDMSG 2103 @!@!@"')),
    "",
  ].join("\n");
  assert.equal(
    plain(text),
    [
      "Error: Evaluating invariant Bad failed.",
      "The second argument of \\div is 0.",
      "Error: The behavior up to this point is:",
      `Error: ${assertion}`,
      '"left @!@!@STARTMSG 9999:1 @!@!@ right"',
      `Error: ${assertion}`,
      '"@!@!@ENDMSG 2103 @!@!@"',
      "",
    ].join("\n"),
  );
});

test("an end line closes the innermost message whatever code it names", () => {
  const text = [
    "@!@!@STARTMSG 2111:1 @!@!@",
    "Evaluating invariant Bad failed: @!@!@STARTMSG 2179:0 @!@!@",
    "The second argument of \\div is 0.",
    "@!@!@ENDMSG 2179 @!@!@",
    "@!@!@ENDMSG 2111 @!@!@",
    tool(2186, 0, "Finished in 0ms at (T)"),
    "",
  ].join("\n");
  assert.equal(
    plain(text),
    [
      "Error: Evaluating invariant Bad failed: The second argument of \\div is 0.",
      "Finished in 00s at (T)",
      "",
    ].join("\n"),
  );
});

test("a message that TLC starts at the end of a line of text prints on that line", () => {
  const text = [
    "@!@!@STARTMSG 1000:1 @!@!@",
    "TLC threw an unexpected exception.",
    "This was probably caused by an error in the spec or model.",
    "See the User Output or TLC Console for clues to what happened.",
    "The exception was a java.lang.RuntimeException",
    ": tlc2.tool.EvalException: @!@!@STARTMSG 2179:0 @!@!@",
    "The second argument of \\div is 0.",
    "@!@!@ENDMSG 2179 @!@!@",
    "@!@!@ENDMSG 1000 @!@!@",
    "@!@!@STARTMSG 2103:1 @!@!@",
    "The error occurred when TLC was evaluating the nested",
    "expressions at the following positions:",
    "0. Line 8, column 8 to line 8, column 25 in ConstraintEval",
    "1. Line 8, column 8 to line 8, column 21 in ConstraintEval",
    "",
    "",
    "@!@!@ENDMSG 2103 @!@!@",
    "@!@!@STARTMSG 2200:0 @!@!@",
    "Progress(2) at 2026-10-25 17:45:59: 3 states generated (598 s/min), 2 distinct states found (398 ds/min), 0 states left on queue.",
    "@!@!@ENDMSG 2200 @!@!@",
    "@!@!@STARTMSG 2199:0 @!@!@",
    "3 states generated, 2 distinct states found, 0 states left on queue.",
    "@!@!@ENDMSG 2199 @!@!@",
    "@!@!@STARTMSG 2186:0 @!@!@",
    "Finished in 304ms at (2026-10-25 17:45:59)",
    "@!@!@ENDMSG 2186 @!@!@",
    "",
  ].join("\n");
  assert.equal(
    plain(text),
    [
      "Error: TLC threw an unexpected exception.",
      "This was probably caused by an error in the spec or model.",
      "See the User Output or TLC Console for clues to what happened.",
      "The exception was a java.lang.RuntimeException",
      ": tlc2.tool.EvalException: The second argument of \\div is 0.",
      "Error: The error occurred when TLC was evaluating the nested",
      "expressions at the following positions:",
      "0. Line 8, column 8 to line 8, column 25 in ConstraintEval",
      "1. Line 8, column 8 to line 8, column 21 in ConstraintEval",
      "",
      "",
      "3 states generated, 2 distinct states found, 0 states left on queue.",
      "Finished in 00s at (2026-10-25 17:45:59)",
      "",
    ].join("\n"),
  );
});

test("output that ends where TLC died prints as plain TLC's output cut at the same point", () => {
  const computing = tool(2189, 0, "Computing initial states...");
  const assertion = "The first argument of Assert evaluated to FALSE; the second argument was:";
  const insideEnd = [
    computing,
    "@!@!@STARTMSG 2111:1 @!@!@",
    "Evaluating invariant ChartMark failed.",
    "@!@!@STARTMSG 2132:0 @!@!@",
    assertion,
    '"c went past eleven"',
    "@!@!@ENDMSG 21",
  ].join("\n");
  assert.equal(
    plain(insideEnd),
    [
      "Computing initial states...",
      "Error: Evaluating invariant ChartMark failed.",
      assertion,
      '"c went past eleven"',
      "",
    ].join("\n"),
  );
  const afterStarts = [computing, "@!@!@STARTMSG 1000:1 @!@!@", "@!@!@STARTMSG 2132:0 @!@!@", ""];
  assert.equal(plain(afterStarts.join("\n")), "Computing initial states...\n");
});

test("TLC's output with Windows line endings reads as it does with Unix ones", () => {
  const unix = fs.readFileSync(
    path.join(import.meta.dirname, "corpus/MediaPlayer/verdict-1.out"),
    "utf8",
  );
  const windows = unix.replaceAll("\n", "\r\n");
  const verdict = readVerdict(readMessages(windows));
  assert.deepEqual(verdict.broke, { kind: "invariant", name: "LoudWhenStopped" });
  assert.deepEqual(verdict, readVerdict(readMessages(unix)));
  assert.equal(plain(windows), plain(unix));
});

test("text outside TLC's messages, such as SANY's output, passes through unchanged", () => {
  for (const text of ["", "\n", "a\n\nb\n", "Semantic errors:\n\n  line 1\n"])
    assert.equal(plain(text), text);
});

test("TLC's run time prints as plain TLC prints it, with each field wrapping", () => {
  for (const [ms, printed] of [
    [0, "00s"],
    [394, "00s"],
    [59_999, "59s"],
    [60_000, "00s"],
    [60_001, "01min 00s"],
    [3_599_999, "59min 59s"],
    [3_600_000, "00min 00s"],
    [3_600_001, "01h 00min"],
    [86_400_000, "00h 00min"],
    [86_400_001, "1d 00h"],
    [90_000_000, "1d 01h"],
    [366 * 86_400_000, "1d 00h"],
  ] satisfies [number, string][])
    assert.equal(runtime(ms), printed, String(ms));
});
