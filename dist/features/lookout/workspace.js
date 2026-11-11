import { execFileSync } from "child_process";
import { lstatSync } from "fs";
import { dirname, join, resolve } from "path";
import { LookoutError } from "./types.js";
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SECRETS_PATH = /(?:^|\/)\.env(?![\w-])(?!(?:\.[\w-]+)*\.(?:example|sample|template|dist)\b)(?:\.[\w-]+)*$|(?:^|\/)secrets?\.(?:json|ya?ml|txt)$|(?:^|\/)secrets?\//i;
function sanitizedGitEnv() {
    const env = { ...process.env };
    for (const key of [
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_COUNT",
        "GIT_OBJECT_DIRECTORY",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_IMPLICIT_WORK_TREE",
        "GIT_GRAFT_FILE",
        "GIT_INDEX_FILE",
        "GIT_NO_REPLACE_OBJECTS",
        "GIT_REPLACE_REF_BASE",
        "GIT_PREFIX",
        "GIT_INTERNAL_SUPER_PREFIX",
        "GIT_SHALLOW_FILE",
        "GIT_COMMON_DIR",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    ]) {
        delete env[key];
    }
    env.LC_ALL = "C";
    return env;
}
function gitArgs(args) {
    return ["-c", "core.fsmonitor=false", "--no-optional-locks", ...args];
}
function runGit(args, cwd) {
    try {
        return execFileSync("git", gitArgs(args), {
            cwd,
            encoding: "utf8",
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER_BYTES,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            env: sanitizedGitEnv(),
        });
    }
    catch (error) {
        const failure = error;
        const stderr = String(failure.stderr ?? "");
        throw new LookoutError(`git ${args[0]} failed in ${cwd}: ${stderr.trim() || "unknown error"}`, 2);
    }
}
function hasGitEntry(dir) {
    let current = resolve(dir);
    for (;;) {
        try {
            lstatSync(join(current, ".git"));
            return true;
        }
        catch (error) {
            const code = error.code;
            if (code !== "ENOENT")
                return true;
        }
        const parent = dirname(current);
        if (parent === current)
            return false;
        current = parent;
    }
}
export function repoRoot(repoArg) {
    let top;
    try {
        top = execFileSync("git", gitArgs(["rev-parse", "--show-toplevel"]), {
            cwd: repoArg,
            encoding: "utf8",
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER_BYTES,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            env: sanitizedGitEnv(),
        });
    }
    catch (error) {
        const failure = error;
        const stderr = String(failure.stderr ?? "");
        if (/not a git repository/i.test(stderr)) {
            if (hasGitEntry(repoArg)) {
                throw new LookoutError(`Cannot scan "${repoArg}": a repository exists here but git could not read it (${stderr.trim()}).`, 2);
            }
            return null;
        }
        if (failure.code === "ENOENT") {
            throw new LookoutError(`Cannot scan "${repoArg}": the directory does not exist (or the git executable is unavailable).`, 2);
        }
        throw new LookoutError(`git rev-parse failed in ${repoArg}: ${stderr.trim() || "unknown error"}`, 2);
    }
    return top.endsWith("\n") ? top.slice(0, -1) : top;
}
export function scanWorkspace(root, advice) {
    const findings = [];
    const tracked = runGit(["ls-files", "-z"], root);
    if (tracked) {
        const secretPaths = tracked
            .split("\0")
            .filter((line) => line.length > 0)
            .filter((line) => SECRETS_PATH.test(line))
            .slice(0, 5);
        if (secretPaths.length > 0) {
            findings.push({
                id: "lookout.ws.secrets-present",
                title: "Tracked secret-looking files exist in the repository",
                severity: "medium",
                confidence: "high",
                actionable: true,
                evidence: secretPaths,
                advice: "Agents can read these by default. Keep the task away from them, or " +
                    "if the run must touch them, " + advice.gate,
            });
        }
    }
    const status = runGit(["status", "--porcelain", "-uall", "--ignore-submodules=none"], root);
    const statusRecords = status.replace(/\r?\n$/, "");
    if (statusRecords.length > 0) {
        findings.push({
            id: "lookout.ws.dirty-worktree",
            title: "Working tree has uncommitted changes",
            severity: "low",
            confidence: "high",
            actionable: true,
            evidence: statusRecords.split("\n").slice(0, 5),
            advice: advice.checkpoint,
        });
    }
    return findings;
}
//# sourceMappingURL=workspace.js.map