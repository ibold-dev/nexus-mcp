import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  findImpact,
  findSymbolPaths,
  getSymbolContext,
  GraphRepository,
  normalizeRootPath,
  PATH_DIRECTIONS,
  MAX_IMPACT_DEPTH,
  MAX_IMPACT_RESULTS,
  MAX_PATH_DEPTH,
  MAX_PATHS,
  repositoryId,
  SYMBOL_KINDS,
  symbolSearchText,
  type GraphClient,
  type SymbolKind,
} from "@nexus/core";
import { RepositoryAnalyzer } from "@nexus/parser-ts";
import { syncRepository } from "@nexus/indexer";

export const MAX_RESULTS = 8;
const MAX_LISTED_PATHS = 50;
const MAX_LISTED_FAILURES = 20;

export interface NexusServerOptions {
  client: GraphClient;
  root: string;
  projectSalt: string;
  analyzer?: RepositoryAnalyzer;
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
  const repository = new GraphRepository(options.client);
  const analyzer = options.analyzer ?? new RepositoryAnalyzer(repoId);
  let syncQueue: Promise<unknown> = Promise.resolve();

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
