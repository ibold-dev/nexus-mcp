import {
  factId as computeFactId,
  handoffId as computeHandoffId,
  procedureId as computeProcedureId,
  sessionId as computeSessionId,
} from "../ids.js";
import {
  FACT_SCOPES,
  MEMORY_KINDS,
  type FactScope,
  type MemoryKind,
  type TurnRole,
} from "../schema.js";
import type { GraphClient } from "./graph-client.js";

export const MAX_RECALL_RESULTS = 20;
export const DEFAULT_RECALL_RESULTS = 8;
const MAX_TEXT_LENGTH = 2_000;
const MAX_STEPS = 20;

export interface MemoryStoreOptions {
  now?: () => Date;
}

export interface StartSessionInput {
  userId: string;
  repoId: string;
  agentId: string;
  summary?: string;
}

export interface SessionRecord {
  sessionId: string;
  userId: string;
  repoId: string;
  agentId: string;
  startedAt: string;
  summary: string | null;
}

export interface TurnInput {
  sessionId: string;
  userId: string;
  repoId: string;
  role: TurnRole;
  text: string;
  tool?: string;
  graphVersion?: number;
}

export interface TurnRecord {
  turnId: string;
  ordinal: number;
  at: string;
}

export interface RememberFactInput {
  userId: string;
  repoId: string;
  text: string;
  sessionId?: string;
  scope?: FactScope;
  confidence?: number;
  aboutSymbolId?: string;
}

export interface FactRecord {
  factId: string;
  text: string;
  scope: FactScope;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  usedCount: number;
  about: { symbolId: string; qualifiedName: string; path: string } | null;
}

export interface RememberProcedureInput {
  userId: string;
  repoId: string;
  name: string;
  steps: readonly string[];
  sessionId?: string;
  appliesToPath?: string;
  evidenceTurnId?: string;
}

export interface ProcedureRecord {
  procedureId: string;
  name: string;
  steps: string[];
  stepCount: number;
  usedCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  appliesTo: string | null;
}

export interface WriteHandoffInput {
  userId: string;
  repoId: string;
  sessionId: string;
  fromAgent: string;
  summary: string;
  toAgent?: string;
  taskRef?: string;
  evidenceTurnIds?: readonly string[];
}

export interface HandoffRecord {
  handoffId: string;
  summary: string;
  fromAgent: string;
  toAgent: string | null;
  taskRef: string | null;
  createdAt: string;
  sessionId: string;
  evidenceCount: number;
}

export interface RecallInput {
  userId: string;
  repoId: string;
  query?: string;
  include?: readonly MemoryKind[];
  limit?: number;
}

export interface RecallResult {
  facts: FactRecord[];
  procedures: ProcedureRecord[];
  handoffs: HandoffRecord[];
  /** How many of each kind exist for this user and repository, before the limit. */
  totals: { facts: number; procedures: number; handoffs: number };
}

interface FactRow {
  factId: string;
  text: string;
  scope: FactScope;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  usedCount: number | null;
  symbolId: string | null;
  symbolName: string | null;
  symbolPath: string | null;
}

interface ProcedureRow {
  procedureId: string;
  name: string;
  steps: string;
  stepCount: number | null;
  usedCount: number | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  appliesTo: string | null;
}

interface HandoffRow {
  handoffId: string;
  summary: string;
  fromAgent: string;
  toAgent: string | null;
  taskRef: string | null;
  createdAt: string;
  sessionId: string | null;
  evidenceCount: number | null;
}

function clampConfidence(value: number | undefined): number {
  if (value === undefined) {
    return 0.6;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("confidence must be a number from 0 to 1");
  }
  return Number(value.toFixed(2));
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new Error(`${field} must be at most ${MAX_TEXT_LENGTH} characters`);
  }
  return trimmed;
}

function parseSteps(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((step): step is string => typeof step === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The memory layer: what agents learned and did, kept in the graph beside the
 * code. Every node carries `userId` and `repoId`, and every read filters on
 * both, so two users or two repositories never see each other's memory.
 */
export class MemoryStore {
  private readonly now: () => Date;

  constructor(
    private readonly client: GraphClient,
    options: MemoryStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  async ensureIndexes(): Promise<void> {
    for (const label of ["User", "Session", "Turn", "Fact", "Procedure", "Handoff"]) {
      await this.client.createRangeIndex(label, "id");
    }
    await this.client.createRangeIndex("Fact", "userId");
    await this.client.createRangeIndex("Procedure", "userId");
    await this.client.createRangeIndex("Handoff", "userId");
    await this.client.createFullTextIndex("Fact", ["text"]);
    await this.client.createFullTextIndex("Procedure", ["name", "text"]);
    await this.client.createFullTextIndex("Handoff", ["summary"]);
  }

  async startSession(input: StartSessionInput): Promise<SessionRecord> {
    const startedAt = this.timestamp();
    const sessionId = computeSessionId(input.repoId, input.userId, input.agentId, startedAt);
    await this.client.query(
      `MERGE (u:User {id: $userId})
       MERGE (s:Session {id: $sessionId})
       SET s.userId = $userId,
           s.repoId = $repoId,
           s.agentId = $agentId,
           s.startedAt = $startedAt,
           s.turnCount = coalesce(s.turnCount, 0),
           s.summary = coalesce($summary, s.summary)
       MERGE (u)-[:OWNS]->(s)
       WITH s
       OPTIONAL MATCH (r:Repository {id: $repoId})
       FOREACH (_ IN CASE WHEN r IS NULL THEN [] ELSE [1] END | MERGE (r)-[:SCOPES]->(s))`,
      {
        userId: input.userId,
        repoId: input.repoId,
        sessionId,
        agentId: input.agentId,
        startedAt,
        summary: input.summary ?? null,
      },
    );
    return {
      sessionId,
      userId: input.userId,
      repoId: input.repoId,
      agentId: input.agentId,
      startedAt,
      summary: input.summary ?? null,
    };
  }

  /** Appends a turn, using the session's own counter so the order can never drift. */
  async recordTurn(input: TurnInput): Promise<TurnRecord> {
    const at = this.timestamp();
    const rows = await this.client.query<{ turnId: string; ordinal: number }>(
      `MATCH (s:Session {id: $sessionId})
       SET s.turnCount = coalesce(s.turnCount, 0) + 1
       WITH s, s.turnCount AS ordinal
       CREATE (t:Turn {id: $sessionId + '#' + toString(ordinal)})
       SET t.sessionId = $sessionId,
           t.userId = $userId,
           t.repoId = $repoId,
           t.role = $role,
           t.text = $text,
           t.ordinal = ordinal,
           t.at = $at,
           t.tool = $tool,
           t.graphVersion = $graphVersion
       MERGE (s)-[:HAS_TURN {ordinal: ordinal}]->(t)
       RETURN t.id AS turnId, ordinal`,
      {
        sessionId: input.sessionId,
        userId: input.userId,
        repoId: input.repoId,
        role: input.role,
        text: requireText(input.text, "turn text"),
        at,
        tool: input.tool ?? null,
        graphVersion: input.graphVersion ?? null,
      },
    );

    const row = rows[0];
    if (!row) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }
    return { turnId: row.turnId, ordinal: row.ordinal, at };
  }

  /** Remembering the same text again revises the existing fact instead of duplicating it. */
  async rememberFact(input: RememberFactInput): Promise<FactRecord> {
    const text = requireText(input.text, "fact text");
    const scope: FactScope = input.scope ?? "repository";
    if (!FACT_SCOPES.includes(scope)) {
      throw new Error(`scope must be one of ${FACT_SCOPES.join(", ")}`);
    }
    const confidence = clampConfidence(input.confidence);
    const at = this.timestamp();
    const factId = computeFactId(input.repoId, input.userId, text);

    await this.client.query(
      `MERGE (f:Fact {id: $factId})
       ON CREATE SET f.createdAt = $at, f.usedCount = 0
       SET f.text = $text,
           f.scope = $scope,
           f.confidence = $confidence,
           f.userId = $userId,
           f.repoId = $repoId,
           f.updatedAt = $at
       WITH f
       OPTIONAL MATCH (s:Session {id: $sessionId})
       FOREACH (_ IN CASE WHEN s IS NULL THEN [] ELSE [1] END | MERGE (s)-[:LEARNED]->(f))
       WITH f
       OPTIONAL MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(:File)-[:CONTAINS]->(sym:Symbol {id: $symbolId})
       FOREACH (_ IN CASE WHEN sym IS NULL THEN [] ELSE [1] END | MERGE (f)-[:ABOUT]->(sym))`,
      {
        factId,
        text,
        scope,
        confidence,
        userId: input.userId,
        repoId: input.repoId,
        sessionId: input.sessionId ?? null,
        symbolId: input.aboutSymbolId ?? null,
        at,
      },
    );

    return {
      factId,
      text,
      scope,
      confidence,
      createdAt: at,
      updatedAt: at,
      usedCount: 0,
      about: null,
    };
  }

  /** Procedures are keyed by name, so a corrected procedure replaces the old one and keeps its use count. */
  async rememberProcedure(input: RememberProcedureInput): Promise<ProcedureRecord> {
    const name = requireText(input.name, "procedure name");
    if (input.steps.length === 0) {
      throw new Error("a procedure needs at least one step");
    }
    if (input.steps.length > MAX_STEPS) {
      throw new Error(`a procedure can have at most ${MAX_STEPS} steps`);
    }
    const steps = input.steps.map((step) => requireText(step, "procedure step"));
    const at = this.timestamp();
    const procedureId = computeProcedureId(input.repoId, input.userId, name);

    await this.client.query(
      `MERGE (p:Procedure {id: $procedureId})
       ON CREATE SET p.createdAt = $at, p.usedCount = 0
       SET p.name = $name,
           p.text = $text,
           p.steps = $steps,
           p.stepCount = $stepCount,
           p.userId = $userId,
           p.repoId = $repoId,
           p.updatedAt = $at
       WITH p
       OPTIONAL MATCH (s:Session {id: $sessionId})
       FOREACH (_ IN CASE WHEN s IS NULL THEN [] ELSE [1] END | MERGE (s)-[:USED]->(p))
       WITH p
       OPTIONAL MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(file:File {path: $appliesToPath})
       FOREACH (_ IN CASE WHEN file IS NULL THEN [] ELSE [1] END | MERGE (p)-[:APPLIES_TO]->(file))
       WITH p
       OPTIONAL MATCH (t:Turn {id: $evidenceTurnId})
       FOREACH (_ IN CASE WHEN t IS NULL THEN [] ELSE [1] END | MERGE (p)-[:EVIDENCE]->(t))`,
      {
        procedureId,
        name,
        text: steps.join(" | "),
        steps: JSON.stringify(steps),
        stepCount: steps.length,
        userId: input.userId,
        repoId: input.repoId,
        sessionId: input.sessionId ?? null,
        appliesToPath: input.appliesToPath ?? null,
        evidenceTurnId: input.evidenceTurnId ?? null,
        at,
      },
    );

    return {
      procedureId,
      name,
      steps,
      stepCount: steps.length,
      usedCount: 0,
      createdAt: at,
      updatedAt: at,
      lastUsedAt: null,
      appliesTo: input.appliesToPath ?? null,
    };
  }

  async writeHandoff(input: WriteHandoffInput): Promise<HandoffRecord> {
    const summary = requireText(input.summary, "handoff summary");
    const at = this.timestamp();
    const handoffId = computeHandoffId(input.sessionId, input.taskRef);

    await this.client.query(
      `MERGE (h:Handoff {id: $handoffId})
       ON CREATE SET h.createdAt = $at
       SET h.summary = $summary,
           h.fromAgent = $fromAgent,
           h.toAgent = $toAgent,
           h.taskRef = $taskRef,
           h.userId = $userId,
           h.repoId = $repoId,
           h.updatedAt = $at
       WITH h
       OPTIONAL MATCH (s:Session {id: $sessionId})
       FOREACH (_ IN CASE WHEN s IS NULL THEN [] ELSE [1] END | MERGE (h)-[:FROM_SESSION]->(s))
       WITH h
       OPTIONAL MATCH (t:Turn) WHERE t.id IN $evidenceTurnIds
       FOREACH (_ IN CASE WHEN t IS NULL THEN [] ELSE [1] END | MERGE (h)-[:EVIDENCE]->(t))`,
      {
        handoffId,
        summary,
        fromAgent: input.fromAgent,
        toAgent: input.toAgent ?? null,
        taskRef: input.taskRef ?? null,
        userId: input.userId,
        repoId: input.repoId,
        sessionId: input.sessionId,
        evidenceTurnIds: [...(input.evidenceTurnIds ?? [])],
        at,
      },
    );

    return {
      handoffId,
      summary,
      fromAgent: input.fromAgent,
      toAgent: input.toAgent ?? null,
      taskRef: input.taskRef ?? null,
      createdAt: at,
      sessionId: input.sessionId,
      evidenceCount: input.evidenceTurnIds?.length ?? 0,
    };
  }

  /**
   * Reads memory back for one user and repository. With a query it ranks by
   * full-text score; without one it returns the most recently updated.
   * Returned facts and procedures have their use count raised, so recall
   * itself is recorded in the graph.
   */
  async recall(input: RecallInput): Promise<RecallResult> {
    const limit = input.limit ?? DEFAULT_RECALL_RESULTS;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECALL_RESULTS) {
      throw new Error(`limit must be an integer from 1 to ${MAX_RECALL_RESULTS}`);
    }
    const include = input.include ?? MEMORY_KINDS;
    const query = input.query?.trim();
    const scope = { userId: input.userId, repoId: input.repoId };

    const facts = include.includes("fact") ? await this.recallFacts(scope, query, limit) : [];
    const procedures = include.includes("procedure") ? await this.recallProcedures(scope, query, limit) : [];
    const handoffs = include.includes("handoff") ? await this.recallHandoffs(scope, query, limit) : [];

    // Surfacing is recorded in the graph, and the response reports the counts
    // as they stand after the call, so it agrees with what the graph holds.
    const at = this.timestamp();
    if (facts.length > 0 || procedures.length > 0) {
      await this.markSurfaced(facts, procedures, at);
    }

    return {
      facts: facts.map((fact) => ({ ...fact, usedCount: fact.usedCount + 1 })),
      procedures: procedures.map((procedure) => ({
        ...procedure,
        usedCount: procedure.usedCount + 1,
        lastUsedAt: at,
      })),
      handoffs,
      totals: await this.totals(scope, include),
    };
  }

  private async recallFacts(
    scope: { userId: string; repoId: string },
    query: string | undefined,
    limit: number,
  ): Promise<FactRecord[]> {
    const fullText = query === undefined || query.length === 0 ? undefined : query;
    const rows = await this.client.query<FactRow>(
      fullText === undefined
        ? `${FACT_MATCH}
           RETURN ${FACT_RETURN}
           ORDER BY f.updatedAt DESC
           LIMIT $limit`
        : `CALL db.idx.fulltext.queryNodes('Fact', $query) YIELD node AS f, score
           WITH f, score
           MATCH (f:Fact)
           WHERE f.userId = $userId AND f.repoId = $repoId
           ${FACT_JOINS}
           RETURN ${FACT_RETURN}, score AS score
           ORDER BY score DESC, f.updatedAt DESC
           LIMIT $limit`,
      fullText === undefined ? { ...scope, limit } : { ...scope, limit, query: fullText },
    );
    return rows.map(toFactRecord);
  }

  private async recallProcedures(
    scope: { userId: string; repoId: string },
    query: string | undefined,
    limit: number,
  ): Promise<ProcedureRecord[]> {
    const rows = await this.client.query<ProcedureRow>(
      query === undefined || query.length === 0
        ? `${PROCEDURE_MATCH}
           RETURN ${PROCEDURE_RETURN}
           ORDER BY p.updatedAt DESC
           LIMIT $limit`
        : `CALL db.idx.fulltext.queryNodes('Procedure', $query) YIELD node AS p, score
           WITH p, score
           MATCH (p:Procedure)
           WHERE p.userId = $userId AND p.repoId = $repoId
           ${PROCEDURE_JOINS}
           RETURN ${PROCEDURE_RETURN}, score AS score
           ORDER BY score DESC, p.usedCount DESC, p.updatedAt DESC
           LIMIT $limit`,
      query === undefined || query.length === 0 ? { ...scope, limit } : { ...scope, limit, query },
    );
    return rows.map(toProcedureRecord);
  }

  private async recallHandoffs(
    scope: { userId: string; repoId: string },
    query: string | undefined,
    limit: number,
  ): Promise<HandoffRecord[]> {
    const rows = await this.client.query<HandoffRow>(
      query === undefined || query.length === 0
        ? `MATCH (h:Handoff)
           WHERE h.userId = $userId AND h.repoId = $repoId
           OPTIONAL MATCH (h)-[:FROM_SESSION]->(s:Session)
           OPTIONAL MATCH (h)-[:EVIDENCE]->(t:Turn)
           RETURN h.id AS handoffId, h.summary AS summary, h.fromAgent AS fromAgent, h.toAgent AS toAgent,
                  h.taskRef AS taskRef, h.createdAt AS createdAt, s.id AS sessionId, count(t) AS evidenceCount
           ORDER BY h.createdAt DESC
           LIMIT $limit`
        : `CALL db.idx.fulltext.queryNodes('Handoff', $query) YIELD node AS h, score
           WITH h, score
           MATCH (h:Handoff)
           WHERE h.userId = $userId AND h.repoId = $repoId
           OPTIONAL MATCH (h)-[:FROM_SESSION]->(s:Session)
           OPTIONAL MATCH (h)-[:EVIDENCE]->(t:Turn)
           RETURN h.id AS handoffId, h.summary AS summary, h.fromAgent AS fromAgent, h.toAgent AS toAgent,
                  h.taskRef AS taskRef, h.createdAt AS createdAt, s.id AS sessionId, count(t) AS evidenceCount, score AS score
           ORDER BY score DESC, h.createdAt DESC
           LIMIT $limit`,
      query === undefined || query.length === 0 ? { ...scope, limit } : { ...scope, limit, query },
    );
    return rows.map((row) => ({
      handoffId: row.handoffId,
      summary: row.summary,
      fromAgent: row.fromAgent,
      toAgent: row.toAgent,
      taskRef: row.taskRef,
      createdAt: row.createdAt,
      sessionId: row.sessionId ?? "",
      evidenceCount: row.evidenceCount ?? 0,
    }));
  }

  private async markSurfaced(
    facts: readonly FactRecord[],
    procedures: readonly ProcedureRecord[],
    at: string,
  ): Promise<void> {
    if (facts.length > 0) {
      await this.client.query(
        `MATCH (f:Fact) WHERE f.id IN $ids
         SET f.usedCount = coalesce(f.usedCount, 0) + 1, f.lastUsedAt = $at`,
        { ids: facts.map((fact) => fact.factId), at },
      );
    }
    if (procedures.length > 0) {
      await this.client.query(
        `MATCH (p:Procedure) WHERE p.id IN $ids
         SET p.usedCount = coalesce(p.usedCount, 0) + 1, p.lastUsedAt = $at`,
        { ids: procedures.map((procedure) => procedure.procedureId), at },
      );
    }
  }

  private async totals(
    scope: { userId: string; repoId: string },
    include: readonly MemoryKind[],
  ): Promise<{ facts: number; procedures: number; handoffs: number }> {
    const count = async (label: "Fact" | "Procedure" | "Handoff", kind: MemoryKind): Promise<number> => {
      if (!include.includes(kind)) {
        return 0;
      }
      const rows = await this.client.query<{ count: number }>(
        `MATCH (n:${label}) WHERE n.userId = $userId AND n.repoId = $repoId RETURN count(n) AS count`,
        scope,
      );
      return rows[0]?.count ?? 0;
    };
    return {
      facts: await count("Fact", "fact"),
      procedures: await count("Procedure", "procedure"),
      handoffs: await count("Handoff", "handoff"),
    };
  }

  /** The turns of a session, oldest first, so a handoff can cite what happened. */
  async listTurns(sessionId: string, userId: string): Promise<{ turnId: string; ordinal: number; role: string; text: string; tool: string | null; at: string }[]> {
    return this.client.query(
      `MATCH (s:Session {id: $sessionId})-[:HAS_TURN]->(t:Turn)
       WHERE t.userId = $userId
       RETURN t.id AS turnId, t.ordinal AS ordinal, t.role AS role, t.text AS text, t.tool AS tool, t.at AS at
       ORDER BY t.ordinal ASC`,
      { sessionId, userId },
    );
  }
}

const FACT_JOINS = `OPTIONAL MATCH (f)-[:ABOUT]->(sym:Symbol)
       OPTIONAL MATCH (sym)<-[:CONTAINS]-(file:File)`;
const FACT_MATCH = `MATCH (f:Fact)
       WHERE f.userId = $userId AND f.repoId = $repoId
       ${FACT_JOINS}`;
const FACT_RETURN = `f.id AS factId, f.text AS text, f.scope AS scope, f.confidence AS confidence,
              f.createdAt AS createdAt, f.updatedAt AS updatedAt, f.usedCount AS usedCount,
              sym.id AS symbolId, sym.qualifiedName AS symbolName, file.path AS symbolPath`;

const PROCEDURE_JOINS = `OPTIONAL MATCH (p)-[:APPLIES_TO]->(file:File)`;
const PROCEDURE_MATCH = `MATCH (p:Procedure)
       WHERE p.userId = $userId AND p.repoId = $repoId
       ${PROCEDURE_JOINS}`;
const PROCEDURE_RETURN = `p.id AS procedureId, p.name AS name, p.steps AS steps, p.stepCount AS stepCount,
              p.usedCount AS usedCount, p.createdAt AS createdAt, p.updatedAt AS updatedAt,
              p.lastUsedAt AS lastUsedAt, file.path AS appliesTo`;

function toFactRecord(row: FactRow): FactRecord {
  return {
    factId: row.factId,
    text: row.text,
    scope: row.scope,
    confidence: row.confidence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    usedCount: row.usedCount ?? 0,
    about:
      row.symbolId && row.symbolName && row.symbolPath
        ? { symbolId: row.symbolId, qualifiedName: row.symbolName, path: row.symbolPath }
        : null,
  };
}

function toProcedureRecord(row: ProcedureRow): ProcedureRecord {
  return {
    procedureId: row.procedureId,
    name: row.name,
    steps: parseSteps(row.steps),
    stepCount: row.stepCount ?? parseSteps(row.steps).length,
    usedCount: row.usedCount ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
    appliesTo: row.appliesTo,
  };
}
