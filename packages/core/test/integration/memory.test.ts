import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { turnId } from "../../src/ids.js";
import {
  connectGraph,
  GraphRepository,
  MemoryStore,
  type GraphClient,
  type SymbolRecord,
} from "../../src/store/index.js";

const FALKORDB_URL = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const repoId = "repo-memory";
const userId = "user-a";

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
 * Memory is only useful if it outlives the process that wrote it. The tests
 * below use two independent connections to the same graph, which share no
 * JavaScript state at all, so a fact written by one is only visible to the
 * other through FalkorDB.
 */
describe("memory store against FalkorDB", () => {
  let writer: GraphClient;
  let reader: GraphClient;
  let graph: GraphRepository;
  let storeA: MemoryStore;
  let storeB: MemoryStore;
  let clock: number;
  const graphName = `nexus_test_${randomUUID()}`;

  const tick = (): void => {
    clock += 1_000;
  };

  beforeAll(async () => {
    writer = await connectGraph(FALKORDB_URL, graphName);
    reader = await connectGraph(FALKORDB_URL, graphName);
    graph = new GraphRepository(writer);
    await graph.ensureIndexes();
    storeA = new MemoryStore(writer, { now: () => new Date(clock) });
    storeB = new MemoryStore(reader, { now: () => new Date(clock) });
    await storeA.ensureIndexes();
  });

  afterAll(async () => {
    await writer.deleteGraph().catch(() => undefined);
    await writer.close();
    await reader.close();
  });

  beforeEach(async () => {
    clock = Date.parse("2026-10-15T09:00:00.000Z");
    await writer.query("MATCH (n) DETACH DELETE n");
    await graph.upsertRepository({ id: repoId, root: "/work/memory", schemaVersion: 1, indexedRevision: null });
    await graph.replaceFileSymbols(
      repoId,
      {
        id: "f-a",
        repoId,
        path: "src/a.ts",
        hash: "h",
        language: "typescript",
        lineCount: 10,
        indexedAt: "2026-10-15T00:00:00.000Z",
      },
      [symbol("a-run", "run")],
    );
  });

  it("recalls across a second connection what the first one remembered", async () => {
    const session = await storeA.startSession({ userId, repoId, agentId: "agent-a" });
    await storeA.rememberFact({
      userId,
      repoId,
      sessionId: session.sessionId,
      text: "run() is the entry point for the CLI and must stay synchronous.",
      scope: "symbol",
      confidence: 0.9,
      aboutSymbolId: "a-run",
    });

    const recalled = await storeB.recall({ userId, repoId });

    expect(recalled.facts).toHaveLength(1);
    expect(recalled.facts[0]).toMatchObject({
      text: "run() is the entry point for the CLI and must stay synchronous.",
      scope: "symbol",
      confidence: 0.9,
      about: { symbolId: "a-run", qualifiedName: "run", path: "src/a.ts" },
    });
    expect(recalled.totals).toEqual({ facts: 1, procedures: 0, handoffs: 0 });
  });

  it("revises a fact with the same text instead of duplicating it", async () => {
    const text = "The build writes to dist/ and dist/ is not committed.";
    const first = await storeA.rememberFact({ userId, repoId, text, confidence: 0.5 });
    tick();
    const second = await storeB.rememberFact({ userId, repoId, text, confidence: 0.8 });

    expect(second.factId).toBe(first.factId);
    const recalled = await storeA.recall({ userId, repoId });
    expect(recalled.facts).toHaveLength(1);
    expect(recalled.facts[0]).toMatchObject({ confidence: 0.8, createdAt: first.createdAt });
    expect(recalled.facts[0]?.updatedAt).not.toBe(first.updatedAt);
  });

  it("recalls procedures by relevance and counts each surfacing", async () => {
    await storeA.rememberProcedure({
      userId,
      repoId,
      name: "Refresh the index",
      steps: ["Run nexus_sync", "Wait for graphVersion to change", "Re-run nexus_locate"],
      appliesToPath: "src/a.ts",
    });
    await storeA.rememberProcedure({
      userId,
      repoId,
      name: "Check a release",
      steps: ["Read the changelog"],
    });

    const matched = await storeB.recall({ userId, repoId, query: "index" });
    expect(matched.procedures.map((procedure) => procedure.name)).toEqual(["Refresh the index"]);
    expect(matched.procedures[0]).toMatchObject({
      steps: ["Run nexus_sync", "Wait for graphVersion to change", "Re-run nexus_locate"],
      stepCount: 3,
      usedCount: 1,
      appliesTo: "src/a.ts",
    });

    const again = await storeA.recall({ userId, repoId, query: "index" });
    expect(again.procedures[0]?.usedCount).toBe(2);
  });

  it("replaces a procedure of the same name and keeps its use count", async () => {
    const created = await storeA.rememberProcedure({
      userId,
      repoId,
      name: "Find a symbol",
      steps: ["Run nexus_locate"],
    });
    await storeA.recall({ userId, repoId, query: "symbol" });

    const revised = await storeB.rememberProcedure({
      userId,
      repoId,
      name: "find a symbol",
      steps: ["Run nexus_locate", "Call nexus_context on the hit"],
    });

    expect(revised.procedureId).toBe(created.procedureId);
    const recalled = await storeA.recall({ userId, repoId, query: "symbol" });
    expect(recalled.totals.procedures).toBe(1);
    expect(recalled.procedures[0]).toMatchObject({
      steps: ["Run nexus_locate", "Call nexus_context on the hit"],
      usedCount: 2,
    });
  });

  it("hands a session over with its turns as evidence", async () => {
    const session = await storeA.startSession({ userId, repoId, agentId: "agent-a" });
    await storeA.recordTurn({
      sessionId: session.sessionId,
      userId,
      repoId,
      role: "user",
      text: "Rename helper and fix the callers.",
    });
    await storeA.recordTurn({
      sessionId: session.sessionId,
      userId,
      repoId,
      role: "tool",
      text: "nexus_impact{helper}",
      tool: "nexus_impact",
      graphVersion: 4,
    });

    const turns = await storeA.listTurns(session.sessionId, userId);
    expect(turns.map((turn) => [turn.ordinal, turn.tool])).toEqual([
      [1, null],
      [2, "nexus_impact"],
    ]);
    expect(turns[1]?.turnId).toBe(turnId(session.sessionId, 2));

    const handoff = await storeB.writeHandoff({
      userId,
      repoId,
      sessionId: session.sessionId,
      fromAgent: "agent-a",
      toAgent: "agent-b",
      taskRef: "rename-helper",
      summary: "helper is renamed; 3 callers are already updated, 2 remain.",
      evidenceTurnIds: turns.map((turn) => turn.turnId),
    });

    const recalled = await storeB.recall({ userId, repoId, query: "renamed" });
    expect(recalled.handoffs).toHaveLength(1);
    expect(recalled.handoffs[0]).toMatchObject({
      handoffId: handoff.handoffId,
      fromAgent: "agent-a",
      toAgent: "agent-b",
      taskRef: "rename-helper",
      evidenceCount: 2,
      sessionId: session.sessionId,
    });
  });

  it("keeps memory of one user, and of one repository, out of another's reach", async () => {
    await storeA.rememberFact({ userId, repoId, text: "Only user-a should see this." });
    await storeA.rememberFact({ userId: "user-b", repoId, text: "Only user-b should see this." });
    await storeA.rememberFact({ userId, repoId: "repo-other", text: "Only repo-memory should see this." });

    const asUserA = await storeA.recall({ userId, repoId, query: "should" });
    expect(asUserA.facts.map((fact) => fact.text)).toEqual(["Only user-a should see this."]);

    const asUserB = await storeB.recall({ userId: "user-b", repoId, query: "should" });
    expect(asUserB.facts.map((fact) => fact.text)).toEqual(["Only user-b should see this."]);

    const asOtherRepo = await storeB.recall({ userId, repoId: "repo-other", query: "should" });
    expect(asOtherRepo.facts.map((fact) => fact.text)).toEqual(["Only repo-memory should see this."]);
  });

  it("returns the most recently updated memory first when there is no query", async () => {
    await storeA.rememberFact({ userId, repoId, text: "first fact" });
    tick();
    await storeA.rememberFact({ userId, repoId, text: "second fact" });

    const recalled = await storeB.recall({ userId, repoId });
    expect(recalled.facts.map((fact) => fact.text)).toEqual(["second fact", "first fact"]);
  });

  it("can be asked for one kind of memory only", async () => {
    await storeA.rememberFact({ userId, repoId, text: "a fact" });
    await storeA.rememberProcedure({ userId, repoId, name: "a procedure", steps: ["step"] });

    const factsOnly = await storeB.recall({ userId, repoId, include: ["fact"] });
    expect(factsOnly.facts).toHaveLength(1);
    expect(factsOnly.procedures).toEqual([]);
    expect(factsOnly.totals).toEqual({ facts: 1, procedures: 0, handoffs: 0 });
  });

  it("numbers turns per session and refuses a turn for an unknown session", async () => {
    const first = await storeA.startSession({ userId, repoId, agentId: "agent-a" });
    const second = await storeB.startSession({ userId, repoId, agentId: "agent-b" });

    const a1 = await storeA.recordTurn({ sessionId: first.sessionId, userId, repoId, role: "user", text: "one" });
    const a2 = await storeA.recordTurn({ sessionId: first.sessionId, userId, repoId, role: "agent", text: "two" });
    const b1 = await storeB.recordTurn({ sessionId: second.sessionId, userId, repoId, role: "user", text: "one" });

    expect([a1.ordinal, a2.ordinal, b1.ordinal]).toEqual([1, 2, 1]);
    expect(a2.turnId).toBe(turnId(first.sessionId, 2));
    expect(second.sessionId).not.toBe(first.sessionId);

    await expect(
      storeA.recordTurn({ sessionId: "missing", userId, repoId, role: "user", text: "no session" }),
    ).rejects.toThrow(/Session not found/);
  });

  it("rejects empty text, a bad scope, a bad confidence, and an out-of-range limit", async () => {
    await expect(storeA.rememberFact({ userId, repoId, text: "   " })).rejects.toThrow(/must not be empty/);
    await expect(
      storeA.rememberFact({ userId, repoId, text: "fact", scope: "galaxy" as never }),
    ).rejects.toThrow(/scope must be one of/);
    await expect(storeA.rememberFact({ userId, repoId, text: "fact", confidence: 2 })).rejects.toThrow(
      /confidence must be a number from 0 to 1/,
    );
    await expect(storeA.rememberProcedure({ userId, repoId, name: "empty", steps: [] })).rejects.toThrow(
      /at least one step/,
    );
    await expect(storeA.recall({ userId, repoId, limit: 0 })).rejects.toThrow(/limit must be an integer/);
    await expect(storeA.recall({ userId, repoId, limit: 21 })).rejects.toThrow(/limit must be an integer/);
  });

  it("records how far memory has grown in totals, whatever the limit returns", async () => {
    for (const text of ["one", "two", "three"]) {
      await storeA.rememberFact({ userId, repoId, text });
    }

    const recalled = await storeB.recall({ userId, repoId, limit: 1 });
    expect(recalled.facts).toHaveLength(1);
    expect(recalled.totals.facts).toBe(3);
  });
});
