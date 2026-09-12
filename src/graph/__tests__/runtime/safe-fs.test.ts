import {
  existsSync,
  mkdtempSync, realpathSync,
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
  mkdirSync,
} from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRunDirHandle } from "../../runtime/run-dir.js";
import type { DirectoryOperations } from "../../runtime/contained-fd.js";
import { atomicWriteFileSync } from "../../../lib/atomic-write.js";
import {
  containedPathForPlatform,
  assertSafeContainedFileName,
  assertContainedFsSupported,
  readFileNoFollow,
  readContainedFileNoFollow,
  withContainedDirectory,
  withContainedOperations,
  readOperationFileNoFollow,
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
    const root = mkdtempSync(join(realpathSync(tmpdir()), "omc-safe-fs-test-"));
    tempDirs.push(root);
    const handle = resolveRunDirHandle(root, runId);
    return { root, handle };
  }

  it("only exposes Linux kernel paths without mutating platform state", () => {
    const before = process.platform;

    expect(
      containedPathForPlatform(7, "/runs/example", "artifact", "linux"),
    ).toBe("/proc/self/fd/7/artifact");

    expect(() => containedPathForPlatform(7, "/runs/example", "artifact", "darwin"))
      .toThrow();
    expect(() => containedPathForPlatform(7, "C:/runs/example", "artifact", "win32"))
      .toThrow("refusing pathname fallback");

    expect(process.platform).toBe(before);
  });

  it("reads, writes, renames, and deletes through actual host directory operations", () => {
    const { handle } = makeRunDir();
    withContainedOperations(handle, (ops) => {
      const fd = ops.open("artifact.txt", fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
      try { writeFileSync(fd, "after"); } finally { closeSync(fd); }
      expect(readOperationFileNoFollow(ops, "artifact.txt")).toBe("after");
      ops.rename("artifact.txt", "renamed.txt");
      expect(readOperationFileNoFollow(ops, "renamed.txt")).toBe("after");
      ops.unlink("renamed.txt");
      expect(ops.readDir()).toEqual([]);
    });
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

  it("keeps a validated operation scope on the original inode after replacement", () => {
    const { root, handle } = makeRunDir();
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "untouched");
    const moved = `${handle.path}-original`;
    withContainedOperations(handle, (ops) => {
      renameSync(handle.path, moved);
      symlinkSync(outside, handle.path);
      const fd = ops.open("artifact", fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
      try { writeFileSync(fd, "original"); } finally { closeSync(fd); }
      ops.rename("artifact", "renamed");
      ops.link("renamed", "backup");
      expect(ops.readDir().sort()).toEqual(["backup", "renamed"]);
      expect(ops.readDir().sort()).toEqual(["backup", "renamed"]);
      ops.unlink("backup");
      expect(readOperationFileNoFollow(ops, "renamed")).toBe("original");
      ops.unlink("renamed");
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("untouched");
      expect(existsSync(join(outside, "renamed"))).toBe(false);
    });
    expect(() => withContainedOperations(handle, () => undefined)).toThrow();
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
    if (process.platform === "darwin") {
      expect(() => assertContainedFsSupported("darwin")).not.toThrow();
    } else {
      expect(() => assertContainedFsSupported("darwin")).toThrow();
    }
    expect(() => assertContainedFsSupported("linux")).not.toThrow();
    expect(() => assertContainedFsSupported("win32")).toThrow(
      "refusing pathname fallback",
    );
  });

  it("rejects a parent replacement before contained traversal", () => {
    const { root, handle } = makeRunDir();
    const outside = mkdtempSync(join(realpathSync(tmpdir()), "omc-safe-fs-outside-"));
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

  it("validates names before contained traversal", () => {
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

  it("invalidates every operation after its synchronous scope closes", () => {
    const { handle } = makeRunDir();
    let retained!: DirectoryOperations;
    withContainedOperations(handle, (ops) => { retained = ops; });
    for (const operation of [
      () => retained.open("artifact", fsConstants.O_CREAT | fsConstants.O_WRONLY),
      () => retained.mkdir("child"), () => retained.lstat("artifact"),
      () => retained.rename("a", "b"), () => retained.link("a", "b"),
      () => retained.unlink("artifact"), () => retained.readDir(),
      () => retained.realpath(), () => retained.sync(),
    ]) expect(operation).toThrow("outside synchronous callback");
  });

  it.each([false, true])("anchors atomic publication and rollback through replacement (rollback=%s)", (rollback) => {
    const { root, handle } = makeRunDir();
    const outside = join(root, "outside");
    const moved = `${handle.path}-original`;
    mkdirSync(outside);
    writeFileSync(join(outside, "artifact"), "outside");
    writeFileSync(join(handle.path, "artifact"), "before");
    withContainedOperations(handle, (ops) => {
      const publish = () => atomicWriteFileSync("artifact", "after", {
        beforeRename: () => {
          renameSync(handle.path, moved);
          symlinkSync(outside, handle.path);
        },
        afterRename: () => { if (rollback) throw new Error("ownership lost"); },
      }, ops);
      if (rollback) expect(publish).toThrow("ownership lost");
      else publish();
      expect(readOperationFileNoFollow(ops, "artifact")).toBe(rollback ? "before" : "after");
      expect(ops.readDir()).toEqual(["artifact"]);
    });
    expect(readFileSync(join(outside, "artifact"), "utf8")).toBe("outside");
  });
});
