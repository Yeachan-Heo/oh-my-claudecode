import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectPbtFramework, pbtObligation } from "../index.js";

describe("nikoflow PBT (TSK-007)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nikoflow-pbt-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, content: string) => writeFileSync(join(dir, name), content);

  describe("detectPbtFramework", () => {
    it("python → hypothesis, available when listed", () => {
      write("requirements.txt", "pytest\nhypothesis>=6.0\n");
      expect(detectPbtFramework(dir)).toEqual({ language: "python", framework: "hypothesis", available: true });
    });
    it("python → hypothesis, not available when absent", () => {
      write("pyproject.toml", "[project]\nname='x'\n");
      expect(detectPbtFramework(dir)).toEqual({ language: "python", framework: "hypothesis", available: false });
    });
    it("node → fast-check, available when in package.json", () => {
      write("package.json", `{"devDependencies":{"fast-check":"^3.0.0"}}`);
      expect(detectPbtFramework(dir)).toEqual({ language: "node", framework: "fast-check", available: true });
    });
    it("go → rapid, available when in go.mod", () => {
      write("go.mod", "module x\nrequire pgregory.net/rapid v1.0.0\n");
      expect(detectPbtFramework(dir)).toEqual({ language: "go", framework: "rapid", available: true });
    });
    it("returns null for an unsupported project", () => {
      write("Cargo.toml", "[package]\n");
      expect(detectPbtFramework(dir)).toBeNull();
    });
    it("node wins over a stray requirements.txt (polyglot priority)", () => {
      write("package.json", `{"devDependencies":{"fast-check":"^3"}}`);
      write("requirements.txt", "hypothesis\n"); // CI/docs tooling, not the primary language
      expect(detectPbtFramework(dir)!.language).toBe("node");
    });
    it("recognizes scoped fast-check wrappers", () => {
      write("package.json", `{"devDependencies":{"@fast-check/vitest":"^0.1"}}`);
      expect(detectPbtFramework(dir)).toEqual({ language: "node", framework: "fast-check", available: true });
    });
  });

  describe("pbtObligation", () => {
    it("waives when not deep tier", () => {
      write("package.json", `{"devDependencies":{"fast-check":"^3"}}`);
      expect(pbtObligation(dir, false)).toMatchObject({ required: false, status: "waived" });
    });
    it("waives on an unsupported language even in deep tier", () => {
      write("Cargo.toml", "[package]\n");
      expect(pbtObligation(dir, true)).toMatchObject({ required: false, status: "waived" });
    });
    it("requires + needs-lib when the framework is missing", () => {
      write("pyproject.toml", "[project]\n");
      expect(pbtObligation(dir, true)).toMatchObject({ required: true, status: "needs-lib", framework: "hypothesis" });
    });
    it("ready when the framework is installed", () => {
      write("package.json", `{"devDependencies":{"fast-check":"^3"}}`);
      expect(pbtObligation(dir, true)).toMatchObject({ required: true, status: "ready", framework: "fast-check" });
    });
  });
});
