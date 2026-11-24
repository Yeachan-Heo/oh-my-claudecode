import * as fs from "fs";
import { getNativeContainedFs } from "./native-contained-fs.js";
function component(name) {
    if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) {
        throw new RangeError("invalid directory-relative component");
    }
}
/** Path callbacks are a Linux-only compatibility API. Darwin requires *at. */
export function containedFdPath(fd, platform, child) {
    if (platform !== "linux") {
        throw new Error(`traversable directory-FD paths unavailable on ${platform}`);
    }
    if (child !== undefined)
        component(child);
    return `/proc/self/fd/${fd}${child === undefined ? "" : `/${child}`}`;
}
export function containedFsPlatformSupported(platform) {
    if (platform === "linux")
        return true;
    if (platform !== "darwin" || process.platform !== "darwin")
        return false;
    try {
        return getNativeContainedFs() !== null;
    }
    catch {
        return false;
    }
}
export function directoryOperations(fd, platform = process.platform) {
    if (platform === "linux") {
        const path = (name) => containedFdPath(fd, platform, name);
        return {
            open: (name, flags, mode = 0o600) => fs.openSync(path(name), flags | fs.constants.O_NOFOLLOW, mode),
            mkdir: (name, mode = 0o777) => { fs.mkdirSync(path(name), { mode }); },
            lstat: (name) => fs.lstatSync(path(name)),
            rename: (source, destination) => fs.renameSync(path(source), path(destination)),
            unlink: (name) => fs.unlinkSync(path(name)),
            link: (source, destination) => fs.linkSync(path(source), path(destination)),
            readDir: () => fs.readdirSync(containedFdPath(fd, platform)),
            realpath: () => fs.realpathSync(containedFdPath(fd, platform)),
            sync: () => fs.fsyncSync(fd),
        };
    }
    if (platform !== "darwin" || process.platform !== "darwin") {
        throw new Error(`contained directory operations unavailable on ${platform}`);
    }
    const native = getNativeContainedFs();
    if (!native) {
        throw new Error("native contained directory operations unavailable on darwin; refusing pathname fallback");
    }
    const checked = (name) => { component(name); return name; };
    return {
        open: (name, flags, mode = 0o600) => native.openAt(fd, checked(name), flags | fs.constants.O_NOFOLLOW, mode),
        mkdir: (name, mode = 0o777) => native.mkdirAt(fd, checked(name), mode),
        lstat: (name) => {
            const stats = native.statAt(fd, checked(name));
            return {
                ...stats,
                isFile: () => (stats.mode & 0o170000) === 0o100000,
                isDirectory: () => (stats.mode & 0o170000) === 0o040000,
                isSymbolicLink: () => (stats.mode & 0o170000) === 0o120000,
            };
        },
        rename: (source, destination) => native.renameAt(fd, checked(source), checked(destination)),
        unlink: (name) => native.unlinkAt(fd, checked(name)),
        link: (source, destination) => native.linkAt(fd, checked(source), checked(destination)),
        readDir: () => native.readDir(fd),
        realpath: () => native.realpathFd(fd),
        sync: () => fs.fsyncSync(fd),
    };
}
//# sourceMappingURL=contained-fd.js.map