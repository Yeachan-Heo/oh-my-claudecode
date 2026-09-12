import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeContainedFs {
  openAt(directoryFd: number, name: string, flags: number, mode: number): number;
  mkdirAt(directoryFd: number, name: string, mode: number): void;
  statAt(directoryFd: number, name: string): {
    dev: number;
    ino: number;
    mode: number;
    nlink: number;
    size: number;
    mtimeMs: number;
  };
  renameAt(directoryFd: number, source: string, destination: string): void;
  unlinkAt(directoryFd: number, name: string): void;
  linkAt(directoryFd: number, source: string, destination: string): void;
  readDir(directoryFd: number): string[];
  /** For containment checks only. Never use this path for a mutation. */
  realpathFd(fd: number): string;
}

let loaded: NativeContainedFs | undefined;

/** Resolve from this installed module, including the bridge CJS import.meta polyfill. */
export function getNativeContainedFs(): NativeContainedFs {
  if (loaded) return loaded;
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const metadata = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (metadata.name === "oh-my-claude-sisyphus") {
        const binary = join(directory, "native", `contained-fs-${process.platform}-${process.arch}.node`);
        try {
          loaded = createRequire(import.meta.url)(binary) as NativeContainedFs;
          return loaded;
        } catch (cause) {
          throw new Error(`The contained filesystem backend is unavailable at ${binary}. Build it with node scripts/build-contained-fs.mjs before running graph commands.`, { cause });
        }
      }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot locate the OMC package for the contained filesystem backend");
    directory = parent;
  }
}
