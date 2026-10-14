import { describe, expect, it } from "vitest";
import { contentHash } from "@nexus/core";
import { analyzeRepository, RepositoryAnalyzer, type FileAnalysis, type SourceInput } from "../src/index.js";

const repoId = "repo-calls";

function analyze(sources: SourceInput[]): FileAnalysis[] {
  return analyzeRepository(repoId, sources);
}

function fileNamed(results: FileAnalysis[], relativePath: string): FileAnalysis {
  const file = results.find((entry) => entry.relativePath === relativePath);
  if (!file) {
    throw new Error(`no analysis for ${relativePath}`);
  }
  return file;
}

function idOf(results: FileAnalysis[], relativePath: string, qualifiedName: string): string {
  const symbol = fileNamed(results, relativePath).symbols.find((s) => s.qualifiedName === qualifiedName);
  if (!symbol) {
    throw new Error(`no symbol ${qualifiedName} in ${relativePath}`);
  }
  return symbol.id;
}

describe("analyzeRepository call edges", () => {
  it("resolves a call to a local function with a resolved label and the call line", () => {
    const results = analyze([
      {
        relativePath: "src/a.ts",
        content: `function helper() { return 1; }\nexport function run() {\n  return helper();\n}\n`,
      },
    ]);

    expect(fileNamed(results, "src/a.ts").calls).toEqual([
      {
        fromSymbolId: idOf(results, "src/a.ts", "run"),
        toSymbolId: idOf(results, "src/a.ts", "helper"),
        line: 3,
        resolution: "resolved",
        confidence: 1,
      },
    ]);
  });

  it("resolves a call through an import to the target file's symbol", () => {
    const results = analyze([
      { relativePath: "src/a.ts", content: `import { helper } from "./b";\nexport const run = () => helper();\n` },
      { relativePath: "src/b.ts", content: `export function helper() { return 1; }\n` },
    ]);

    const calls = fileNamed(results, "src/a.ts").calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      fromSymbolId: idOf(results, "src/a.ts", "run"),
      toSymbolId: idOf(results, "src/b.ts", "helper"),
      resolution: "resolved",
    });
  });

  it("resolves a method call on a typed instance to the method declaration", () => {
    const results = analyze([
      {
        relativePath: "src/a.ts",
        content: `class Greeter {\n  greet() { return "hi"; }\n}\nexport function run() {\n  return new Greeter().greet();\n}\n`,
      },
    ]);

    const calls = fileNamed(results, "src/a.ts").calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      fromSymbolId: idOf(results, "src/a.ts", "run"),
      toSymbolId: idOf(results, "src/a.ts", "Greeter.greet"),
      resolution: "resolved",
    });
  });

  it("attributes calls inside a nested callback to the enclosing named symbol", () => {
    const results = analyze([
      {
        relativePath: "src/a.ts",
        content: `function helper() {}\nexport function run(items: number[]) {\n  items.forEach(() => helper());\n}\n`,
      },
    ]);
    expect(fileNamed(results, "src/a.ts").calls[0]?.fromSymbolId).toBe(
      idOf(results, "src/a.ts", "run"),
    );
  });

  it("ignores module-level calls that have no enclosing symbol", () => {
    const results = analyze([
      { relativePath: "src/a.ts", content: `function helper() {}\nhelper();\n` },
    ]);
    expect(fileNamed(results, "src/a.ts").calls).toEqual([]);
  });

  it("creates no edge for calls into external or built-in code", () => {
    const results = analyze([
      {
        relativePath: "src/a.ts",
        content: `import { parse } from "some-package";\nexport function run(s: string) {\n  JSON.stringify(s);\n  return parse(s);\n}\n`,
      },
    ]);
    expect(fileNamed(results, "src/a.ts").calls).toEqual([]);
  });

  it("uses a heuristic edge with reduced confidence when the receiver type is unknown and the name is unique", () => {
    const results = analyze([
      {
        relativePath: "src/worker.ts",
        content: `export class Worker {\n  process(item: string) { return item; }\n}\n`,
      },
      {
        relativePath: "src/run.ts",
        content: `export function run(obj: any) {\n  return obj.process("x");\n}\n`,
      },
    ]);

    const calls = fileNamed(results, "src/run.ts").calls;
    expect(calls).toEqual([
      {
        fromSymbolId: idOf(results, "src/run.ts", "run"),
        toSymbolId: idOf(results, "src/worker.ts", "Worker.process"),
        line: 2,
        resolution: "heuristic",
        confidence: 0.5,
      },
    ]);
  });

  it("creates no heuristic edge when the unknown method name is ambiguous", () => {
    const results = analyze([
      { relativePath: "src/a.ts", content: `export class A {\n  process() {}\n}\n` },
      { relativePath: "src/b.ts", content: `export class B {\n  process() {}\n}\n` },
      { relativePath: "src/run.ts", content: `export function run(obj: any) {\n  obj.process();\n}\n` },
    ]);
    expect(fileNamed(results, "src/run.ts").calls).toEqual([]);
  });

  it("deduplicates repeated calls to the same target on the same line", () => {
    const results = analyze([
      {
        relativePath: "src/a.ts",
        content: `function helper() { return 1; }\nexport function run() {\n  return helper() + helper();\n}\n`,
      },
    ]);
    expect(fileNamed(results, "src/a.ts").calls).toHaveLength(1);
  });

  it("returns symbols, imports, and calls for every file in one pass", () => {
    const results = analyze([
      { relativePath: "src/a.ts", content: `import { b } from "./b";\nexport function a() { return b(); }\n` },
      { relativePath: "src/b.ts", content: `export function b() { return 1; }\n` },
    ]);
    const a = fileNamed(results, "src/a.ts");
    expect(a.symbols.map((s) => s.qualifiedName)).toEqual(["a"]);
    expect(a.imports.edges).toHaveLength(1);
    expect(a.calls).toHaveLength(1);
    expect(fileNamed(results, "src/b.ts").calls).toEqual([]);
  });
});

describe("RepositoryAnalyzer incremental updates", () => {
  function sourceUpdate(relativePath: string, content: string) {
    return { relativePath, content, hash: contentHash(content) };
  }

  function summarize(analyses: FileAnalysis[]): unknown {
    return analyses.map((file) => ({
      path: file.relativePath,
      symbols: file.symbols.map((s) => [s.id, s.qualifiedName]),
      imports: file.imports.edges.map((e) => [e.toFileId, e.specifier, e.typeOnly]).sort(),
      unresolved: file.imports.unresolved,
      calls: file.calls.map((c) => JSON.stringify([c.fromSymbolId, c.toSymbolId, c.line, c.resolution, c.confidence])).sort(),
      callErrors: file.callErrors,
    }));
  }

  const initial: SourceInput[] = [
    { relativePath: "src/a.ts", content: `import { b } from "./b";\nimport { d } from "./d";\nexport function run() { return b() + d(); }\n` },
    { relativePath: "src/b.ts", content: `export function b() { return helper(); }\nfunction helper() { return 1; }\n` },
    { relativePath: "src/c.ts", content: `export function c(o: any) { return o.process(); }\n` },
  ];

  it("matches a fresh analysis after edits, additions, renames, and deletions", () => {
    const analyzer = new RepositoryAnalyzer(repoId);
    const steps: SourceInput[][] = [
      initial,
      [
        initial[0] as SourceInput,
        { relativePath: "src/b.ts", content: `// moved\n\nexport function b() { return helper2(); }\nfunction helper2() { return 1; }\n` },
        initial[2] as SourceInput,
      ],
      [
        initial[0] as SourceInput,
        { relativePath: "src/b.ts", content: `// moved\n\nexport function b() { return helper2(); }\nfunction helper2() { return 1; }\n` },
        { relativePath: "src/d.ts", content: `export function d() { return 2; }\n` },
        initial[2] as SourceInput,
      ],
      [
        initial[0] as SourceInput,
        { relativePath: "src/d.ts", content: `export function d() { return 2; }\n` },
        initial[2] as SourceInput,
      ],
      [
        { relativePath: "src/a.ts", content: `import { d } from "./d";\nexport function run() { return d(); }\n` },
        { relativePath: "src/d.ts", content: `export function d() { return 3; }\n` },
        initial[2] as SourceInput,
      ],
    ];

    for (const step of steps) {
      const incremental = analyzer.update(step.map((s) => sourceUpdate(s.relativePath, s.content)));
      const fresh = analyzeRepository(repoId, step);
      expect(summarize(incremental.analyses)).toEqual(summarize(fresh));
    }
  });

  it("reports nothing to do when no content changed", () => {
    const analyzer = new RepositoryAnalyzer(repoId);
    const updates = initial.map((s) => sourceUpdate(s.relativePath, s.content));
    analyzer.update(updates);

    const again = analyzer.update(updates);
    expect(again.addedOrChanged).toEqual([]);
    expect(again.removed).toEqual([]);
    expect(again.recomputedCalls).toEqual([]);
  });

  it("recomputes calls only for files affected by a change", () => {
    const analyzer = new RepositoryAnalyzer(repoId);
    analyzer.update(initial.map((s) => sourceUpdate(s.relativePath, s.content)));

    const result = analyzer.update([
      sourceUpdate("src/b.ts", `// touched\n${initial[1]?.content ?? ""}`),
      sourceUpdate("src/a.ts", initial[0]?.content ?? ""),
      sourceUpdate("src/c.ts", initial[2]?.content ?? ""),
    ]);

    expect(result.addedOrChanged).toEqual(["src/b.ts"]);
    expect(result.recomputedCalls).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
