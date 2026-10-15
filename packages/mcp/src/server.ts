import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  findImpact,
  findSymbolPaths,
  getSymbolContext,
  getSymbolRef,
  GraphRepository,
  MemoryStore,
  normalizeRootPath,
  PATH_DIRECTIONS,
  FACT_SCOPES,
  MAX_IMPACT_DEPTH,
  MAX_IMPACT_RESULTS,
  MAX_PATH_DEPTH,
  MAX_PATHS,
  MEMORY_KINDS,
  repositoryId,
  SYMBOL_KINDS,
  symbolSearchText,
  type GraphClient,
  type SessionRecord,
  type SymbolKind,
} from "@nexus/core";
import { RepositoryAnalyzer } from "@nexus/parser-ts";
import { syncRepository } from "@nexus/indexer";

export const MAX_RESULTS = 8;
const MAX_LISTED_PATHS = 50;
const MAX_LISTED_FAILURES = 20;
const MAX_RECALL_LIMIT = 12;
const RECALL_DEFAULT = 6;
const MAX_FACT_CHARS = 400;
const MAX_STEP_CHARS = 200;
const MAX_LISTED_STEPS = 8;
const MAX_SUMMARY_CHARS = 500;
const MAX_TURN_CHARS = 300;

export interface NexusServerOptions {
  client: GraphClient;
  root: string;
  projectSalt: string;
  analyzer?: RepositoryAnalyzer;
  /** Who the memory layer belongs to. Memory is never shared across users. */
  userId?: string;
  agentId?: string;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function json(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function failure(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function whyMatched(query: string, qualifiedName: string): string {
  const simpleName = qualifiedName.split(".").pop() ?? qualifiedName;
  const compactQuery = query.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (compactQuery.length > 0 && simpleName.toLowerCase().includes(compactQuery)) {
    return "name matches";
  }
  const queryWords = symbolSearchText(query).split(" ").filter((word) => word.length > 0);
  const nameWords = symbolSearchText(simpleName).split(" ");
  const matchesName = queryWords.some((word) => nameWords.some((nameWord) => nameWord.startsWith(word)));
  return matchesName ? "name matches" : "signature or doc matches";
}

export function createNexusServer(options: NexusServerOptions): McpServer {
  const root = normalizeRootPath(options.root);
  const repoId = repositoryId(root, options.projectSalt);
  const userId = options.userId ?? "local";
  const agentId = options.agentId ?? "nexus-agent";
  const repository = new GraphRepository(options.client);
  const memory = new MemoryStore(options.client);
  const analyzer = options.analyzer ?? new RepositoryAnalyzer(repoId);
  let syncQueue: Promise<unknown> = Promise.resolve();
  let sessionPromise: Promise<SessionRecord> | undefined;

  /**
   * The session is created on the first memory write, so a read-only run never
   * writes anything. Everything this process remembers hangs off it.
   */
  function currentSession(): Promise<SessionRecord> {
    sessionPromise ??= (async () => {
      await memory.ensureIndexes();
      return memory.startSession({ userId, repoId, agentId });
    })();
    return sessionPromise;
  }

  async function recordTurn(sessionId: string, text: string, tool: string, graphVersion: number): Promise<void> {
    await memory.recordTurn({
      sessionId,
      userId,
      repoId,
      role: "tool",
      text: truncate(text, MAX_TURN_CHARS),
      tool,
      graphVersion,
    });
  }

  const server = new McpServer({ name: "nexus", version: "0.1.0" });

  server.registerTool(
    "nexus_locate",
    {
      title: "Locate symbols",
      description:
        "Find code symbols by name, signature, or doc text. Returns ranked symbols with path, line range, and symbolId for nexus_context. Results are capped at 8.",
      inputSchema: {
        query: z.string().min(1).max(200),
        kind: z.enum(SYMBOL_KINDS).optional(),
        limit: z.number().int().min(1).max(MAX_RESULTS).default(MAX_RESULTS),
      },
    },
    async ({ query, kind, limit }) => {
      const state = await repository.getRepositoryState(repoId);
      if (state.indexedAt === null) {
        return json({
          graphVersion: 0,
          indexedAt: null,
          results: [],
          hint: "The repository has not been indexed. Call nexus_sync first.",
        });
      }

      const wanted: SymbolKind | undefined = kind;
      const hits = await repository.searchSymbols(repoId, query, wanted ? limit * 5 : limit);
      const results = hits
        .filter((hit) => wanted === undefined || hit.kind === wanted)
        .slice(0, limit)
        .map((hit) => ({
          symbolId: hit.symbolId,
          qualifiedName: hit.qualifiedName,
          kind: hit.kind,
          path: hit.path,
          startLine: hit.startLine,
          endLine: hit.endLine,
          signature: hit.signature,
          score: Math.round(hit.score * 100) / 100,
          why: whyMatched(query, hit.qualifiedName),
        }));

      return json({ graphVersion: state.graphVersion, indexedAt: state.indexedAt, results });
    },
  );

  server.registerTool(
    "nexus_context",
    {
      title: "Symbol context",
      description:
        "Show a symbol's direct callers and callees, and the imports of its file. depth 2 adds neighbors reached through one intermediate symbol, with a combined confidence. Each edge is labelled resolved or heuristic. Capped at 8 per list.",
      inputSchema: {
        symbolId: z.string().min(1),
        depth: z.number().int().min(1).max(2).default(1),
        limit: z.number().int().min(1).max(MAX_RESULTS).default(MAX_RESULTS),
      },
    },
    async ({ symbolId, depth, limit }) => {
      const state = await repository.getRepositoryState(repoId);
      const context = await getSymbolContext(options.client, repoId, symbolId, { depth, limit });
      if (!context) {
        return failure("Symbol not found in this repository. Use nexus_locate to find a symbolId.");
      }
      return json({
        graphVersion: state.graphVersion,
        indexedAt: state.indexedAt,
        depth,
        ...context,
      });
    },
  );

  server.registerTool(
    "nexus_path",
    {
      title: "Call path between symbols",
      description:
        "Explain how one symbol reaches another along call edges, hop by hop. Each hop says whether it follows the call or walks against it, and whether the edge is resolved or heuristic. direction \"both\" finds a relationship in either direction. Returns no path when there is none within maxDepth.",
      inputSchema: {
        from: z.string().min(1),
        to: z.string().min(1),
        direction: z.enum(PATH_DIRECTIONS).default("both"),
        maxDepth: z.number().int().min(1).max(MAX_PATH_DEPTH).default(4),
        maxPaths: z.number().int().min(1).max(MAX_PATHS).default(1),
      },
    },
    async ({ from, to, direction, maxDepth, maxPaths }) => {
      if (from === to) {
        return failure("from and to must be two different symbolIds.");
      }
      const state = await repository.getRepositoryState(repoId);
      const result = await findSymbolPaths(options.client, repoId, from, to, { direction, maxDepth, maxPaths });
      if (!result) {
        return failure("Symbol not found in this repository. Use nexus_locate to find a symbolId.");
      }

      const paths = result.paths.map((path) => ({
        hops: path.hops,
        resolution: path.resolution,
        confidence: path.confidence,
        steps: path.steps.map((step) => ({
          direction: step.direction,
          from: { symbolId: step.from.symbolId, qualifiedName: step.from.qualifiedName, path: step.from.path },
          to: { symbolId: step.to.symbolId, qualifiedName: step.to.qualifiedName, path: step.to.path },
          line: step.line,
          resolution: step.resolution,
          confidence: step.confidence,
        })),
      }));

      return json({
        graphVersion: state.graphVersion,
        indexedAt: state.indexedAt,
        from: { symbolId: result.from.symbolId, qualifiedName: result.from.qualifiedName, path: result.from.path },
        to: { symbolId: result.to.symbolId, qualifiedName: result.to.qualifiedName, path: result.to.path },
        direction,
        found: paths.length > 0,
        paths,
        ...(paths.length === 0
          ? { hint: `No call path within ${maxDepth} hops going ${direction}. Try direction "both" or a larger maxDepth.` }
          : {}),
      });
    },
  );

  server.registerTool(
    "nexus_impact",
    {
      title: "Likely impact of a symbol",
      description:
        "List the symbols that call this one, directly or through other symbols, nearest first, with the files they live in. Use it to judge what a change might touch and which tests to run. This is a map of likely impact built from indexed call edges, not a guarantee that any listed caller changes.",
      inputSchema: {
        symbolId: z.string().min(1),
        maxDepth: z.number().int().min(1).max(MAX_IMPACT_DEPTH).default(3),
        limit: z.number().int().min(1).max(MAX_IMPACT_RESULTS).default(12),
      },
    },
    async ({ symbolId, maxDepth, limit }) => {
      const state = await repository.getRepositoryState(repoId);
      const impact = await findImpact(options.client, repoId, symbolId, { maxDepth, limit });
      if (!impact) {
        return failure("Symbol not found in this repository. Use nexus_locate to find a symbolId.");
      }

      return json({
        graphVersion: state.graphVersion,
        indexedAt: state.indexedAt,
        maxDepth,
        symbol: {
          symbolId: impact.symbol.symbolId,
          qualifiedName: impact.symbol.qualifiedName,
          kind: impact.symbol.kind,
          path: impact.symbol.path,
          startLine: impact.symbol.startLine,
          endLine: impact.symbol.endLine,
        },
        disclaimer: "Likely impact from indexed call edges. Not a guarantee that these callers change.",
        totalCallers: impact.totalCallers,
        truncated: impact.truncated,
        files: impact.files,
        callers: impact.callers.map((caller) => ({
          symbolId: caller.symbolId,
          qualifiedName: caller.qualifiedName,
          kind: caller.kind,
          path: caller.path,
          startLine: caller.startLine,
          hops: caller.hops,
          via: caller.via,
          resolution: caller.resolution,
          confidence: caller.confidence,
        })),
      });
    },
  );

  server.registerTool(
    "nexus_remember",
    {
      title: "Remember what you learned",
      description:
        "Write a fact or a procedure into the graph so a later session, or another agent, can recall it. A fact is a statement worth keeping, optionally tied to a symbol. A procedure is a name and ordered steps that worked. Remembering the same fact text again revises it, and a procedure with the same name replaces the earlier one.",
      inputSchema: {
        text: z.string().min(1).max(2000).optional(),
        kind: z.enum(["fact", "procedure"]).default("fact"),
        name: z.string().min(1).max(200).optional(),
        steps: z.array(z.string().min(1).max(500)).min(1).max(20).optional(),
        scope: z.enum(FACT_SCOPES).optional(),
        confidence: z.number().min(0).max(1).optional(),
        aboutSymbolId: z.string().min(1).optional(),
        appliesToPath: z.string().min(1).optional(),
      },
    },
    async ({ kind, text, name, steps, scope, confidence, aboutSymbolId, appliesToPath }) => {
      const state = await repository.getRepositoryState(repoId);
      const session = await currentSession();

      if (kind === "procedure") {
        if (name === undefined || steps === undefined) {
          return failure('kind "procedure" needs a name and at least one step.');
        }
        const procedure = await memory.rememberProcedure({
          userId,
          repoId,
          sessionId: session.sessionId,
          name,
          steps,
          ...(appliesToPath === undefined ? {} : { appliesToPath }),
        });
        await recordTurn(session.sessionId, `${name}: ${steps.join(" | ")}`, "nexus_remember", state.graphVersion);
        return json({
          graphVersion: state.graphVersion,
          indexedAt: state.indexedAt,
          sessionId: session.sessionId,
          kind: "procedure",
          procedureId: procedure.procedureId,
          name: procedure.name,
          stepCount: procedure.stepCount,
          appliesTo: procedure.appliesTo,
          note: "A later session recalls this with nexus_recall, for the same user and repository.",
        });
      }

      if (text === undefined) {
        return failure('kind "fact" needs text.');
      }
      if (aboutSymbolId !== undefined) {
        const symbol = await getSymbolRef(options.client, repoId, aboutSymbolId);
        if (!symbol) {
          return failure("aboutSymbolId is not a symbol in this repository. Use nexus_locate to find one.");
        }
      }
      const fact = await memory.rememberFact({
        userId,
        repoId,
        sessionId: session.sessionId,
        text,
        ...(scope === undefined ? {} : { scope }),
        ...(confidence === undefined ? {} : { confidence }),
        ...(aboutSymbolId === undefined ? {} : { aboutSymbolId }),
      });
      await recordTurn(session.sessionId, text, "nexus_remember", state.graphVersion);
      return json({
        graphVersion: state.graphVersion,
        indexedAt: state.indexedAt,
        sessionId: session.sessionId,
        kind: "fact",
        factId: fact.factId,
        scope: fact.scope,
        confidence: fact.confidence,
        aboutSymbolId: aboutSymbolId ?? null,
        note: "A later session recalls this with nexus_recall, for the same user and repository.",
      });
    },
  );

  server.registerTool(
    "nexus_recall",
    {
      title: "Recall what was learned",
      description:
        "Read back facts, procedures, and handoffs written by earlier sessions of this user and repository, inside or outside this process. With a query it ranks by relevance, without one it returns the most recent. Recalling raises the use count of what it returns, so the graph records how memory is being used.",
      inputSchema: {
        query: z.string().max(200).optional(),
        include: z.array(z.enum(MEMORY_KINDS)).min(1).optional(),
        limit: z.number().int().min(1).max(MAX_RECALL_LIMIT).default(RECALL_DEFAULT),
      },
    },
    async ({ query, include, limit }) => {
      const state = await repository.getRepositoryState(repoId);
      const recalled = await memory.recall({
        userId,
        repoId,
        limit,
        ...(query === undefined ? {} : { query }),
        ...(include === undefined ? {} : { include }),
      });

      return json({
        graphVersion: state.graphVersion,
        indexedAt: state.indexedAt,
        query: query ?? null,
        totals: recalled.totals,
        facts: recalled.facts.map((fact) => ({
          factId: fact.factId,
          text: truncate(fact.text, MAX_FACT_CHARS),
          scope: fact.scope,
          confidence: fact.confidence,
          usedCount: fact.usedCount,
          updatedAt: fact.updatedAt,
          about: fact.about,
        })),
        procedures: recalled.procedures.map((procedure) => ({
          procedureId: procedure.procedureId,
          name: procedure.name,
          steps: procedure.steps.slice(0, MAX_LISTED_STEPS).map((step) => truncate(step, MAX_STEP_CHARS)),
          stepCount: procedure.stepCount,
          usedCount: procedure.usedCount,
          updatedAt: procedure.updatedAt,
          appliesTo: procedure.appliesTo,
        })),
        handoffs: recalled.handoffs.map((handoff) => ({
          handoffId: handoff.handoffId,
          summary: truncate(handoff.summary, MAX_SUMMARY_CHARS),
          fromAgent: handoff.fromAgent,
          toAgent: handoff.toAgent,
          taskRef: handoff.taskRef,
          createdAt: handoff.createdAt,
          evidenceCount: handoff.evidenceCount,
        })),
        ...(recalled.facts.length === 0 && recalled.procedures.length === 0 && recalled.handoffs.length === 0
          ? { hint: "Nothing remembered yet for this user and repository. Write with nexus_remember." }
          : {}),
      });
    },
  );

  server.registerTool(
    "nexus_handoff",
    {
      title: "Hand this session over",
      description:
        "Write a handoff for the next agent or session: what was done, what is left, and what to watch out for. The turns of this session are attached as evidence. The next session reads it with nexus_recall.",
      inputSchema: {
        summary: z.string().min(1).max(2000),
        toAgent: z.string().min(1).max(100).optional(),
        taskRef: z.string().min(1).max(200).optional(),
      },
    },
    async ({ summary, toAgent, taskRef }) => {
      const state = await repository.getRepositoryState(repoId);
      const session = await currentSession();
      const turns = await memory.listTurns(session.sessionId, userId);
      const handoff = await memory.writeHandoff({
        userId,
        repoId,
        sessionId: session.sessionId,
        fromAgent: agentId,
        summary,
        evidenceTurnIds: turns.map((turn) => turn.turnId),
        ...(toAgent === undefined ? {} : { toAgent }),
        ...(taskRef === undefined ? {} : { taskRef }),
      });

      return json({
        graphVersion: state.graphVersion,
        indexedAt: state.indexedAt,
        handoffId: handoff.handoffId,
        sessionId: session.sessionId,
        fromAgent: agentId,
        toAgent: toAgent ?? null,
        taskRef: taskRef ?? null,
        evidenceTurns: turns.length,
        note: "The next session reads this with nexus_recall, for the same user and repository.",
      });
    },
  );

  server.registerTool(
    "nexus_sync",
    {
      title: "Sync the index",
      description:
        "Bring the graph up to date with the repository on disk. Returns the new graphVersion, which files changed or were removed, and any files that could not be fully analyzed. Call it after editing files before relying on locate or context results.",
      inputSchema: {},
    },
    async () => {
      const run = syncQueue.then(() => syncRepository({ client: options.client, root, projectSalt: options.projectSalt, analyzer }));
      syncQueue = run.catch(() => undefined);
      try {
        const result = await run;
        return json({
          graphVersion: result.graphVersion,
          indexedAt: result.indexedAt,
          filesWritten: result.filesWritten,
          unchanged: result.unchanged,
          changedPaths: result.changedPaths.slice(0, MAX_LISTED_PATHS),
          removedPaths: result.removedPaths.slice(0, MAX_LISTED_PATHS),
          importsWritten: result.importsWritten,
          callsWritten: result.callsWritten,
          failures: result.failures.slice(0, MAX_LISTED_FAILURES),
          failureCount: result.failures.length,
        });
      } catch (error) {
        return failure(`Sync failed: ${(error as Error).message}`);
      }
    },
  );

  return server;
}
