/**
 * Nikoflow property-based-testing (PBT) support — deep tier only.
 *
 * Detects which PBT framework fits the project by its manifest and whether the
 * library is already installed, then turns that into a per-ticket obligation:
 *   ready     → use the detected framework
 *   needs-lib → framework fits the language but isn't installed; ask the user
 *               before adding a dev dependency (no speculative deps)
 *   waived    → not deep tier, or no supported framework for this language
 *
 * A Stop hook can attest the presence of PBT evidence but never the QUALITY of
 * the properties — that stays the reviewer's job (see the execute prompt).
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

export type PbtFramework = "hypothesis" | "fast-check" | "rapid";
export type PbtStatus = "ready" | "needs-lib" | "waived";

export interface PbtDetection {
  language: "python" | "node" | "go";
  framework: PbtFramework;
  /** Whether the framework library appears in the project's manifest. */
  available: boolean;
}

export interface PbtObligation {
  required: boolean;
  status: PbtStatus;
  framework?: PbtFramework;
  reason: string;
}

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

/**
 * Detect the PBT framework for a project by manifest presence. Deterministic
 * priority when a repo is polyglot: python → node → go (first manifest wins).
 * Returns null when no supported manifest is present.
 */
export function detectPbtFramework(directory: string): PbtDetection | null {
  // package.json is the strongest primary-language signal, so it ranks above a
  // bare requirements.txt (which node/TS repos often carry for CI/docs tooling).
  const pkg = readIfExists(join(directory, "package.json"));
  if (pkg !== null) {
    return { language: "node", framework: "fast-check", available: nodeHasFastCheck(pkg) };
  }

  const pyproject = readIfExists(join(directory, "pyproject.toml"));
  const requirements = readIfExists(join(directory, "requirements.txt"));
  if (pyproject !== null || requirements !== null) {
    const hay = `${pyproject ?? ""}\n${requirements ?? ""}`;
    return { language: "python", framework: "hypothesis", available: /\bhypothesis\b/i.test(hay) };
  }

  const goMod = readIfExists(join(directory, "go.mod"));
  if (goMod !== null) {
    const goSum = readIfExists(join(directory, "go.sum")) ?? "";
    return {
      language: "go",
      framework: "rapid",
      available: /pgregory\.net\/rapid/.test(`${goMod}\n${goSum}`),
    };
  }

  return null;
}

/** Parse package.json deps and check for fast-check, incl. scoped wrappers. */
function nodeHasFastCheck(pkgText: string): boolean {
  try {
    const pkg = JSON.parse(pkgText) as Record<string, unknown>;
    const deps = {
      ...(pkg.dependencies as Record<string, unknown> | undefined),
      ...(pkg.devDependencies as Record<string, unknown> | undefined),
    };
    return Object.keys(deps).some(
      (name) => name === "fast-check" || name.startsWith("@fast-check/"),
    );
  } catch {
    return /"fast-check"/.test(pkgText); // fall back to substring on unparseable JSON
  }
}

/**
 * The PBT obligation for a ticket in the current project. `pbtEnabled` is the
 * deep-tier flag from nikoflow state.
 */
export function pbtObligation(directory: string, pbtEnabled: boolean): PbtObligation {
  if (!pbtEnabled) {
    return { required: false, status: "waived", reason: "not deep tier" };
  }
  const det = detectPbtFramework(directory);
  if (!det) {
    return {
      required: false,
      status: "waived",
      reason: "no supported PBT framework for this project's language",
    };
  }
  if (!det.available) {
    return {
      required: true,
      status: "needs-lib",
      framework: det.framework,
      reason: `${det.framework} is not installed — ask the user before adding it as a dev dependency`,
    };
  }
  return {
    required: true,
    status: "ready",
    framework: det.framework,
    reason: `use ${det.framework}`,
  };
}
