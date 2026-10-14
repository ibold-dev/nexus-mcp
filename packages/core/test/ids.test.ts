import { describe, expect, it } from "vitest";
import {
  contentHash,
  fileId,
  normalizeRelativePath,
  normalizeRootPath,
  repositoryId,
  symbolId,
} from "../src/ids.js";

describe("repositoryId", () => {
  it("is stable for the same root and salt", () => {
    expect(repositoryId("/work/app", "salt")).toBe(repositoryId("/work/app", "salt"));
  });

  it("changes when the project salt changes", () => {
    expect(repositoryId("/work/app", "a")).not.toBe(repositoryId("/work/app", "b"));
  });

  it("normalizes trailing separators so the same repo gets one id", () => {
    expect(repositoryId("/work/app/", "s")).toBe(repositoryId("/work/app", "s"));
  });
});

describe("normalizeRootPath", () => {
  it("removes trailing separators but keeps filesystem root", () => {
    expect(normalizeRootPath("/work/app///")).toBe("/work/app");
    expect(normalizeRootPath("/")).toBe("/");
  });
});

describe("normalizeRelativePath", () => {
  it("uses forward slashes and strips leading ./", () => {
    expect(normalizeRelativePath("src\\lib\\a.ts")).toBe("src/lib/a.ts");
    expect(normalizeRelativePath("./src/a.ts")).toBe("src/a.ts");
  });

  it("rejects paths that escape the repository", () => {
    expect(() => normalizeRelativePath("../secret.ts")).toThrow(/escapes repository root/);
    expect(() => normalizeRelativePath("/etc/passwd")).toThrow(/escapes repository root/);
  });
});

describe("fileId", () => {
  it("is the same for equivalent path spellings", () => {
    expect(fileId("repo", "src/a.ts")).toBe(fileId("repo", "./src\\a.ts"));
  });

  it("differs across repositories for the same relative path", () => {
    expect(fileId("repo-a", "src/a.ts")).not.toBe(fileId("repo-b", "src/a.ts"));
  });
});

describe("symbolId", () => {
  const file = fileId("repo", "src/a.ts");

  it("does not depend on position, so edits above a symbol keep its id", () => {
    expect(symbolId(file, "function", "run", 0)).toBe(symbolId(file, "function", "run", 0));
  });

  it("changes when kind, qualified name, or occurrence changes", () => {
    expect(symbolId(file, "function", "run", 0)).not.toBe(symbolId(file, "method", "run", 0));
    expect(symbolId(file, "method", "A.run", 0)).not.toBe(symbolId(file, "method", "B.run", 0));
    expect(symbolId(file, "function", "run", 0)).not.toBe(symbolId(file, "function", "run", 1));
  });

  it("rejects invalid occurrences", () => {
    expect(() => symbolId(file, "function", "run", -1)).toThrow(/Invalid occurrence/);
    expect(() => symbolId(file, "function", "run", 1.5)).toThrow(/Invalid occurrence/);
  });

  it("does not collide when parts shift across the separator", () => {
    expect(symbolId("ab", "c", "d", 0)).not.toBe(symbolId("a", "bc", "d", 0));
  });
});

describe("contentHash", () => {
  it("is deterministic and sensitive to content", () => {
    expect(contentHash("export const a = 1;")).toBe(contentHash("export const a = 1;"));
    expect(contentHash("export const a = 1;")).not.toBe(contentHash("export const a = 2;"));
  });
});
