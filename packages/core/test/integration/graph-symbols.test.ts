import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectGraph,
  GraphRepository,
  type GraphClient,
  type SymbolRecord,
} from "../../src/store/index.js";

const FALKORDB_URL = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const repoId = "repo-symbols";
const indexedAt = "2026-10-15T00:00:00.000Z";

function symbol(id: string, ordinal: number, overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id,
    kind: "function",
    name: id,
    qualifiedName: id,
    signature: `function ${id}()`,
    doc: "",
    startOffset: ordinal * 10,
    startLine: ordinal + 1,
    endLine: ordinal + 2,
    ordinal,
    ...overrides,
  };
}

const file = {
  id: "file-a",
  repoId,
  path: "src/a.ts",
  hash: "hash-1",
  language: "typescript",
  lineCount: 20,
  indexedAt,
};

describe("GraphRepository symbols and imports against FalkorDB", () => {
  let client: GraphClient;
  let repository: GraphRepository;
  const graphName = `nexus_test_${randomUUID()}`;

  beforeAll(async () => {
    client = await connectGraph(FALKORDB_URL, graphName);
    repository = new GraphRepository(client);
  });

  afterAll(async () => {
    await client.deleteGraph().catch(() => undefined);
    await client.close();
  });

  beforeEach(async () => {
    await client.query("MATCH (n) DETACH DELETE n");
    await repository.upsertRepository({
      id: repoId,
      root: "/work/app",
      schemaVersion: 1,
      indexedRevision: null,
    });
    await repository.upsertFile({ ...file, id: "file-b", path: "src/b.ts" });
  });

  async function symbolNames(): Promise<string[]> {
    const rows = await client.query<{ id: string }>(
      "MATCH (:File {id: $fileId})-[:CONTAINS]->(s:Symbol) RETURN s.id AS id ORDER BY s.startOffset",
      { fileId: file.id },
    );
    return rows.map((row) => row.id);
  }

  it("writes symbols with CONTAINS ordinals in order", async () => {
    await repository.replaceFileSymbols(repoId, file, [symbol("a1", 0), symbol("a2", 1)]);

    const rows = await client.query<{ ordinal: number; id: string }>(
      `MATCH (:File {id: $fileId})-[c:CONTAINS]->(s:Symbol)
       RETURN c.ordinal AS ordinal, s.id AS id ORDER BY c.ordinal`,
      { fileId: file.id },
    );
    expect(rows).toEqual([
      { ordinal: 0, id: "a1" },
      { ordinal: 1, id: "a2" },
    ]);
  });

  it("replaces symbols on re-write and leaves no orphan Symbol nodes", async () => {
    await repository.replaceFileSymbols(repoId, file, [symbol("a1", 0), symbol("a2", 1)]);
    await repository.replaceFileSymbols(repoId, file, [symbol("a3", 0)]);

    expect(await symbolNames()).toEqual(["a3"]);
    const total = await client.query<{ count: number }>(
      "MATCH (s:Symbol) RETURN count(s) AS count",
    );
    expect(total[0]?.count).toBe(1);
  });

  it("clears all symbols when a file has none and keeps the file node", async () => {
    await repository.replaceFileSymbols(repoId, file, [symbol("a1", 0)]);
    await repository.replaceFileSymbols(repoId, file, []);

    expect(await symbolNames()).toEqual([]);
    expect(await repository.listFilePaths(repoId)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("stores hostile symbol text as data", async () => {
    const hostile = symbol("a1", 0, {
      name: "x'); MATCH (n) DETACH DELETE n; //",
      signature: "function x() { return '\"'; }",
      doc: "line one\nline two",
    });
    await repository.replaceFileSymbols(repoId, file, [hostile]);

    const rows = await client.query<{ name: string; doc: string }>(
      "MATCH (s:Symbol {id: $id}) RETURN s.name AS name, s.doc AS doc",
      { id: "a1" },
    );
    expect(rows).toEqual([{ name: hostile.name, doc: hostile.doc }]);
    expect(await repository.listFilePaths(repoId)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("rejects symbols for a file whose repository does not exist", async () => {
    await expect(
      repository.replaceFileSymbols("missing-repo", file, [symbol("a1", 0)]),
    ).rejects.toThrow(/Repository not found/);
  });

  it("clears importsDigest on symbol write so imports are recomputed", async () => {
    await repository.replaceFileSymbols(repoId, file, []);
    await repository.replaceFileImports(file.id, "digest-1", [], []);
    expect((await repository.getFileState(repoId, file.path))?.importsDigest).toBe("digest-1");

    await repository.replaceFileSymbols(repoId, file, []);
    expect((await repository.getFileState(repoId, file.path))?.importsDigest).toBeNull();
  });

  it("replaces IMPORTS edges and stores unresolved specifiers on the file", async () => {
    await repository.replaceFileSymbols(repoId, file, []);
    await repository.replaceFileImports(file.id, "digest-1", ["lodash"], [
      {
        toFileId: "file-b",
        specifier: "./b",
        typeOnly: false,
        resolution: "resolved",
        confidence: 1,
      },
    ]);
    await repository.replaceFileImports(file.id, "digest-2", ["lodash", "./gone"], [
      {
        toFileId: "file-b",
        specifier: "./b",
        typeOnly: true,
        resolution: "resolved",
        confidence: 1,
      },
    ]);

    const edges = await client.query<{ specifier: string; typeOnly: boolean; count: number }>(
      `MATCH (:File {id: $fileId})-[i:IMPORTS]->(:File {id: 'file-b'})
       RETURN i.specifier AS specifier, i.typeOnly AS typeOnly, count(i) AS count`,
      { fileId: file.id },
    );
    expect(edges).toEqual([{ specifier: "./b", typeOnly: true, count: 1 }]);

    const state = await repository.getFileState(repoId, file.path);
    expect(state?.importsDigest).toBe("digest-2");
    const unresolved = await client.query<{ list: string[] }>(
      "MATCH (f:File {id: $fileId}) RETURN f.unresolvedImports AS list",
      { fileId: file.id },
    );
    expect(unresolved[0]?.list).toEqual(["lodash", "./gone"]);
  });

  it("returns file state for known paths and undefined otherwise", async () => {
    await repository.replaceFileSymbols(repoId, file, []);
    expect(await repository.getFileState(repoId, "src/a.ts")).toEqual({
      id: file.id,
      hash: file.hash,
      importsDigest: null,
      callsDigest: null,
    });
    expect(await repository.getFileState(repoId, "src/none.ts")).toBeUndefined();
  });

  it("replaces POSSIBLY_CALLS edges of a file and drops edges to missing targets", async () => {
    await repository.replaceFileSymbols(repoId, file, [symbol("a1", 0, { qualifiedName: "run" })]);
    await repository.replaceFileSymbols(repoId, { ...file, id: "file-b", path: "src/b.ts" }, [
      symbol("b1", 0, { qualifiedName: "helper" }),
    ]);

    await repository.replaceFileCalls(file.id, "calls-1", [
      { fromSymbolId: "a1", toSymbolId: "b1", line: 3, resolution: "resolved", confidence: 1 },
      { fromSymbolId: "a1", toSymbolId: "missing", line: 4, resolution: "resolved", confidence: 1 },
    ]);
    await repository.replaceFileCalls(file.id, "calls-2", [
      { fromSymbolId: "a1", toSymbolId: "b1", line: 7, resolution: "heuristic", confidence: 0.5 },
    ]);

    const edges = await client.query<{ line: number; resolution: string; confidence: number }>(
      `MATCH (:Symbol {id: 'a1'})-[c:POSSIBLY_CALLS]->(:Symbol {id: 'b1'})
       RETURN c.line AS line, c.resolution AS resolution, c.confidence AS confidence`,
    );
    expect(edges).toEqual([{ line: 7, resolution: "heuristic", confidence: 0.5 }]);
    expect((await repository.getFileState(repoId, file.path))?.callsDigest).toBe("calls-2");
  });

  it("clears callsDigest when symbols are rewritten so calls are recomputed", async () => {
    await repository.replaceFileSymbols(repoId, file, []);
    await repository.replaceFileCalls(file.id, "calls-1", []);
    await repository.replaceFileSymbols(repoId, file, []);
    expect((await repository.getFileState(repoId, file.path))?.callsDigest).toBeNull();
  });
});

describe("GraphRepository file state reads and removal against FalkorDB", () => {
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
    await repository.upsertRepository({ id: repoId, root: "/work/app", schemaVersion: 1, indexedRevision: null });
    await repository.replaceFileSymbols(repoId, file, [symbol("a1", 0, { qualifiedName: "run" })]);
    await repository.replaceFileSymbols(repoId, { ...file, id: "file-b", path: "src/b.ts" }, [
      symbol("b1", 0, { qualifiedName: "helper" }),
    ]);
    await repository.replaceFileCalls(file.id, "calls-1", [
      { fromSymbolId: "a1", toSymbolId: "b1", line: 2, resolution: "resolved", confidence: 1 },
    ]);
  });

  it("lists the state of every file in a repository keyed by path", async () => {
    const states = await repository.listFileStates(repoId);
    expect([...states.keys()].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(states.get("src/a.ts")).toEqual({
      id: file.id,
      hash: file.hash,
      importsDigest: null,
      callsDigest: "calls-1",
    });
  });

  it("removes a file with its symbols, its outgoing and incoming call edges, and its import edges", async () => {
    await repository.replaceFileImports("file-a", "imp-1", [], [
      { toFileId: "file-b", specifier: "./b", typeOnly: false, resolution: "resolved", confidence: 1 },
    ]);

    await repository.removeFile(repoId, "src/b.ts");

    expect(await repository.listFilePaths(repoId)).toEqual(["src/a.ts"]);
    expect(await client.query("MATCH (s:Symbol {id: 'b1'}) RETURN s")).toEqual([]);
    expect(await client.query("MATCH ()-[c:POSSIBLY_CALLS]->() RETURN c")).toEqual([]);
    expect(await client.query("MATCH ()-[i:IMPORTS]->() RETURN i")).toEqual([]);
  });

  it("removing an unknown file is a no-op", async () => {
    await repository.removeFile(repoId, "src/none.ts");
    expect(await repository.listFilePaths(repoId)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
