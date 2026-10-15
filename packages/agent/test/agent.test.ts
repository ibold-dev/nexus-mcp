import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectGraph, normalizeRootPath, repositoryId, type GraphClient } from "@nexus/core";
import { createNexusServer } from "@nexus/mcp";
import { connectNexusTools, createModel, runAgent, type NexusConnection } from "../src/index.js";

const FALKORDB_URL = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const salt = `salt-agent-${randomUUID()}`;
const userId = "agent-test";

/**
 * The reference agent, end to end, through the real MCP server: a model asks
 * for tools, the server answers from FalkorDB, and what the run learned is left
 * in the graph for the next one.
 *
 * The model is the scripted stub, so the tool loop under test is the real one
 * while the reasoning is fixed.
 */
describe("change-impact agent over the MCP server", () => {
  let graph: GraphClient;
  let root: string;
  let connection: NexusConnection;
  const graphName = `nexus_test_${randomUUID()}`;

  beforeAll(async () => {
    graph = await connectGraph(FALKORDB_URL, graphName);
  });

  afterAll(async () => {
    await graph.deleteGraph().catch(() => undefined);
    await graph.close();
  });

  beforeEach(async () => {
    await graph.query("MATCH (n) DETACH DELETE n");
    root = await mkdtemp(path.join(os.tmpdir(), "nexus-agent-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src", "entry.ts"),
      'import { helper } from "./helper.js";\nexport function run() {\n  return helper();\n}\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "helper.ts"),
      'import { deep } from "./deep.js";\nexport function helper() {\n  return deep() + 1;\n}\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "deep.ts"),
      "export function deep() {\n  return 2;\n}\n",
      "utf8",
    );

    const server = createNexusServer({
      client: graph,
      root,
      projectSalt: salt,
      userId,
      agentId: "agent-a",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    connection = await connectNexusTools({ root, transport: clientTransport });
  });

  afterEach(async () => {
    await connection.close();
    await rm(root, { recursive: true, force: true });
  });

  it("exposes the tools the server advertises, with their schemas", () => {
    expect(connection.toolNames.sort()).toEqual([
      "nexus_context",
      "nexus_handoff",
      "nexus_impact",
      "nexus_locate",
      "nexus_path",
      "nexus_recall",
      "nexus_remember",
      "nexus_sync",
    ]);
    expect(Object.keys(connection.tools)).toHaveLength(8);
    // The server's caution about impact travels through the bridge unchanged.
    expect(connection.tools.nexus_impact?.description).toMatch(/not a guarantee/);
  });

  it("walks a change through the graph and reports it with citations", async () => {
    const { model } = createModel({ NEXUS_PROVIDER: "stub", NEXUS_STUB_SYMBOL: "helper" });
    const run = await runAgent("What does changing helper affect?", { model, tools: connection.tools, maxSteps: 8 });

    // The scripted model is forced through the same tools a real model would call.
    expect(run.toolCalls.map((call) => call.toolName)).toEqual([
      "nexus_sync",
      "nexus_locate",
      "nexus_impact",
      "nexus_recall",
      "nexus_remember",
    ]);
    expect(run.toolCalls.filter((call) => !call.ok)).toEqual([]);
    expect(run.finishReason).toBe("stop");

    const impact = run.toolCalls.find((call) => call.toolName === "nexus_impact");
    const body = JSON.parse(String(impact?.output)) as {
      symbol: { qualifiedName: string; path: string };
      callers: { qualifiedName: string; path: string }[];
      files: string[];
    };
    expect(body.symbol).toMatchObject({ qualifiedName: "helper", path: "src/helper.ts" });
    expect(body.callers.map((caller) => caller.qualifiedName)).toContain("run");
    expect(body.files).toContain("src/entry.ts");

    // The report names the symbol, the file it lives in, and where it is used.
    expect(run.text).toContain("helper");
    expect(run.text).toContain("src/helper.ts");
    expect(run.text).toContain("src/entry.ts");
    expect(run.text).toContain("resolved");

    // The recall that ran before the write saw an empty memory.
    const recall = run.toolCalls.find((call) => call.toolName === "nexus_recall");
    expect((JSON.parse(String(recall?.output)) as { totals: { facts: number } }).totals.facts).toBe(0);

    // What the run learned is in the graph, under this user and this repository.
    const repoId = repositoryId(normalizeRootPath(root), salt);
    const facts = await graph.query<{ text: string; scope: string }>(
      "MATCH (f:Fact) WHERE f.repoId = $repoId AND f.userId = $userId RETURN f.text AS text, f.scope AS scope",
      { repoId, userId },
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]?.scope).toBe("symbol");
    expect(facts[0]?.text).toContain("helper");
  });

  it("hands the session over so the next run starts from what this one learned", async () => {
    await connection.callTool("nexus_sync");
    await connection.callTool("nexus_remember", {
      text: "helper() is called by run() and calls deep().",
      scope: "symbol",
    });
    const handoff = await connection.callTool("nexus_handoff", {
      summary: "Indexed the fixture and confirmed the helper call chain.",
      toAgent: "agent-b",
      taskRef: "day-3-agent",
    });
    expect(handoff.ok).toBe(true);

    // A completely new server process, pointed at the same graph, reads it back.
    const server = createNexusServer({ client: graph, root, projectSalt: salt, userId, agentId: "agent-b" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const next = await connectNexusTools({ root, transport: clientTransport });
    try {
      const recalled = await next.callTool("nexus_recall", { query: "helper" });
      expect(recalled.ok).toBe(true);
      const body = recalled.body as {
        facts: { text: string }[];
        handoffs: { fromAgent: string; toAgent: string; taskRef: string; evidenceCount: number }[];
      };
      expect(body.facts).toHaveLength(1);
      expect(body.handoffs).toHaveLength(1);
      expect(body.handoffs[0]).toMatchObject({ fromAgent: "agent-a", toAgent: "agent-b", taskRef: "day-3-agent" });
    } finally {
      await next.close();
    }
  });

  it("reports honestly when the symbol is not in the graph", async () => {
    const { model } = createModel({ NEXUS_PROVIDER: "stub", NEXUS_STUB_SYMBOL: "doesNotExist" });
    const run = await runAgent("What does changing doesNotExist affect?", { model, tools: connection.tools, maxSteps: 8 });

    expect(run.finishReason).toBe("stop");
    expect(run.text).toContain("No indexed symbol matched");
    // The impact tool was still asked, and refused rather than inventing callers.
    const impact = run.toolCalls.find((call) => call.toolName === "nexus_impact");
    expect(impact?.ok).toBe(false);
    expect(impact?.output).toMatch(/Symbol not found/);
    // And the write that depended on that symbol was refused too.
    const remember = run.toolCalls.find((call) => call.toolName === "nexus_remember");
    expect(remember?.ok).toBe(false);
  });

  it("stops at the step budget instead of looping forever", async () => {
    const { model } = createModel({ NEXUS_PROVIDER: "stub", NEXUS_STUB_SYMBOL: "helper" });
    const run = await runAgent("What does changing helper affect?", { model, tools: connection.tools, maxSteps: 2 });

    expect(run.steps).toBeLessThanOrEqual(2);
    expect(run.toolCalls.length).toBeLessThanOrEqual(2);
    expect(run.toolCalls.map((call) => call.toolName)).toEqual(["nexus_sync", "nexus_locate"]);
  });
});
