import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  linkSync,
  openSync,
  constants as fsConstants,
  closeSync,
} from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRunDirHandle } from "../../runtime/run-dir.js";
import {
  containedPathForPlatform,
  assertSafeContainedFileName,
  assertContainedFsSupported,
  readFileNoFollow,
  readContainedFileNoFollow,
  withContainedDirectory,
  withContainedPathForPlatform,
} from "../../runtime/safe-fs.js";

describe("graph runtime safe filesystem", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
  });

  function makeRunDir(runId = "run-safe-fs") {
    const root = mkdtempSync(join(tmpdir(), "omc-safe-fs-test-"));
    tempDirs.push(root);
    const handle = resolveRunDirHandle(root, runId);
    return { root, handle };
  }

  it("uses kernel FD paths on Linux and Darwin without mutating platform state", () => {
    const before = process.platform;

    expect(
      containedPathForPlatform(7, "/runs/example", "artifact", "linux"),
    ).toBe("/proc/self/fd/7/artifact");

    expect(
      containedPathForPlatform(7, "/runs/example", "artifact", "darwin"),
    ).toBe("/dev/fd/7/artifact");
    expect(() => containedPathForPlatform(7, "C:/runs/example", "artifact", "win32"))
      .toThrow("refusing pathname fallback");

    expect(process.platform).toBe(before);
  });

  it("reads, writes, renames, and deletes artifacts through a validated Linux directory FD", () => {
    const { handle } = makeRunDir();
    const artifact = join(handle.path, "artifact.txt");
    writeFileSync(artifact, "before");

    expect(readContainedFileNoFollow(handle, "artifact.txt")).toBe("before");
    withContainedPathForPlatform(
      handle,
      "artifact.txt",
      (path) => {
        writeFileSync(path, "after");
        renameSync(path, join(handle.path, "renamed.txt"));
      },
      "linux",
    );
    expect(readFileSync(join(handle.path, "renamed.txt"), "utf8")).toBe(
      "after",
    );

    withContainedPathForPlatform(
      handle,
      "renamed.txt",
      (path) => rmSync(path),
      "linux",
    );
    expect(existsSync(join(handle.path, "renamed.txt"))).toBe(false);
  });

  it("rejects a final artifact symlink on Linux and Darwin", () => {
    const { root, handle } = makeRunDir();
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(handle.path, "artifact.txt"));

    expect(() => readContainedFileNoFollow(handle, "artifact.txt")).toThrow();
    expect(() => withContainedPathForPlatform(handle, "artifact.txt", readFileNoFollow, "darwin"))
      .toThrow();
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  it("rejects special files and hardlinks as contained artifacts", () => {
    const { root, handle } = makeRunDir();
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    linkSync(outside, join(handle.path, "artifact.txt"));
    expect(() => readContainedFileNoFollow(handle, "artifact.txt")).toThrow(
      "private regular file",
    );

    const fifo = join(handle.path, "pipe");
    const result = spawnSync("mkfifo", [fifo]);
    expect(result.status).toBe(0);
    const readerFd = openSync(fifo, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    try {
      expect(() => readContainedFileNoFollow(handle, "pipe")).toThrow();
    } finally {
      closeSync(readerFd);
    }
  });

  it("performs Darwin operations through the descriptor alias", () => {
    const { handle } = makeRunDir();
    const artifact = join(handle.path, "artifact.txt");
    writeFileSync(artifact, "darwin-contained");
    expect(() =>
      withContainedPathForPlatform(
        handle,
        "artifact.txt",
        (path) => expect(readFileSync(path, "utf8")).toBe("darwin-contained"),
        "darwin",
      ),
    ).not.toThrow();
  });

  it("fails closed on Windows instead of using a raceable pathname fallback", () => {
    const { handle } = makeRunDir();
    const artifact = join(handle.path, "artifact.txt");
    writeFileSync(artifact, "windows-compatible");

    expect(() =>
      withContainedPathForPlatform(
        handle,
        "artifact.txt",
        (path) => readFileSync(path, "utf8"),
        "win32",
      ),
    ).toThrow("refusing pathname fallback");
    expect(() => withContainedDirectory(handle, () => undefined, "win32"))
      .toThrow("refusing pathname fallback");
  });

  it("preserves ordinary ENOENT behavior for missing artifacts", () => {
    const { handle } = makeRunDir();

    expect(() => readContainedFileNoFollow(handle, "missing.txt")).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it.each([
    "",
    ".",
    "..",
    "../outside.txt",
    "nested/file.txt",
    "nested\\file.txt",
    "/absolute.txt",
    "C:\\absolute.txt",
    "artifact\0.txt",
    "artifact\n.txt",
    "artifact/../outside.txt",
  ])("rejects unsafe contained artifact name %j", (fileName) => {
    expect(() => assertSafeContainedFileName(fileName)).toThrow("invalid contained artifact");
  });

  it("rejects Windows alternate data stream names even when simulating Windows", () => {
    expect(() => assertSafeContainedFileName("artifact:stream", "win32")).toThrow(
      "invalid contained artifact",
    );
  });

  it("accepts canonical NFC and rejects decomposed NFD basenames", () => {
    expect(() => assertSafeContainedFileName("café.txt")).not.toThrow();
    expect(() => assertSafeContainedFileName("café.txt")).toThrow(
      "invalid contained artifact",
    );
  });

  it.each(["CON", "CON.txt", "NUL.log", "COM1", "LPT9", "AUX.md"]) (
    "rejects Windows device basename %j",
    (fileName) => {
      expect(() => assertSafeContainedFileName(fileName, "win32")).toThrow(
        "invalid contained artifact",
      );
    },
  );

  it("exposes an explicit fail-closed capability check", () => {
    expect(() => assertContainedFsSupported("darwin")).not.toThrow();
    expect(() => assertContainedFsSupported("linux")).not.toThrow();
    expect(() => assertContainedFsSupported("win32")).toThrow(
      "refusing pathname fallback",
    );
  });

  it("rejects a parent replacement before Linux procfs traversal", () => {
    const { root, handle } = makeRunDir();
    const outside = mkdtempSync(join(tmpdir(), "omc-safe-fs-outside-"));
    tempDirs.push(outside);
    renameSync(root, `${root}-original`);
    symlinkSync(outside, root);
    try {
      expect(() => readContainedFileNoFollow(handle, "artifact.txt")).toThrow();
    } finally {
      unlinkSync(root);
      renameSync(`${root}-original`, root);
    }
  });

  it("validates names before Linux procfs traversal", () => {
    const { handle } = makeRunDir();
    expect(() => readContainedFileNoFollow(handle, "../outside.txt")).toThrow(
      "invalid contained artifact",
    );
  });

  it("fails closed for every operation on unsupported platforms", () => {
    const { handle } = makeRunDir();
    for (const operation of ["read", "write", "rename", "delete"]) {
      expect(() =>
        withContainedPathForPlatform(handle, "artifact.txt", () => operation, "win32"),
      ).toThrow("refusing pathname fallback");
    }
  });
});
