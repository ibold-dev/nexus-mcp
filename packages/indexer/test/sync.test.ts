import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectGraph,
  GraphRepository,
  normalizeRootPath,
  repositoryId,
  type GraphClient,
} from "@nexus/core";
import { RepositoryAnalyzer } from "@nexus/parser-ts";
import { RepositoryLockedError, withRepositoryLock } from "../src/lock.js";
import { syncRepository } from "../src/sync.js";

const FALKORDB_URL = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const salt = `salt-${randomUUID()}`;

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const absolute = path.join(root, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

describe("syncRepository against FalkorDB", () => {
  let client: GraphClient;
  let repository: GraphRepository;
  let root: string;
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
    root = await mkdtemp(path.join(os.tmpdir(), "nexus-fixture-"));
    await write(root, "src/a.ts", `import { b } from "./b";\nexport function a() { return b(); }\n`);
    await write(root, "src/b.ts", `export function b() { return 1; }\n`);
    await write(root, "src/lib/index.ts", `export const helper = 2;\n`);
    await write(root, "src/main.ts", `import { helper } from "./lib";\nexport const run = helper;\n`);
    await client.query("MATCH (n) DETACH DELETE n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("indexes every source file with symbols and imports on the first scan", async () => {
    const result = await syncRepository({ client, root, projectSalt: salt });

    expect(result.scanned).toBe(4);
    expect(result.filesWritten).toBe(4);
    expect(result.unchanged).toBe(0);
    expect(result.failures).toEqual([]);
    expect(await repository.listFilePaths(result.repoId)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/lib/index.ts",
      "src/main.ts",
    ]);

    const symbols = await client.query<{ count: number }>(
      "MATCH (:File)-[:CONTAINS]->(s:Symbol) RETURN count(s) AS count",
    );
    expect(symbols[0]?.count).toBe(4);

    const edges = await client.query<{ count: number }>(
      "MATCH (:File)-[i:IMPORTS]->(:File) RETURN count(i) AS count",
    );
    expect(edges[0]?.count).toBe(2);
  });

  it("is a no-op on an unchanged repository (idempotent re-index)", async () => {
    await syncRepository({ client, root, projectSalt: salt });

    const second = await syncRepository({ client, root, projectSalt: salt });

    expect(second.filesWritten).toBe(0);
    expect(second.importsWritten).toBe(0);
    expect(second.callsWritten).toBe(0);
    expect(second.changedPaths).toEqual([]);
    expect(second.unchanged).toBe(4);
  });

  const callsFromA = `
    MATCH (:File {path: 'src/a.ts'})-[:CONTAINS]->(:Symbol {qualifiedName: 'a'})-[c:POSSIBLY_CALLS]->(t:Symbol)
    RETURN t.qualifiedName AS target, c.resolution AS resolution, c.line AS line`;

  it("writes resolved call edges across files", async () => {
    await syncRepository({ client, root, projectSalt: salt });

    const calls = await client.query<{ target: string; resolution: string; line: number }>(callsFromA);
    expect(calls).toEqual([{ target: "b", resolution: "resolved", line: 2 }]);
  });

  it("keeps the call edge after a line is added above the callee, because its id is stable", async () => {
    await syncRepository({ client, root, projectSalt: salt });
    await write(root, "src/b.ts", `// a comment\n\nexport function b() { return 1; }\n`);

    const result = await syncRepository({ client, root, projectSalt: salt });

    expect(result.changedPaths).toEqual(["src/b.ts"]);
    expect(result.callsWritten).toBe(2);
    const calls = await client.query<{ target: string }>(callsFromA);
    expect(calls.map((row) => row.target)).toEqual(["b"]);
  });

  it("removes the call edge when the callee is renamed and the caller is unchanged", async () => {
    await syncRepository({ client, root, projectSalt: salt });
    await write(root, "src/b.ts", `export function renamed() { return 1; }\n`);

    const result = await syncRepository({ client, root, projectSalt: salt });

    expect(result.changedPaths).toEqual(["src/b.ts"]);
    expect(result.callsWritten).toBe(2);
    expect(await client.query(callsFromA)).toEqual([]);
  });

  it("re-parses only the changed file and replaces its symbols", async () => {
    await syncRepository({ client, root, projectSalt: salt });
    await write(root, "src/b.ts", `export function b() { return 1; }\nexport function c() { return 2; }\n`);

    const result = await syncRepository({ client, root, projectSalt: salt });

    expect(result.filesWritten).toBe(1);
    const names = await client.query<{ name: string }>(
      `MATCH (:File {path: 'src/b.ts'})-[:CONTAINS]->(s:Symbol) RETURN s.name AS name ORDER BY s.startOffset`,
    );
    expect(names.map((row) => row.name)).toEqual(["b", "c"]);
  });

  it("updates the importer when a previously unresolved import starts resolving", async () => {
    await write(root, "src/c.ts", `import { d } from "./d";\nexport const c = d;\n`);
    await syncRepository({ client, root, projectSalt: salt });

    const before = await client.query<{ count: number }>(
      "MATCH (:File {path: 'src/c.ts'})-[i:IMPORTS]->(:File) RETURN count(i) AS count",
    );
    expect(before[0]?.count).toBe(0);

    await write(root, "src/d.ts", `export const d = 3;\n`);
    const result = await syncRepository({ client, root, projectSalt: salt });

    expect(result.filesWritten).toBe(1);
    expect(result.importsWritten).toBe(2);
    const after = await client.query<{ specifier: string }>(
      "MATCH (:File {path: 'src/c.ts'})-[i:IMPORTS]->(:File {path: 'src/d.ts'}) RETURN i.specifier AS specifier",
    );
    expect(after).toEqual([{ specifier: "./d" }]);
  });

  it("honors ignore rules and never indexes secrets or dependencies", async () => {
    await write(root, ".gitignore", "generated/\n");
    await write(root, "generated/gen.ts", `export const gen = 1;\n`);
    await write(root, "node_modules/pkg/index.ts", `export const pkg = 1;\n`);
    await write(root, ".env", `API_KEY=FAKE_SECRET_VALUE\n`);
    await write(root, "src/server.key.ts", `export const ok = 1;\n`);
    await write(root, "certs/private.pem", `FAKE PEM\n`);

    const result = await syncRepository({ client, root, projectSalt: salt });

    expect(await repository.listFilePaths(result.repoId)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/lib/index.ts",
      "src/main.ts",
      "src/server.key.ts",
    ]);

    const leaked = await client.query<{ count: number }>(
      "MATCH (n) WHERE n.signature CONTAINS 'FAKE_SECRET' OR n.name CONTAINS 'FAKE_SECRET' RETURN count(n) AS count",
    );
    expect(leaked[0]?.count).toBe(0);
  });
});

describe("syncRepository incremental behavior", () => {
  let client: GraphClient;
  let root: string;
  const salt = `salt-incremental-${randomUUID()}`;
  const openGraphs: GraphClient[] = [];

  async function openGraph(): Promise<GraphClient> {
    const graph = await connectGraph(FALKORDB_URL, `nexus_test_${randomUUID()}`);
    openGraphs.push(graph);
    return graph;
  }

  async function snapshot(graph: GraphClient): Promise<string[]> {
    const calls = await graph.query<Record<string, unknown>>(
      `MATCH (f:File)-[:CONTAINS]->(a:Symbol)-[c:POSSIBLY_CALLS]->(b:Symbol)<-[:CONTAINS]-(g:File)
       RETURN 'call' AS kind, f.path AS from, a.qualifiedName AS fromName, g.path AS to, b.qualifiedName AS toName,
              c.line AS line, c.resolution AS resolution`,
    );
    const imports = await graph.query<Record<string, unknown>>(
      `MATCH (f:File)-[i:IMPORTS]->(g:File)
       RETURN 'import' AS kind, f.path AS from, i.specifier AS fromName, g.path AS to, i.typeOnly AS toName,
              0 AS line, i.resolution AS resolution`,
    );
    const files = await graph.query<Record<string, unknown>>(
      "MATCH (f:File) RETURN 'file' AS kind, f.path AS from, '' AS fromName, '' AS to, '' AS toName, 0 AS line, '' AS resolution",
    );
    return [...calls, ...imports, ...files].map((row) => JSON.stringify(row)).sort();
  }

  beforeAll(async () => {
    client = await connectGraph(FALKORDB_URL, `nexus_test_${randomUUID()}`);
    openGraphs.push(client);
  });

  afterAll(async () => {
    for (const graph of openGraphs) {
      await graph.deleteGraph().catch(() => undefined);
      await graph.close();
    }
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "nexus-incremental-"));
    await write(root, "src/a.ts", `import { b } from "./b";\nexport function run() { return b(); }\n`);
    await write(root, "src/b.ts", `export function b() { return helper(); }\nfunction helper() { return 1; }\n`);
    await write(root, "src/main.ts", `import { run } from "./a";\nexport const main = run;\n`);
    await client.query("MATCH (n) DETACH DELETE n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("removes a deleted file's nodes, edges, and dependents' edges to it", async () => {
    await syncRepository({ client, root, projectSalt: salt });
    await rm(path.join(root, "src/b.ts"));

    const result = await syncRepository({ client, root, projectSalt: salt });

    expect(result.removedPaths).toEqual(["src/b.ts"]);
    expect(await client.query("MATCH (f:File {path: 'src/b.ts'}) RETURN f")).toEqual([]);
    expect(await client.query("MATCH (s:Symbol {qualifiedName: 'helper'}) RETURN s")).toEqual([]);
    expect(
      await client.query(
        "MATCH (:File {path: 'src/a.ts'})-[:CONTAINS]->(:Symbol)-[:POSSIBLY_CALLS]->() RETURN 1",
      ),
    ).toEqual([]);
    const unresolved = await client.query<{ list: string[] }>(
      "MATCH (f:File {path: 'src/a.ts'}) RETURN f.unresolvedImports AS list",
    );
    expect(unresolved[0]?.list).toEqual(["./b"]);
  });

  it("does no analysis at all when nothing changed on disk", async () => {
    const analyzer = new RepositoryAnalyzer(repositoryId(normalizeRootPath(root), salt));
    await syncRepository({ client, root, projectSalt: salt, analyzer });
    const spy = vi.spyOn(analyzer, "update");

    const result = await syncRepository({ client, root, projectSalt: salt, analyzer });

    expect(spy).not.toHaveBeenCalled();
    expect(result.unchanged).toBe(3);
    expect(result.recomputedCalls).toBe(0);
  });

  it("produces the same graph incrementally as a cold sync of the final state", async () => {
    const repoId = repositoryId(normalizeRootPath(root), salt);
    const analyzer = new RepositoryAnalyzer(repoId);

    await syncRepository({ client, root, projectSalt: salt, analyzer });

    await write(root, "src/b.ts", `// moved\n\nexport function b() { return helper2(); }\nfunction helper2() { return 1; }\n`);
    await syncRepository({ client, root, projectSalt: salt, analyzer });

    await write(root, "src/d.ts", `export function d() { return 2; }\n`);
    await write(root, "src/a.ts", `import { b } from "./b";\nimport { d } from "./d";\nexport function run() { return b() + d(); }\n`);
    await syncRepository({ client, root, projectSalt: salt, analyzer });

    await rm(path.join(root, "src/main.ts"));
    await write(root, "src/c.ts", `export function c(o: any) { return o.run(); }\n`);
    await syncRepository({ client, root, projectSalt: salt, analyzer });

    const cold = await openGraph();
    await syncRepository({ client: cold, root, projectSalt: salt });

    expect(await snapshot(client)).toEqual(await snapshot(cold));
  });

  it("bumps graphVersion on writes and keeps it on no-op syncs", async () => {
    const first = await syncRepository({ client, root, projectSalt: salt });
    expect(first.graphVersion).toBe(1);
    expect(first.indexedAt).not.toBeNull();

    const noop = await syncRepository({ client, root, projectSalt: salt });
    expect(noop.graphVersion).toBe(1);
    expect(noop.indexedAt).toBe(first.indexedAt);

    await write(root, "src/b.ts", `export function b() { return 2; }\n`);
    const edited = await syncRepository({ client, root, projectSalt: salt });
    expect(edited.graphVersion).toBe(2);
  });

  it("refuses to run while another sync holds the lock", async () => {
    await withRepositoryLock(root, async () => {
      await expect(syncRepository({ client, root, projectSalt: salt })).rejects.toBeInstanceOf(
        RepositoryLockedError,
      );
    });
    await expect(syncRepository({ client, root, projectSalt: salt })).resolves.toBeDefined();
  });

  it("replaces a stale lock left by a dead process", async () => {
    await mkdir(path.join(root, ".nexus"), { recursive: true });
    await writeFile(path.join(root, ".nexus", "sync.lock"), "999999", "utf8");

    await expect(syncRepository({ client, root, projectSalt: salt })).resolves.toBeDefined();
    await expect(readFile(path.join(root, ".nexus", "sync.lock"), "utf8")).rejects.toThrow();
  });
});
