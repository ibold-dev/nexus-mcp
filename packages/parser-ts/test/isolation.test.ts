import type { SourceFile } from "ts-morph";
import { describe, expect, it, vi } from "vitest";
import { contentHash } from "@nexus/core";
import type * as callsModule from "../src/calls.js";
import type * as extractModule from "../src/extract.js";
import type * as importsModule from "../src/imports.js";
import { RepositoryAnalyzer, type SourceUpdate } from "../src/index.js";

/**
 * A file that the analyzer cannot read must not take the whole sync down with
 * it. These tests make one stage throw for one file and check that the failure
 * is reported, the file is left unindexed, and every other file is unaffected.
 */
const seams = vi.hoisted(() => ({
  symbols: new Set<string>(),
  imports: new Set<string>(),
  calls: new Set<string>(),
}));

vi.mock("../src/extract.js", async (importOriginal) => {
  const actual = await importOriginal<typeof extractModule>();
  return {
    ...actual,
    collectSymbolDrafts: (file: SourceFile) => {
      if (seams.symbols.has(file.getFilePath())) {
        throw new Error("symbol collector exploded");
      }
      return actual.collectSymbolDrafts(file);
    },
  };
});

vi.mock("../src/imports.js", async (importOriginal) => {
  const actual = await importOriginal<typeof importsModule>();
  return {
    ...actual,
    collectFileImports: (
      file: SourceFile,
      repoId: string,
      relativePath: string,
      resolve: importsModule.ModuleResolver,
      relativeByAbsolute: ReadonlyMap<string, string>,
    ) => {
      if (seams.imports.has(relativePath)) {
        throw new Error("import collector exploded");
      }
      return actual.collectFileImports(file, repoId, relativePath, resolve, relativeByAbsolute);
    },
  };
});

vi.mock("../src/calls.js", async (importOriginal) => {
  const actual = await importOriginal<typeof callsModule>();
  return {
    ...actual,
    collectCalls: (
      file: SourceFile,
      absolutePath: string,
      symbolByDeclaration: ReadonlyMap<string, string>,
      callableIdsByName: ReadonlyMap<string, readonly string[]>,
    ) => {
      if (seams.calls.has(absolutePath)) {
        throw new Error("call collector exploded");
      }
      return actual.collectCalls(file, absolutePath, symbolByDeclaration, callableIdsByName);
    },
  };
});

const repoId = "repo-isolation";

function update(relativePath: string, content: string): SourceUpdate {
  return { relativePath, content, hash: contentHash(content) };
}

function reset(): void {
  seams.symbols.clear();
  seams.imports.clear();
  seams.calls.clear();
}

const good = `export function good() { return 1; }\n`;
const bad = `export function bad() { return 2; }\n`;

describe("per-file analysis isolation", () => {
  it("skips a file whose symbol collection throws, reports it, and keeps analyzing the rest", () => {
    reset();
    seams.symbols.add("/src/bad.ts");

    const result = new RepositoryAnalyzer(repoId).update([update("src/bad.ts", bad), update("src/good.ts", good)]);

    expect(result.failures).toEqual([{ path: "src/bad.ts", error: "symbols: symbol collector exploded" }]);
    expect(result.analyses.map((file) => file.relativePath)).toEqual(["src/good.ts"]);
    expect(result.recomputedCalls).toEqual(["src/good.ts"]);
  });

  it("retries a file after a failed stage once the stage stops throwing", () => {
    reset();
    const analyzer = new RepositoryAnalyzer(repoId);

    seams.symbols.add("/src/bad.ts");
    const failed = analyzer.update([update("src/bad.ts", bad), update("src/good.ts", good)]);
    expect(failed.failures).toHaveLength(1);

    seams.symbols.delete("/src/bad.ts");
    const recovered = analyzer.update([update("src/bad.ts", bad), update("src/good.ts", good)]);

    expect(recovered.failures).toEqual([]);
    expect(recovered.addedOrChanged).toEqual(["src/bad.ts"]);
    expect(recovered.analyses.map((file) => file.relativePath)).toEqual(["src/bad.ts", "src/good.ts"]);
  });

  it("keeps a file with a failed stage out of the analysis and retries it next update", () => {
    reset();
    const analyzer = new RepositoryAnalyzer(repoId);
    const linked = `import { good } from "./good";\nexport function bad() { return good(); }\n`;
    const first = analyzer.update([update("src/bad.ts", linked), update("src/good.ts", good)]);
    expect(first.analyses.map((file) => file.relativePath)).toEqual(["src/bad.ts", "src/good.ts"]);

    seams.imports.add("src/bad.ts");
    const edited = `// moved\n${linked}`;
    const second = analyzer.update([update("src/bad.ts", edited), update("src/good.ts", good)]);

    // The file is absent entirely, so a sync has nothing half-built to write,
    // and the rest of the repository is still analyzed.
    expect(second.failures).toEqual([{ path: "src/bad.ts", error: "imports: import collector exploded" }]);
    expect(second.analyses.map((file) => file.relativePath)).toEqual(["src/good.ts"]);

    // Retried on the next update even though the content has not changed again.
    seams.imports.delete("src/bad.ts");
    const third = analyzer.update([update("src/bad.ts", edited), update("src/good.ts", good)]);

    expect(third.failures).toEqual([]);
    expect(third.addedOrChanged).toEqual(["src/bad.ts"]);
    const recovered = third.analyses.find((file) => file.relativePath === "src/bad.ts");
    expect(recovered?.imports.edges).toHaveLength(1);
    expect(recovered?.calls).toHaveLength(1);
  });

  it("keeps a file with a failed call collection out of the analysis and retries it", () => {
    reset();
    const analyzer = new RepositoryAnalyzer(repoId);
    const caller = `import { good } from "./good";\nexport function bad() { return good(); }\n`;
    analyzer.update([update("src/bad.ts", caller), update("src/good.ts", good)]);

    seams.calls.add("/src/bad.ts");
    const edited = `// moved\n${caller}`;
    const second = analyzer.update([update("src/bad.ts", edited), update("src/good.ts", good)]);

    expect(second.failures).toEqual([{ path: "src/bad.ts", error: "calls: call collector exploded" }]);
    expect(second.analyses.map((file) => file.relativePath)).toEqual(["src/good.ts"]);
    // The failed file is not counted as recomputed.
    expect(second.recomputedCalls).toEqual([]);

    seams.calls.delete("/src/bad.ts");
    const third = analyzer.update([update("src/bad.ts", edited), update("src/good.ts", good)]);
    const recovered = third.analyses.find((file) => file.relativePath === "src/bad.ts");
    expect(recovered?.symbols.map((symbol) => symbol.qualifiedName)).toEqual(["bad"]);
    expect(recovered?.calls).toHaveLength(1);
  });

  it("reports the first failing stage only, even when a later stage fails too", () => {
    reset();
    seams.symbols.add("/src/bad.ts");
    seams.calls.add("/src/bad.ts");

    const result = new RepositoryAnalyzer(repoId).update([update("src/bad.ts", bad)]);

    expect(result.failures).toEqual([{ path: "src/bad.ts", error: "symbols: symbol collector exploded" }]);
  });
});
