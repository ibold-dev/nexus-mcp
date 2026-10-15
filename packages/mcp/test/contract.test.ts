import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectGraph, type GraphClient } from "@nexus/core";
import { createNexusServer } from "../src/server.js";

const FALKORDB_URL = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const salt = `salt-mcp-${randomUUID()}`;
const MAX_RESPONSE_CHARS = 16_000;

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const absolute = path.join(root, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

interface Outcome {
  isError: boolean;
  text: string;
  body: Record<string, unknown>;
}

describe("Nexus MCP server contract", () => {
  let graph: GraphClient;
  let root: string;
  let client: Client;
  const graphName = `nexus_test_${randomUUID()}`;

  async function call(name: string, args: Record<string, unknown> = {}): Promise<Outcome> {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const isError = result.isError === true;
    return { isError, text, body: isError ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  beforeAll(async () => {
    graph = await connectGraph(FALKORDB_URL, graphName);
  });

  async function locateId(qualifiedName: string): Promise<string> {
    const located = await call("nexus_locate", { query: qualifiedName });
    const hit = (located.body.results as { symbolId: string; qualifiedName: string }[]).find(
      (candidate) => candidate.qualifiedName === qualifiedName,
    );
    if (!hit) {
      throw new Error(`no symbol ${qualifiedName}`);
    }
    return hit.symbolId;
  }

  afterAll(async () => {
    await graph.deleteGraph().catch(() => undefined);
    await graph.close();
  });

  beforeEach(async () => {
    await graph.query("MATCH (n) DETACH DELETE n");
    root = await mkdtemp(path.join(os.tmpdir(), "nexus-mcp-"));
    await write(root, "src/a.ts", `import { helper } from "./b";\nexport function run() { return helper(); }\n`);
    await write(root, "src/b.ts", `export function helper() { return 1; }\n`);

    const server = createNexusServer({ client: graph, root, projectSalt: salt });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "nexus-test", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  it("exposes exactly the five tools with validated inputs", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "nexus_context",
      "nexus_impact",
      "nexus_locate",
      "nexus_path",
      "nexus_sync",
    ]);
    const locate = tools.find((tool) => tool.name === "nexus_locate");
    expect(Object.keys(locate?.inputSchema.properties ?? {})).toEqual(["query", "kind", "limit"]);
    const path = tools.find((tool) => tool.name === "nexus_path");
    expect(Object.keys(path?.inputSchema.properties ?? {})).toEqual([
      "from",
      "to",
      "direction",
      "maxDepth",
      "maxPaths",
    ]);
    const impact = tools.find((tool) => tool.name === "nexus_impact");
    expect(Object.keys(impact?.inputSchema.properties ?? {})).toEqual(["symbolId", "maxDepth", "limit"]);
    // The wording matters: impact is a likely map, never a promise.
    expect(String(impact?.description)).toMatch(/not a guarantee/);
  });

  it("answers locate with graphVersion 0 and a hint before the repository is indexed", async () => {
    const outcome = await call("nexus_locate", { query: "helper" });
    expect(outcome.isError).toBe(false);
    expect(outcome.body).toMatchObject({ graphVersion: 0, indexedAt: null, results: [] });
    expect(String(outcome.body.hint)).toMatch(/nexus_sync/);
  });

  it("syncs, then locates symbols with path, lines, and a reason", async () => {
    const sync = await call("nexus_sync");
    expect(sync.body).toMatchObject({ graphVersion: 1, changedPaths: ["src/a.ts", "src/b.ts"] });

    const outcome = await call("nexus_locate", { query: "helper" });
    expect(outcome.body.graphVersion).toBe(1);
    const [first] = outcome.body.results as Record<string, unknown>[];
    expect(first).toMatchObject({
      qualifiedName: "helper",
      kind: "function",
      path: "src/b.ts",
      startLine: 1,
      why: "name matches",
    });
    expect(typeof first?.symbolId).toBe("string");
  });

  it("labels a camelCase or partial name match as a name match", async () => {
    await call("nexus_sync");
    const partial = await call("nexus_locate", { query: "help" });
    const [first] = partial.body.results as { qualifiedName: string; why: string }[];
    expect(first).toMatchObject({ qualifiedName: "helper", why: "name matches" });
  });

  it("caps locate results and filters by kind", async () => {
    await call("nexus_sync");
    const capped = await call("nexus_locate", { query: "run helper", limit: 1 });
    expect((capped.body.results as unknown[]).length).toBe(1);

    const wrongKind = await call("nexus_locate", { query: "helper", kind: "class" });
    expect(wrongKind.body.results).toEqual([]);
  });

  it("returns callers and callees with edge labels, and stays inside the response budget", async () => {
    await call("nexus_sync");
    const located = await call("nexus_locate", { query: "run" });
    const runId = (located.body.results as { symbolId: string; qualifiedName: string }[]).find(
      (hit) => hit.qualifiedName === "run",
    )?.symbolId;
    expect(runId).toBeDefined();

    const context = await call("nexus_context", { symbolId: runId, depth: 2 });
    expect(context.isError).toBe(false);
    expect(context.body).toMatchObject({ graphVersion: 1, depth: 2 });
    expect(context.body.callees).toEqual([
      expect.objectContaining({ qualifiedName: "helper", hops: 1, resolution: "resolved", confidence: 1 }),
    ]);
    expect(context.body.imports).toEqual([{ path: "src/b.ts", specifier: "./b" }]);
    expect(context.text.length).toBeLessThan(MAX_RESPONSE_CHARS);
  });

  it("explains how one symbol reaches another, hop by hop", async () => {
    await write(root, "src/b.ts", `import { deeper } from "./c";\nexport function helper() { return deeper(); }\n`);
    await write(root, "src/c.ts", `export function deeper() { return 1; }\n`);
    await call("nexus_sync");

    const runId = await locateId("run");
    const deeperId = await locateId("deeper");
    const outcome = await call("nexus_path", { from: runId, to: deeperId, direction: "outgoing" });

    expect(outcome.isError).toBe(false);
    expect(outcome.body).toMatchObject({
      graphVersion: 1,
      found: true,
      direction: "outgoing",
      from: { qualifiedName: "run", path: "src/a.ts" },
      to: { qualifiedName: "deeper", path: "src/c.ts" },
    });
    const [path] = outcome.body.paths as {
      hops: number;
      resolution: string;
      confidence: number;
      steps: { direction: string; from: { qualifiedName: string }; to: { qualifiedName: string }; line: number }[];
    }[];
    expect(path).toMatchObject({ hops: 2, resolution: "resolved", confidence: 1 });
    expect(path?.steps.map((step) => [step.direction, step.from.qualifiedName, step.to.qualifiedName])).toEqual([
      ["outgoing", "run", "helper"],
      ["outgoing", "helper", "deeper"],
    ]);
    expect(outcome.text.length).toBeLessThan(MAX_RESPONSE_CHARS);
  });

  it("finds a relationship in either direction and says which way each hop went", async () => {
    await write(root, "src/b.ts", `import { deeper } from "./c";\nexport function helper() { return deeper(); }\n`);
    await write(root, "src/c.ts", `export function deeper() { return 1; }\n`);
    await call("nexus_sync");
    const runId = await locateId("run");
    const deeperId = await locateId("deeper");

    const outgoing = await call("nexus_path", { from: deeperId, to: runId, direction: "outgoing" });
    expect(outgoing.body).toMatchObject({ found: false, paths: [] });
    expect(String(outgoing.body.hint)).toMatch(/maxDepth|direction/);

    const both = await call("nexus_path", { from: deeperId, to: runId, direction: "both" });
    expect(both.body.found).toBe(true);
    const [path] = both.body.paths as { steps: { direction: string }[] }[];
    expect(path?.steps.map((step) => step.direction)).toEqual(["incoming", "incoming"]);
  });

  it("rejects a path request that reuses one symbol or names an unknown one", async () => {
    await call("nexus_sync");
    const runId = await locateId("run");

    expect((await call("nexus_path", { from: runId, to: runId })).isError).toBe(true);
    expect((await call("nexus_path", { from: runId, to: "missing" })).isError).toBe(true);
    expect((await call("nexus_path", { from: runId, to: "missing", maxDepth: 0 })).isError).toBe(true);
    expect((await call("nexus_path", { from: runId, to: "missing", maxDepth: 9 })).isError).toBe(true);
  });

  it("maps the likely impact of a symbol to the callers that reach it", async () => {
    await write(root, "src/b.ts", `import { deeper } from "./c";\nexport function helper() { return deeper(); }\n`);
    await write(root, "src/c.ts", `export function deeper() { return 1; }\n`);
    await call("nexus_sync");
    const deeperId = await locateId("deeper");

    const outcome = await call("nexus_impact", { symbolId: deeperId, maxDepth: 3 });

    expect(outcome.isError).toBe(false);
    expect(outcome.body).toMatchObject({
      graphVersion: 1,
      maxDepth: 3,
      totalCallers: 2,
      truncated: false,
      symbol: { qualifiedName: "deeper", path: "src/c.ts" },
      files: ["src/a.ts", "src/b.ts"],
    });
    expect(String(outcome.body.disclaimer)).toMatch(/not a guarantee/i);
    const callers = outcome.body.callers as { qualifiedName: string; hops: number; via: string | null }[];
    expect(callers.map((caller) => [caller.qualifiedName, caller.hops, caller.via])).toEqual([
      ["helper", 1, null],
      ["run", 2, "helper"],
    ]);
    expect(outcome.text.length).toBeLessThan(MAX_RESPONSE_CHARS);
  });

  it("respects the impact depth and limit, and rejects an unknown symbol", async () => {
    await write(root, "src/b.ts", `import { deeper } from "./c";\nexport function helper() { return deeper(); }\n`);
    await write(root, "src/c.ts", `export function deeper() { return 1; }\n`);
    await call("nexus_sync");
    const deeperId = await locateId("deeper");

    const shallow = await call("nexus_impact", { symbolId: deeperId, maxDepth: 1, limit: 1 });
    expect(shallow.body).toMatchObject({ totalCallers: 1, files: ["src/b.ts"] });

    expect((await call("nexus_impact", { symbolId: "missing" })).isError).toBe(true);
    expect((await call("nexus_impact", { symbolId: deeperId, limit: 26 })).isError).toBe(true);
    expect((await call("nexus_impact", { symbolId: deeperId, maxDepth: 5 })).isError).toBe(true);
  });

  it("reports an error for an unknown symbol and for out-of-budget arguments", async () => {
    await call("nexus_sync");
    expect((await call("nexus_context", { symbolId: "missing" })).isError).toBe(true);
    expect((await call("nexus_locate", { query: "helper", limit: 9 })).isError).toBe(true);
    expect((await call("nexus_context", { symbolId: "x", depth: 3 })).isError).toBe(true);
  });

  it("shows an edit in locate and context after a sync, and bumps graphVersion", async () => {
    await call("nexus_sync");
    const before = await call("nexus_locate", { query: "run" });
    const runId = (before.body.results as { symbolId: string; qualifiedName: string }[]).find(
      (hit) => hit.qualifiedName === "run",
    )?.symbolId;

    await write(root, "src/b.ts", `export function helper2() { return 1; }\n`);
    const sync = await call("nexus_sync");
    expect(sync.body).toMatchObject({ graphVersion: 2, changedPaths: ["src/b.ts"] });

    const renamed = await call("nexus_locate", { query: "helper2" });
    expect((renamed.body.results as { qualifiedName: string }[]).map((hit) => hit.qualifiedName)).toContain("helper2");
    const gone = await call("nexus_locate", { query: "helper", kind: "function" });
    expect((gone.body.results as { qualifiedName: string }[]).map((hit) => hit.qualifiedName)).not.toContain("helper");

    const context = await call("nexus_context", { symbolId: runId, depth: 1 });
    expect(context.body.graphVersion).toBe(2);
    expect(context.body.callees).toEqual([]);
  });

  it("serializes concurrent sync calls instead of failing one of them", async () => {
    const [first, second] = await Promise.all([call("nexus_sync"), call("nexus_sync")]);
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(second.body.graphVersion).toBe(1);
  });
});
