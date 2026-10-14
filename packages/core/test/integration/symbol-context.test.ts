import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectGraph,
  getSymbolContext,
  getSymbolRef,
  GraphRepository,
  type GraphClient,
  type SymbolRecord,
} from "../../src/store/index.js";

const FALKORDB_URL = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const indexedAt = "2026-10-15T00:00:00.000Z";
const repoId = "repo-context";
const otherRepo = "repo-context-other";

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

describe("symbol context queries against FalkorDB", () => {
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
    for (const id of [repoId, otherRepo]) {
      await repository.upsertRepository({ id, root: `/work/${id}`, schemaVersion: 1, indexedRevision: null });
    }
    const file = (id: string, path: string, repo = repoId) => ({
      id,
      repoId: repo,
      path,
      hash: id,
      language: "typescript",
      lineCount: 10,
      indexedAt,
    });

    await repository.replaceFileSymbols(repoId, file("f-a", "src/a.ts"), [symbol("a-run", "run")]);
    await repository.replaceFileSymbols(repoId, file("f-b", "src/b.ts"), [symbol("b-helper", "helper")]);
    await repository.replaceFileSymbols(repoId, file("f-c", "src/c.ts"), [symbol("c-deep", "deep")]);
    await repository.replaceFileSymbols(repoId, file("f-x", "src/x.ts"), [symbol("x-caller", "caller")]);
    await repository.replaceFileSymbols(repoId, file("f-o", "other/o.ts", otherRepo), [symbol("o-run", "run")]);

    await repository.replaceFileCalls("f-a", "d1", [
      { fromSymbolId: "a-run", toSymbolId: "b-helper", line: 2, resolution: "resolved", confidence: 1 },
    ]);
    await repository.replaceFileCalls("f-b", "d2", [
      { fromSymbolId: "b-helper", toSymbolId: "c-deep", line: 5, resolution: "heuristic", confidence: 0.5 },
    ]);
    await repository.replaceFileCalls("f-x", "d3", [
      { fromSymbolId: "x-caller", toSymbolId: "a-run", line: 7, resolution: "resolved", confidence: 1 },
    ]);
    await repository.replaceFileImports("f-a", "i1", [], [
      { toFileId: "f-b", specifier: "./b", typeOnly: false, resolution: "resolved", confidence: 1 },
    ]);
  });

  it("looks up a symbol only inside its own repository", async () => {
    expect(await getSymbolRef(client, repoId, "a-run")).toMatchObject({ name: "run", path: "src/a.ts" });
    expect(await getSymbolRef(client, otherRepo, "a-run")).toBeUndefined();
    expect(await getSymbolRef(client, repoId, "missing")).toBeUndefined();
  });

  it("returns direct callees and callers at depth 1", async () => {
    const context = await getSymbolContext(client, repoId, "a-run", { depth: 1, limit: 8 });

    expect(context?.callees).toEqual([
      expect.objectContaining({ symbolId: "b-helper", hops: 1, via: null, line: 2, resolution: "resolved", confidence: 1 }),
    ]);
    expect(context?.callers.map((c) => c.symbolId)).toEqual(["x-caller"]);
    expect(context?.imports).toEqual([{ path: "src/b.ts", specifier: "./b" }]);
  });

  it("adds two-hop neighbors through an intermediate symbol at depth 2 with a combined confidence", async () => {
    const context = await getSymbolContext(client, repoId, "a-run", { depth: 2, limit: 8 });

    expect(context?.callees).toEqual([
      expect.objectContaining({ symbolId: "b-helper", hops: 1, resolution: "resolved", confidence: 1 }),
      expect.objectContaining({
        symbolId: "c-deep",
        hops: 2,
        via: "helper",
        resolution: "heuristic",
        confidence: 0.5,
      }),
    ]);
  });

  it("reports two-hop callers with their path", async () => {
    const context = await getSymbolContext(client, repoId, "c-deep", { depth: 2, limit: 8 });
    expect(context?.callers).toEqual([
      expect.objectContaining({ symbolId: "b-helper", hops: 1, resolution: "heuristic", confidence: 0.5 }),
      expect.objectContaining({ symbolId: "a-run", hops: 2, via: "helper", resolution: "heuristic", confidence: 0.5 }),
    ]);
  });

  it("returns nothing for an unknown symbol", async () => {
    expect(await getSymbolContext(client, repoId, "missing", { depth: 1, limit: 8 })).toBeUndefined();
  });

  it("respects the result limit", async () => {
    const context = await getSymbolContext(client, repoId, "a-run", { depth: 2, limit: 1 });
    expect(context?.callees).toHaveLength(1);
  });

  it("rejects depths and limits outside the budget", async () => {
    await expect(getSymbolContext(client, repoId, "a-run", { depth: 3, limit: 8 })).rejects.toThrow(/depth/);
    await expect(getSymbolContext(client, repoId, "a-run", { depth: 1, limit: 0 })).rejects.toThrow(/limit/);
    await expect(getSymbolContext(client, repoId, "a-run", { depth: 1, limit: 51 })).rejects.toThrow(/limit/);
  });
});
