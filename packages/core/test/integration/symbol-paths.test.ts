import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectGraph,
  findSymbolPaths,
  GraphRepository,
  type GraphClient,
  type SymbolRecord,
} from "../../src/store/index.js";

const FALKORDB_URL = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const indexedAt = "2026-10-15T00:00:00.000Z";
const repoId = "repo-paths";

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
 * a -> b -> c, and x -> b. Every shortest path in this fixture is unique, so
 * the assertions can pin direction hop by hop.
 */
describe("symbol path queries against FalkorDB", () => {
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
    await repository.upsertRepository({ id: repoId, root: "/work/paths", schemaVersion: 1, indexedRevision: null });
    const file = (id: string, path: string) => ({
      id,
      repoId,
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
    await repository.replaceFileSymbols(repoId, file("f-z", "src/z.ts"), [symbol("z-alone", "alone")]);

    await repository.replaceFileCalls("f-a", "d1", [
      { fromSymbolId: "a-run", toSymbolId: "b-helper", line: 2, resolution: "resolved", confidence: 1 },
    ]);
    await repository.replaceFileCalls("f-b", "d2", [
      { fromSymbolId: "b-helper", toSymbolId: "c-deep", line: 5, resolution: "heuristic", confidence: 0.5 },
    ]);
    await repository.replaceFileCalls("f-x", "d3", [
      { fromSymbolId: "x-caller", toSymbolId: "b-helper", line: 7, resolution: "resolved", confidence: 1 },
    ]);
  });

  it("follows outgoing calls and labels each hop with its confidence", async () => {
    const result = await findSymbolPaths(client, repoId, "a-run", "c-deep", {
      direction: "outgoing",
      maxDepth: 6,
      maxPaths: 1,
    });

    expect(result?.from).toMatchObject({ qualifiedName: "run", path: "src/a.ts" });
    expect(result?.to).toMatchObject({ qualifiedName: "deep", path: "src/c.ts" });
    expect(result?.paths).toHaveLength(1);

    const [path] = result?.paths ?? [];
    expect(path).toMatchObject({ hops: 2, resolution: "heuristic", confidence: 0.5 });
    expect(path?.steps).toEqual([
      {
        direction: "outgoing",
        from: { symbolId: "a-run", qualifiedName: "run", kind: "function", path: "src/a.ts" },
        to: { symbolId: "b-helper", qualifiedName: "helper", kind: "function", path: "src/b.ts" },
        line: 2,
        resolution: "resolved",
        confidence: 1,
      },
      {
        direction: "outgoing",
        from: { symbolId: "b-helper", qualifiedName: "helper", kind: "function", path: "src/b.ts" },
        to: { symbolId: "c-deep", qualifiedName: "deep", kind: "function", path: "src/c.ts" },
        line: 5,
        resolution: "heuristic",
        confidence: 0.5,
      },
    ]);
  });

  it("finds nothing when the calls run the other way", async () => {
    const backwards = await findSymbolPaths(client, repoId, "c-deep", "a-run", {
      direction: "outgoing",
      maxDepth: 6,
      maxPaths: 1,
    });
    expect(backwards?.paths).toEqual([]);
  });

  it("walks against the edges when asked for incoming paths", async () => {
    const result = await findSymbolPaths(client, repoId, "c-deep", "a-run", {
      direction: "incoming",
      maxDepth: 6,
      maxPaths: 1,
    });

    const [path] = result?.paths ?? [];
    expect(path?.hops).toBe(2);
    expect(path?.steps.map((step) => [step.direction, step.from.qualifiedName, step.to.qualifiedName])).toEqual([
      ["incoming", "deep", "helper"],
      ["incoming", "helper", "run"],
    ]);
  });

  it("takes either direction and marks each hop, so a caller and a callee are related", async () => {
    const result = await findSymbolPaths(client, repoId, "c-deep", "x-caller", {
      direction: "both",
      maxDepth: 6,
      maxPaths: 1,
    });

    const [path] = result?.paths ?? [];
    expect(path?.hops).toBe(2);
    expect(path?.steps.map((step) => step.direction)).toEqual(["incoming", "incoming"]);
    expect(path?.steps.map((step) => step.to.qualifiedName)).toEqual(["helper", "caller"]);
    expect(path?.confidence).toBe(0.5);
  });

  it("returns no path for a symbol with no call edges", async () => {
    const isolated = await findSymbolPaths(client, repoId, "a-run", "z-alone", {
      direction: "both",
      maxDepth: 6,
      maxPaths: 1,
    });
    expect(isolated?.paths).toEqual([]);
  });

  it("honors maxDepth, so a short budget does not reach", async () => {
    const shallow = await findSymbolPaths(client, repoId, "a-run", "c-deep", {
      direction: "outgoing",
      maxDepth: 1,
      maxPaths: 1,
    });
    expect(shallow?.paths).toEqual([]);
  });

  it("returns every path up to maxPaths", async () => {
    // caller -> helper -> deep and caller -> helper -> ... only one shortest
    // path exists from caller to deep, so a second request is still one path.
    const result = await findSymbolPaths(client, repoId, "x-caller", "c-deep", {
      direction: "outgoing",
      maxDepth: 6,
      maxPaths: 3,
    });
    expect(result?.paths.map((path) => path.hops)).toEqual([2]);
  });

  it("returns nothing when either endpoint is unknown", async () => {
    expect(
      await findSymbolPaths(client, repoId, "a-run", "missing", { direction: "both", maxDepth: 4, maxPaths: 1 }),
    ).toBeUndefined();
    expect(
      await findSymbolPaths(client, repoId, "missing", "a-run", { direction: "both", maxDepth: 4, maxPaths: 1 }),
    ).toBeUndefined();
  });

  it("rejects a direction, depth, or path count outside the budget", async () => {
    const base = { direction: "both", maxDepth: 4, maxPaths: 1 } as const;
    await expect(findSymbolPaths(client, repoId, "a-run", "b-helper", { ...base, maxDepth: 0 })).rejects.toThrow(
      /maxDepth/,
    );
    await expect(findSymbolPaths(client, repoId, "a-run", "b-helper", { ...base, maxDepth: 9 })).rejects.toThrow(
      /maxDepth/,
    );
    await expect(findSymbolPaths(client, repoId, "a-run", "b-helper", { ...base, maxPaths: 0 })).rejects.toThrow(
      /maxPaths/,
    );
    await expect(findSymbolPaths(client, repoId, "a-run", "b-helper", { ...base, maxPaths: 4 })).rejects.toThrow(
      /maxPaths/,
    );
  });
});
