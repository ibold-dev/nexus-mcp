import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectGraph, GraphRepository, type GraphClient } from "../../src/store/index.js";

const FALKORDB_URL = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const repoId = "repo-test";
const indexedAt = "2026-10-15T00:00:00.000Z";

describe("GraphRepository against FalkorDB", () => {
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
  });

  const file = (path: string, hash: string) => ({
    id: `file-${path}`,
    repoId,
    path,
    hash,
    language: "typescript",
    lineCount: 10,
    indexedAt,
  });

  it("creates indexes idempotently", async () => {
    await expect(repository.ensureIndexes()).resolves.toBeUndefined();
    await expect(repository.ensureIndexes()).resolves.toBeUndefined();
  });

  it("upserts a repository once, even when called twice", async () => {
    await repository.upsertRepository({
      id: repoId,
      root: "/work/app",
      schemaVersion: 2,
      indexedRevision: "abc123",
    });
    const rows = await client.query<{ count: number }>(
      "MATCH (r:Repository {id: $id}) RETURN count(r) AS count",
      { id: repoId },
    );
    expect(rows[0]?.count).toBe(1);
  });

  it("upserts a file, links it with HAS_FILE, and updates it in place", async () => {
    await repository.upsertFile(file("src/a.ts", "hash-1"));
    await repository.upsertFile(file("src/a.ts", "hash-2"));

    const rows = await client.query<{ count: number; hash: string }>(
      `MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(f:File)
       RETURN count(f) AS count, max(f.hash) AS hash`,
      { repoId },
    );
    expect(rows[0]).toEqual({ count: 1, hash: "hash-2" });
  });

  it("returns the stored hash for a path and undefined for an unknown path", async () => {
    await repository.upsertFile(file("src/a.ts", "hash-1"));
    expect(await repository.getFileHash(repoId, "src/a.ts")).toBe("hash-1");
    expect(await repository.getFileHash(repoId, "src/missing.ts")).toBeUndefined();
  });

  it("lists file paths in sorted order", async () => {
    await repository.upsertFile(file("src/b.ts", "h"));
    await repository.upsertFile(file("src/a.ts", "h"));
    expect(await repository.listFilePaths(repoId)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("stores hostile input as data, not as Cypher", async () => {
    const hostilePath = "src/o'brien\" RETURN 1 //.ts";
    await repository.upsertFile(file(hostilePath, "h"));
    expect(await repository.listFilePaths(repoId)).toEqual([hostilePath]);
    expect(await repository.getFileHash(repoId, hostilePath)).toBe("h");
  });

  it("rejects a file whose repository does not exist", async () => {
    await expect(
      repository.upsertFile({ ...file("src/a.ts", "h"), repoId: "missing-repo" }),
    ).rejects.toThrow(/Repository not found/);
  });
});
