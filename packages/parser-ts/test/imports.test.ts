import { describe, expect, it } from "vitest";
import { fileId } from "@nexus/core";
import { extractImports, type SourceInput } from "../src/imports.js";

const repoId = "repo-test";

function imports(sources: SourceInput[], from: string) {
  const result = extractImports(repoId, sources).find((entry) => entry.relativePath === from);
  if (!result) {
    throw new Error(`no result for ${from}`);
  }
  return result;
}

describe("extractImports resolution labels", () => {
  it("creates a resolved IMPORTS edge for a relative import of a sibling file", () => {
    const result = imports(
      [
        { relativePath: "src/a.ts", content: `import { b } from "./b";\nexport const a = b;\n` },
        { relativePath: "src/b.ts", content: `export const b = 1;\n` },
      ],
      "src/a.ts",
    );

    expect(result.edges).toEqual([
      {
        fromFileId: fileId(repoId, "src/a.ts"),
        toFileId: fileId(repoId, "src/b.ts"),
        specifier: "./b",
        typeOnly: false,
        resolution: "resolved",
        confidence: 1,
      },
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it("resolves a .js specifier to a .ts source file, as NodeNext-style code does", () => {
    const result = imports(
      [
        { relativePath: "src/a.ts", content: `import { b } from "./b.js";\n` },
        { relativePath: "src/b.ts", content: `export const b = 1;\n` },
      ],
      "src/a.ts",
    );
    expect(result.edges.map((edge) => edge.toFileId)).toEqual([fileId(repoId, "src/b.ts")]);
  });

  it("resolves a directory import to its index file", () => {
    const result = imports(
      [
        { relativePath: "src/a.ts", content: `import { x } from "./lib";\n` },
        { relativePath: "src/lib/index.ts", content: `export const x = 1;\n` },
      ],
      "src/a.ts",
    );
    expect(result.edges.map((edge) => edge.toFileId)).toEqual([
      fileId(repoId, "src/lib/index.ts"),
    ]);
  });

  it("treats re-exports as IMPORTS edges", () => {
    const result = imports(
      [
        { relativePath: "src/index.ts", content: `export * from "./b";\nexport { c } from "./c";\n` },
        { relativePath: "src/b.ts", content: `export const b = 1;\n` },
        { relativePath: "src/c.ts", content: `export const c = 1;\n` },
      ],
      "src/index.ts",
    );
    expect(result.edges.map((edge) => edge.toFileId).sort()).toEqual(
      [fileId(repoId, "src/b.ts"), fileId(repoId, "src/c.ts")].sort(),
    );
  });

  it("marks type-only imports", () => {
    const result = imports(
      [
        { relativePath: "src/a.ts", content: `import type { T } from "./types";\n` },
        { relativePath: "src/types.ts", content: `export type T = string;\n` },
      ],
      "src/a.ts",
    );
    expect(result.edges[0]?.typeOnly).toBe(true);
  });

  it("never creates an edge for a package import, and keeps the raw specifier", () => {
    const result = imports(
      [{ relativePath: "src/a.ts", content: `import _ from "lodash";\nimport fs from "node:fs";\n` }],
      "src/a.ts",
    );
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual(["lodash", "node:fs"]);
  });

  it("keeps a missing relative import as unresolved instead of guessing a target", () => {
    const result = imports(
      [
        { relativePath: "src/a.ts", content: `import { x } from "./missing";\n` },
        { relativePath: "src/b.ts", content: `export const x = 1;\n` },
      ],
      "src/a.ts",
    );
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual(["./missing"]);
  });

  it("records a cycle as two edges without failing", () => {
    const sources: SourceInput[] = [
      { relativePath: "src/a.ts", content: `import { b } from "./b";\nexport const a = 1;\n` },
      { relativePath: "src/b.ts", content: `import { a } from "./a";\nexport const b = 1;\n` },
    ];
    const results = extractImports(repoId, sources);
    expect(results.map((entry) => entry.edges.length)).toEqual([1, 1]);
  });

  it("is deterministic when a specifier could match both a file and a folder index", () => {
    const sources: SourceInput[] = [
      { relativePath: "src/a.ts", content: `import { x } from "./dup";\n` },
      { relativePath: "src/dup.ts", content: `export const x = 1;\n` },
      { relativePath: "src/dup/index.ts", content: `export const x = 2;\n` },
    ];
    const first = imports(sources, "src/a.ts");
    const second = imports(sources, "src/a.ts");

    expect(first.edges).toHaveLength(1);
    expect(first.edges).toEqual(second.edges);
  });

  it("deduplicates repeated imports of the same module with the same kind", () => {
    const result = imports(
      [
        {
          relativePath: "src/a.ts",
          content: `import { x } from "./b";\nimport { y } from "./b";\n`,
        },
        { relativePath: "src/b.ts", content: `export const x = 1;\nexport const y = 2;\n` },
      ],
      "src/a.ts",
    );
    expect(result.edges).toHaveLength(1);
  });
});
