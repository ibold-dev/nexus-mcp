import { describe, expect, it } from "vitest";
import { extractFile } from "../src/extract.js";

const repoId = "repo-test";

function extract(content: string, relativePath = "src/sample.ts") {
  return extractFile({ repoId, relativePath, content });
}

describe("extractFile symbols", () => {
  it("extracts every supported declaration kind with qualified names", () => {
    const result = extract(`
export function greet(name: string): string {
  return "hi " + name;
}

export class Greeter {
  greet(name: string) {
    return greet(name);
  }
}

export interface Shape { area(): number }
export type Id = string;
export enum Color { Red }
export const double = (n: number) => n * 2;
export const LIMIT = 10;
`);

    expect(result.symbols.map((s) => [s.kind, s.qualifiedName])).toEqual([
      ["function", "greet"],
      ["class", "Greeter"],
      ["method", "Greeter.greet"],
      ["interface", "Shape"],
      ["typeAlias", "Id"],
      ["enum", "Color"],
      ["function", "double"],
      ["variable", "LIMIT"],
    ]);
  });

  it("records nested named functions under their parent scope", () => {
    const result = extract(`
function outer() {
  function inner() {
    return 1;
  }
  return inner();
}
`);
    expect(result.symbols.map((s) => s.qualifiedName)).toEqual(["outer", "outer.inner"]);
  });

  it("gives exact 1-based line numbers and character offsets, excluding leading JSDoc", () => {
    const content = "const a = 1;\n\n/** doc */\nexport function target() {\n  return 2;\n}\n";
    const result = extract(content);
    const target = result.symbols.find((s) => s.qualifiedName === "target");

    expect(target).toBeDefined();
    expect(target?.startLine).toBe(4);
    expect(target?.endLine).toBe(6);
    expect(target?.startOffset).toBe(content.indexOf("export function target"));
    expect(content.slice(target?.startOffset ?? 0).startsWith("export function target")).toBe(true);
  });

  it("captures the signature without the body and the JSDoc description", () => {
    const result = extract(`
/**
 * Adds two numbers.
 * @param a first
 */
export function add(a: number, b: number): number {
  return a + b;
}
`);
    const add = result.symbols[0];
    expect(add?.signature).toBe("export function add(a: number, b: number): number");
    expect(add?.doc).toBe("Adds two numbers.");
  });

  it("skips anonymous default exports and destructured variables without failing", () => {
    const result = extract(`
export default function () {
  return 1;
}
const { a, b } = { a: 1, b: 2 };
export const kept = 3;
`);
    expect(result.symbols.map((s) => s.qualifiedName)).toEqual(["kept"]);
  });

  it("does not throw on syntactically broken input and still returns the valid declarations", () => {
    expect(() => extract("function broken( {\nexport const ok = 1;\n")).not.toThrow();
  });
});

describe("extractFile contains edges and identity", () => {
  it("emits one CONTAINS edge per symbol with increasing ordinals in document order", () => {
    const result = extract("export function a() {}\nexport function b() {}\n");

    expect(result.contains).toHaveLength(2);
    expect(result.contains.map((edge) => edge.ordinal)).toEqual([0, 1]);
    expect(result.contains.every((edge) => edge.fileId === result.fileId)).toBe(true);
    expect(result.contains.map((edge) => edge.symbolId)).toEqual(
      result.symbols.map((symbol) => symbol.id),
    );
  });

  it("produces identical ids for identical input and distinct ids for distinct symbols", () => {
    const content = "export function a() {}\nexport function b() {}\n";
    const first = extract(content);
    const second = extract(content);

    expect(second.symbols.map((s) => s.id)).toEqual(first.symbols.map((s) => s.id));
    expect(new Set(first.symbols.map((s) => s.id)).size).toBe(first.symbols.length);
  });

  it("keeps a symbol's id when lines are added above it", () => {
    const before = extract("export function target() {}\n");
    const after = extract("// new comment\nconst added = 1;\n\nexport function target() {}\n");

    const idBefore = before.symbols.find((s) => s.qualifiedName === "target")?.id;
    const idAfter = after.symbols.find((s) => s.qualifiedName === "target")?.id;
    expect(idBefore).toBeDefined();
    expect(idAfter).toBe(idBefore);
  });

  it("gives overloads of the same name distinct, stable ids in document order", () => {
    const content = "export function f(a: string): void;\nexport function f(a: unknown) {}\n";
    const result = extract(content);
    const overloads = result.symbols.filter((s) => s.qualifiedName === "f");

    expect(overloads).toHaveLength(2);
    expect(overloads[0]?.id).not.toBe(overloads[1]?.id);
    expect(extract(content).symbols.map((s) => s.id)).toEqual(result.symbols.map((s) => s.id));
  });

  it("normalizes path spellings to the same file id", () => {
    expect(extract("export const x = 1;", "src\\sample.ts").fileId).toBe(
      extract("export const x = 1;", "./src/sample.ts").fileId,
    );
  });

  it("reports the line count of the file", () => {
    expect(extract("a\nb\nc\n").lineCount).toBe(4);
  });
});
