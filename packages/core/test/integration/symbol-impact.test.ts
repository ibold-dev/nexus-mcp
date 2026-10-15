import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectGraph,
  findImpact,
  GraphRepository,
  type GraphClient,
  type SymbolRecord,
} from "../../src/store/index.js";

const FALKORDB_URL = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const indexedAt = "2026-10-15T00:00:00.000Z";
const repoId = "repo-impact";

function symbol(id: string, name: string): SymbolRecord {
  return {
    id,
    kind: "function",
    name,
    qualifiedName: name,
    signature: `function ${name}()`,
    doc: "",
    startOffset: 0,
    startLine: 1,
    endLine: 3,
    ordinal: 0,
  };
}

/**
 * entry -> run -> helper -> deep, plus other -> helper. Impact walks these
 * edges backwards, nearest caller first.
 */
describe("symbol impact queries against FalkorDB", () => {
  let client: GraphClient;
  let repository: GraphRepository;
  const graphName = `nexus_test_${randomUUID()}`;

  beforeAll(async () => {
    client = await connectGraph(FALKORDB_URL, graphName);
    repository = new GraphRepository(client);
    await repository.ensureIndexes();
  });

  afterAll(async () => {
    await client.deleteGraph().catch(() => undefined);
    await client.close();
  });

  beforeEach(async () => {
    await client.query("MATCH (n) DETACH DELETE n");
    await repository.upsertRepository({ id: repoId, root: "/work/impact", schemaVersion: 1, indexedRevision: null });
    const file = (id: string, path: string) => ({
      id,
      repoId,
      path,
      hash: id,
      language: "typescript",
      lineCount: 10,
      indexedAt,
    });

    await repository.replaceFileSymbols(repoId, file("f-entry", "src/entry.ts"), [symbol("e-entry", "entry")]);
    await repository.replaceFileSymbols(repoId, file("f-a", "src/a.ts"), [symbol("a-run", "run")]);
    await repository.replaceFileSymbols(repoId, file("f-b", "src/b.ts"), [symbol("b-helper", "helper")]);
    await repository.replaceFileSymbols(repoId, file("f-c", "src/c.ts"), [symbol("c-deep", "deep")]);
    await repository.replaceFileSymbols(repoId, file("f-o", "src/other.ts"), [symbol("o-other", "other")]);
    await repository.replaceFileSymbols(repoId, file("f-z", "src/z.ts"), [symbol("z-alone", "alone")]);

    await repository.replaceFileCalls("f-entry", "d1", [
      { fromSymbolId: "e-entry", toSymbolId: "a-run", line: 2, resolution: "resolved", confidence: 1 },
    ]);
    await repository.replaceFileCalls("f-a", "d2", [
      { fromSymbolId: "a-run", toSymbolId: "b-helper", line: 3, resolution: "resolved", confidence: 1 },
    ]);
    await repository.replaceFileCalls("f-b", "d3", [
      { fromSymbolId: "b-helper", toSymbolId: "c-deep", line: 4, resolution: "heuristic", confidence: 0.5 },
    ]);
    await repository.replaceFileCalls("f-o", "d4", [
      { fromSymbolId: "o-other", toSymbolId: "b-helper", line: 6, resolution: "resolved", confidence: 1 },
    ]);
  });

  it("lists callers nearest first with hops, confidence, and the hop they came from", async () => {
    const impact = await findImpact(client, repoId, "c-deep", { maxDepth: 4, limit: 25 });

    expect(impact?.symbol).toMatchObject({ qualifiedName: "deep", path: "src/c.ts" });
    expect(impact?.callers.map((caller) => [caller.qualifiedName, caller.hops, caller.confidence, caller.via])).toEqual([
      ["helper", 1, 0.5, null],
      ["other", 2, 0.5, "helper"],
      ["run", 2, 0.5, "helper"],
      ["entry", 3, 0.5, "run"],
    ]);
    expect(impact?.files).toEqual(["src/a.ts", "src/b.ts", "src/entry.ts", "src/other.ts"]);
    expect(impact?.totalCallers).toBe(4);
    expect(impact?.truncated).toBe(false);
  });

  it("labels a path heuristic when any hop is heuristic, and resolved when every hop is", async () => {
    const throughHeuristic = await findImpact(client, repoId, "c-deep", { maxDepth: 4, limit: 25 });
    expect(throughHeuristic?.callers.every((caller) => caller.resolution === "heuristic")).toBe(true);

    const allResolved = await findImpact(client, repoId, "b-helper", { maxDepth: 4, limit: 25 });
    expect(allResolved?.callers.map((caller) => [caller.qualifiedName, caller.resolution])).toEqual([
      ["other", "resolved"],
      ["run", "resolved"],
      ["entry", "resolved"],
    ]);
    expect(allResolved?.callers.map((caller) => caller.confidence)).toEqual([1, 1, 1]);
  });

  it("stops at maxDepth", async () => {
    const shallow = await findImpact(client, repoId, "c-deep", { maxDepth: 1, limit: 25 });
    expect(shallow?.callers.map((caller) => caller.qualifiedName)).toEqual(["helper"]);
    expect(shallow?.totalCallers).toBe(1);
  });

  it("returns an empty list for a symbol nothing calls", async () => {
    const impact = await findImpact(client, repoId, "z-alone", { maxDepth: 4, limit: 25 });
    expect(impact?.callers).toEqual([]);
    expect(impact?.files).toEqual([]);
    expect(impact?.totalCallers).toBe(0);
  });

  it("keeps the nearest caller for each symbol and reports the full count", async () => {
    const impact = await findImpact(client, repoId, "b-helper", { maxDepth: 4, limit: 1 });

    expect(impact?.callers).toHaveLength(1);
    expect(impact?.callers[0]).toMatchObject({ qualifiedName: "other", hops: 1 });
    expect(impact?.totalCallers).toBe(3);
    expect(impact?.files).toEqual(["src/other.ts"]);
  });

  it("groups the affected files of the returned callers", async () => {
    const impact = await findImpact(client, repoId, "b-helper", { maxDepth: 2, limit: 25 });
    expect(impact?.files).toEqual(["src/a.ts", "src/entry.ts", "src/other.ts"]);
  });

  it("returns nothing for an unknown symbol", async () => {
    expect(await findImpact(client, repoId, "missing", { maxDepth: 4, limit: 25 })).toBeUndefined();
  });

  it("rejects a depth or limit outside the budget", async () => {
    await expect(findImpact(client, repoId, "c-deep", { maxDepth: 0, limit: 25 })).rejects.toThrow(/maxDepth/);
    await expect(findImpact(client, repoId, "c-deep", { maxDepth: 5, limit: 25 })).rejects.toThrow(/maxDepth/);
    await expect(findImpact(client, repoId, "c-deep", { maxDepth: 1, limit: 0 })).rejects.toThrow(/limit/);
    await expect(findImpact(client, repoId, "c-deep", { maxDepth: 1, limit: 26 })).rejects.toThrow(/limit/);
  });
});
