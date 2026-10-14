import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectGraph, GraphRepository, type GraphClient } from "@nexus/core";
import { fullScan } from "../src/full-scan.js";

const FALKORDB_URL = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const salt = `salt-${randomUUID()}`;

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const absolute = path.join(root, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

describe("fullScan against FalkorDB", () => {
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
    const result = await fullScan({ client, root, projectSalt: salt });

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
    await fullScan({ client, root, projectSalt: salt });

    const second = await fullScan({ client, root, projectSalt: salt });

    expect(second.filesWritten).toBe(0);
    expect(second.importsWritten).toBe(0);
    expect(second.unchanged).toBe(4);
  });

  it("re-parses only the changed file and replaces its symbols", async () => {
    await fullScan({ client, root, projectSalt: salt });
    await write(root, "src/b.ts", `export function b() { return 1; }\nexport function c() { return 2; }\n`);

    const result = await fullScan({ client, root, projectSalt: salt });

    expect(result.filesWritten).toBe(1);
    const names = await client.query<{ name: string }>(
      `MATCH (:File {path: 'src/b.ts'})-[:CONTAINS]->(s:Symbol) RETURN s.name AS name ORDER BY s.startOffset`,
    );
    expect(names.map((row) => row.name)).toEqual(["b", "c"]);
  });

  it("updates the importer when a previously unresolved import starts resolving", async () => {
    await write(root, "src/c.ts", `import { d } from "./d";\nexport const c = d;\n`);
    await fullScan({ client, root, projectSalt: salt });

    const before = await client.query<{ count: number }>(
      "MATCH (:File {path: 'src/c.ts'})-[i:IMPORTS]->(:File) RETURN count(i) AS count",
    );
    expect(before[0]?.count).toBe(0);

    await write(root, "src/d.ts", `export const d = 3;\n`);
    const result = await fullScan({ client, root, projectSalt: salt });

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

    const result = await fullScan({ client, root, projectSalt: salt });

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
