import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
let loaded;
/** Resolve from this installed module, including the bridge CJS import.meta polyfill. */
export function getNativeContainedFs() {
    if (loaded)
        return loaded;
    let directory = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        const manifest = join(directory, "package.json");
        if (existsSync(manifest)) {
            const metadata = JSON.parse(readFileSync(manifest, "utf8"));
            if (metadata.name === "oh-my-claude-sisyphus") {
                const binary = join(directory, "native", `contained-fs-${process.platform}-${process.arch}.node`);
                try {
                    loaded = createRequire(import.meta.url)(binary);
                    return loaded;
                }
                catch (cause) {
                    throw new Error(`The contained filesystem backend is unavailable at ${binary}. Build it with node scripts/build-contained-fs.mjs before running graph commands.`, { cause });
                }
            }
        }
        const parent = dirname(directory);
        if (parent === directory)
            throw new Error("Cannot locate the OMC package for the contained filesystem backend");
        directory = parent;
    }
}
//# sourceMappingURL=native-contained-fs.js.map