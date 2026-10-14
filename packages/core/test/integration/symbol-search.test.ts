import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectGraph,
  GraphRepository,
  type GraphClient,
  type SymbolRecord,
} from "../../src/store/index.js";

const FALKORDB_URL = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const indexedAt = "2026-10-15T00:00:00.000Z";

function symbol(id: string, ordinal: number, overrides: Partial<SymbolRecord>): SymbolRecord {
  return {
    id,
    kind: "function",
    name: id,
    qualifiedName: id,
    signature: `function ${id}()`,
    doc: "",
    startOffset: ordinal * 100,
    startLine: ordinal * 10 + 1,
    endLine: ordinal * 10 + 5,
    ordinal,
    ...overrides,
  };
}

describe("GraphRepository.searchSymbols against FalkorDB", () => {
  let client: GraphClient;
  let repository: GraphRepository;
  const graphName = `nexus_test_${randomUUID()}`;
  const repoA = "repo-search-a";
  const repoB = "repo-search-b";

  beforeAll(async () => {
    client = await connectGraph(FALKORDB_URL, graphName);
    repository = new GraphRepository(client);
    await repository.ensureIndexes();
    await repository.ensureIndexes();
  });

  afterAll(async () => {
    await client.deleteGraph().catch(() => undefined);
    await client.close();
  });

  beforeEach(async () => {
    await client.query("MATCH (n) DETACH DELETE n");
    for (const id of [repoA, repoB]) {
      await repository.upsertRepository({ id, root: `/work/${id}`, schemaVersion: 1, indexedRevision: null });
    }

    await repository.replaceFileSymbols(
      repoA,
      { id: "a-config", repoId: repoA, path: "src/config.ts", hash: "h1", language: "typescript", lineCount: 30, indexedAt },
      [
        symbol("parseConfig", 0, {
          kind: "function",
          doc: "Loads the settings file from disk",
          signature: "function parseConfig(path: string)",
        }),
      ],
    );
    await repository.replaceFileSymbols(
      repoA,
      { id: "a-ui", repoId: repoA, path: "src/ui.ts", hash: "h2", language: "typescript", lineCount: 30, indexedAt },
      [
        symbol("renderButton", 0, {
          kind: "function",
          signature: "function renderButton(label: string)",
        }),
        symbol("renderPanel", 1, {
          kind: "function",
          signature: "function renderPanel()",
        }),
      ],
    );
    await repository.replaceFileSymbols(
      repoB,
      { id: "b-config", repoId: repoB, path: "lib/config.ts", hash: "h3", language: "typescript", lineCount: 10, indexedAt },
      [symbol("parseConfig", 0, { kind: "function", doc: "Other repository copy" })],
    );
  });

  it("finds symbols by name prefix and returns locations and scores", async () => {
    const hits = await repository.searchSymbols(repoA, "parse", 8);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      qualifiedName: "parseConfig",
      kind: "function",
      path: "src/config.ts",
      startLine: 1,
      endLine: 5,
    });
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("matches words in doc comments and signatures", async () => {
    const byDoc = await repository.searchSymbols(repoA, "settings", 8);
    const bySignature = await repository.searchSymbols(repoA, "label", 8);

    expect(byDoc.map((hit) => hit.qualifiedName)).toEqual(["parseConfig"]);
    expect(bySignature.map((hit) => hit.qualifiedName)).toEqual(["renderButton"]);
  });

  it("never returns symbols from another repository", async () => {
    const hits = await repository.searchSymbols(repoA, "config", 8);
    expect(hits.map((hit) => hit.path)).toEqual(["src/config.ts"]);

    const other = await repository.searchSymbols(repoB, "config", 8);
    expect(other.map((hit) => hit.path)).toEqual(["lib/config.ts"]);
  });

  it("respects the result limit", async () => {
    const hits = await repository.searchSymbols(repoA, "render", 1);
    expect(hits).toHaveLength(1);
  });

  it("returns nothing for empty, unmatched, or syntax-only queries without erroring", async () => {
    expect(await repository.searchSymbols(repoA, "", 8)).toEqual([]);
    expect(await repository.searchSymbols(repoA, "(){}", 8)).toEqual([]);
    expect(await repository.searchSymbols(repoA, "nothingHere", 8)).toEqual([]);
  });

  it("treats query syntax as plain words", async () => {
    const hits = await repository.searchSymbols(repoA, `parse") OR (@doc:*`, 8);
    expect(hits.map((hit) => hit.qualifiedName)).toEqual(["parseConfig"]);
  });

  it("drops stale symbols once a file is rewritten", async () => {
    expect(await repository.searchSymbols(repoA, "parseConfig", 8)).toHaveLength(1);

    await repository.replaceFileSymbols(
      repoA,
      { id: "a-config", repoId: repoA, path: "src/config.ts", hash: "h4", language: "typescript", lineCount: 30, indexedAt },
      [symbol("loadSettings", 0, { kind: "function" })],
    );

    expect(await repository.searchSymbols(repoA, "parseConfig", 8)).toEqual([]);
    expect(
      (await repository.searchSymbols(repoA, "loadSettings", 8)).map((hit) => hit.qualifiedName),
    ).toEqual(["loadSettings"]);
  });
});
