import { closeSync, constants, fstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSync } from "node:fs";
import { getNativeContainedFs } from "../../runtime/native-contained-fs.js";

describe.runIf(process.platform === "darwin")("real Darwin directory-relative backend", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function root() {
    const value = realpathSync(mkdtempSync(join(tmpdir(), "omc-native-fs-")));
    roots.push(value);
    return value;
  }

  it("keeps all operations anchored after the directory pathname is replaced", () => {
    const base = root();
    const run = join(base, "run");
    const original = join(base, "original");
    const outside = join(base, "outside");
    mkdirSync(run); mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "unchanged");
    const fd = openSync(run, constants.O_RDONLY | constants.O_DIRECTORY);
    const api = getNativeContainedFs();
    try {
      renameSync(run, original);
      symlinkSync(outside, run);
      api.mkdirAt(fd, "child", 0o700);
      const file = api.openAt(fd, "artifact", constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      try {
        writeFileSync(file, "contained");
        expect(api.statAt(fd, "artifact").ino).toBe(fstatSync(file).ino);
      } finally { closeSync(file); }
      api.renameAt(fd, "artifact", "renamed");
      api.linkAt(fd, "renamed", "backup");
      expect(api.statAt(fd, "backup").nlink).toBe(2);
      expect(() => api.linkAt(fd, "renamed", "backup")).toThrow(expect.objectContaining({ code: "EEXIST" }));
      const entries = ["backup", "child", "renamed"];
      expect(api.readDir(fd).sort()).toEqual(entries);
      expect(api.readDir(fd).sort()).toEqual(entries);
      expect(api.realpathFd(fd)).toBe(original);
      expect(readFileSync(join(original, "renamed"), "utf8")).toBe("contained");
      api.unlinkAt(fd, "backup"); api.unlinkAt(fd, "renamed");
      expect(api.readDir(fd)).toEqual(["child"]);
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("unchanged");
      const outsideFd = openSync(outside, constants.O_RDONLY | constants.O_DIRECTORY);
      try { expect(api.readDir(outsideFd)).toEqual(["sentinel"]); } finally { closeSync(outsideFd); }
    } finally { closeSync(fd); }
  });

  it("enforces no-follow and reports missing paths with Node errno codes", () => {
    const base = root();
    const fd = openSync(base, constants.O_RDONLY | constants.O_DIRECTORY);
    const api = getNativeContainedFs();
    try {
      writeFileSync(join(base, "target"), "unchanged");
      symlinkSync("target", join(base, "symlink"));
      linkSync(join(base, "target"), join(base, "hardlink"));
      expect(() => api.openAt(fd, "symlink", constants.O_WRONLY | constants.O_TRUNC, 0o600)).toThrow(expect.objectContaining({ code: "ELOOP" }));
      expect(api.statAt(fd, "symlink").mode & constants.S_IFMT).toBe(constants.S_IFLNK);
      expect(api.statAt(fd, "hardlink").nlink).toBe(2);
      expect(() => api.statAt(fd, "absent")).toThrow(expect.objectContaining({ code: "ENOENT" }));
      expect(readFileSync(join(base, "target"), "utf8")).toBe("unchanged");
    } finally { closeSync(fd); }
  });

  it.each(["", ".", "..", "../escape", "/absolute", "nested/name", "nested\\name", "nul\0suffix"])("rejects unsafe native basename %j before a syscall", (name) => {
    const base = root();
    const fd = openSync(base, constants.O_RDONLY | constants.O_DIRECTORY);
    const api = getNativeContainedFs();
    try {
      for (const operation of [
        () => api.openAt(fd, name, constants.O_CREAT | constants.O_WRONLY, 0o600),
        () => api.mkdirAt(fd, name, 0o700),
        () => api.statAt(fd, name),
        () => api.unlinkAt(fd, name),
        () => api.renameAt(fd, "source", name),
        () => api.linkAt(fd, "source", name),
      ]) expect(operation).toThrow();
      expect(api.readDir(fd)).toEqual([]);
    } finally { closeSync(fd); }
  });
});
