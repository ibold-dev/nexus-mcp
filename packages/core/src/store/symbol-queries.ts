import type { GraphClient } from "./graph-client.js";
import type { Resolution, SymbolKind } from "../schema.js";

export const MAX_CONTEXT_DEPTH = 2;
export const MAX_RESULTS = 50;

export interface SymbolRef {
  symbolId: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  signature: string;
  path: string;
  startLine: number;
  endLine: number;
}

export interface CallNeighbor extends SymbolRef {
  hops: 1 | 2;
  via: string | null;
  line: number;
  resolution: Resolution;
  confidence: number;
}

export interface SymbolContext {
  symbol: SymbolRef;
  imports: { path: string; specifier: string }[];
  callees: CallNeighbor[];
  callers: CallNeighbor[];
}

export interface ContextOptions {
  depth: number;
  limit: number;
}

export const PATH_DIRECTIONS = ["outgoing", "incoming", "both"] as const;
export type PathDirection = (typeof PATH_DIRECTIONS)[number];

export const MAX_PATH_DEPTH = 8;
export const MAX_PATHS = 3;

export interface SymbolStep {
  symbolId: string;
  qualifiedName: string;
  kind: SymbolKind;
  path: string;
}

export interface PathStep {
  /** "outgoing" when this hop follows the call edge, "incoming" when it walks against it. */
  direction: "outgoing" | "incoming";
  from: SymbolStep;
  to: SymbolStep;
  line: number;
  resolution: Resolution;
  confidence: number;
}

export interface SymbolPath {
  hops: number;
  resolution: Resolution;
  confidence: number;
  steps: PathStep[];
}

export interface SymbolPathsResult {
  from: SymbolRef;
  to: SymbolRef;
  paths: SymbolPath[];
}

export interface PathOptions {
  direction: PathDirection;
  maxDepth: number;
  maxPaths: number;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function assertPathBounds(options: PathOptions): void {
  if (!PATH_DIRECTIONS.includes(options.direction)) {
    throw new Error(`direction must be one of ${PATH_DIRECTIONS.join(", ")}`);
  }
  if (!Number.isInteger(options.maxDepth) || options.maxDepth < 1 || options.maxDepth > MAX_PATH_DEPTH) {
    throw new Error(`maxDepth must be an integer from 1 to ${MAX_PATH_DEPTH}`);
  }
  if (!Number.isInteger(options.maxPaths) || options.maxPaths < 1 || options.maxPaths > MAX_PATHS) {
    throw new Error(`maxPaths must be an integer from 1 to ${MAX_PATHS}`);
  }
}

async function loadSteps(
  client: GraphClient,
  repoId: string,
  symbolIds: readonly string[],
): Promise<Map<string, SymbolStep>> {
  const rows = await client.query<SymbolStep>(
    `MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(f:File)-[:CONTAINS]->(s:Symbol)
     WHERE s.id IN $symbolIds
     RETURN s.id AS symbolId, s.qualifiedName AS qualifiedName, s.kind AS kind, f.path AS path`,
    { repoId, symbolIds: [...symbolIds] },
  );
  return new Map(rows.map((row) => [row.symbolId, row]));
}

interface FoundPathRow {
  ids: string[];
  sources: string[];
  resolutions: Resolution[];
  confidences: number[];
  lines: number[];
}

/**
 * Shortest call paths between two symbols, using FalkorDB's algo.SPpaths.
 * Hops are labelled by whether they follow the call edge or walk against it,
 * and a path's confidence is the product of its edge confidences.
 */
export async function findSymbolPaths(
  client: GraphClient,
  repoId: string,
  fromSymbolId: string,
  toSymbolId: string,
  options: PathOptions,
): Promise<SymbolPathsResult | undefined> {
  assertPathBounds(options);
  const from = await getSymbolRef(client, repoId, fromSymbolId);
  const to = await getSymbolRef(client, repoId, toSymbolId);
  if (!from || !to) {
    return undefined;
  }

  // `direction` is validated against a closed set above, so inlining it is safe.
  const rows = await client.query<FoundPathRow>(
    `MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(:File)-[:CONTAINS]->(s:Symbol {id: $fromSymbolId})
     MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(:File)-[:CONTAINS]->(t:Symbol {id: $toSymbolId})
     CALL algo.SPpaths({
       sourceNode: s,
       targetNode: t,
       relTypes: ['POSSIBLY_CALLS'],
       relDirection: '${options.direction}',
       maxLen: $maxDepth,
       pathCount: $maxPaths
     })
     YIELD path
     RETURN [n IN nodes(path) | n.id] AS ids,
            [r IN relationships(path) | startNode(r).id] AS sources,
            [r IN relationships(path) | r.resolution] AS resolutions,
            [r IN relationships(path) | r.confidence] AS confidences,
            [r IN relationships(path) | r.line] AS lines`,
    { repoId, fromSymbolId, toSymbolId, maxDepth: options.maxDepth, maxPaths: options.maxPaths },
  );

  const steps = await loadSteps(client, repoId, rows.flatMap((row) => row.ids));
  const paths: SymbolPath[] = [];
  for (const row of rows) {
    const hops = row.ids.length - 1;
    if (hops < 1) {
      continue;
    }
    const resolvedSteps: PathStep[] = [];
    for (let hop = 0; hop < hops; hop += 1) {
      const fromNode = steps.get(row.ids[hop] ?? "");
      const toNode = steps.get(row.ids[hop + 1] ?? "");
      if (!fromNode || !toNode) {
        break;
      }
      resolvedSteps.push({
        direction: row.sources[hop] === fromNode.symbolId ? "outgoing" : "incoming",
        from: fromNode,
        to: toNode,
        line: row.lines[hop] ?? 0,
        resolution: row.resolutions[hop] ?? "resolved",
        confidence: row.confidences[hop] ?? 1,
      });
    }
    if (resolvedSteps.length !== hops) {
      continue;
    }
    paths.push({
      hops,
      resolution: resolvedSteps.some((step) => step.resolution === "heuristic") ? "heuristic" : "resolved",
      confidence: round4(resolvedSteps.reduce((product, step) => product * step.confidence, 1)),
      steps: resolvedSteps,
    });
  }

  paths.sort((a, b) => a.hops - b.hops || a.confidence - b.confidence);
  return { from, to, paths };
}


function assertBounds(options: ContextOptions): void {
  if (!Number.isInteger(options.depth) || options.depth < 1 || options.depth > MAX_CONTEXT_DEPTH) {
    throw new Error(`depth must be an integer from 1 to ${MAX_CONTEXT_DEPTH}`);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_RESULTS) {
    throw new Error(`limit must be an integer from 1 to ${MAX_RESULTS}`);
  }
}

const SYMBOL_RETURN = `t.id AS symbolId, t.name AS name, t.qualifiedName AS qualifiedName,
  t.kind AS kind, t.signature AS signature, g.path AS path, t.startLine AS startLine, t.endLine AS endLine`;

export async function getSymbolRef(
  client: GraphClient,
  repoId: string,
  symbolId: string,
): Promise<SymbolRef | undefined> {
  const rows = await client.query<SymbolRef>(
    `MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(f:File)-[:CONTAINS]->(s:Symbol {id: $symbolId})
     RETURN s.id AS symbolId, s.name AS name, s.qualifiedName AS qualifiedName, s.kind AS kind,
            s.signature AS signature, f.path AS path, s.startLine AS startLine, s.endLine AS endLine
     LIMIT 1`,
    { repoId, symbolId },
  );
  return rows[0];
}

type EdgeRow = SymbolRef & { line: number; resolution: Resolution; confidence: number };
type PathRow = SymbolRef & {
  via: string;
  line: number;
  r1: Resolution;
  r2: Resolution;
  c1: number;
  c2: number;
};

async function directNeighbors(
  client: GraphClient,
  repoId: string,
  symbolId: string,
  direction: "callees" | "callers",
  limit: number,
): Promise<CallNeighbor[]> {
  const pattern =
    direction === "callees"
      ? "(s)-[c:POSSIBLY_CALLS]->(t:Symbol)"
      : "(t:Symbol)-[c:POSSIBLY_CALLS]->(s)";
  const rows = await client.query<EdgeRow>(
    `MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(:File)-[:CONTAINS]->(s:Symbol {id: $symbolId})
     MATCH ${pattern}
     MATCH (g:File)-[:CONTAINS]->(t)
     MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(g)
     RETURN ${SYMBOL_RETURN}, c.line AS line, c.resolution AS resolution, c.confidence AS confidence
     ORDER BY c.confidence DESC, qualifiedName ASC
     LIMIT $limit`,
    { repoId, symbolId, limit },
  );
  return rows.map((row) => ({ ...row, hops: 1, via: null }));
}

async function twoHopNeighbors(
  client: GraphClient,
  repoId: string,
  symbolId: string,
  direction: "callees" | "callers",
  limit: number,
): Promise<CallNeighbor[]> {
  const pattern =
    direction === "callees"
      ? "(s)-[c1:POSSIBLY_CALLS]->(m:Symbol)-[c2:POSSIBLY_CALLS]->(t:Symbol)"
      : "(t:Symbol)-[c2:POSSIBLY_CALLS]->(m:Symbol)-[c1:POSSIBLY_CALLS]->(s)";
  const rows = await client.query<PathRow>(
    `MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(:File)-[:CONTAINS]->(s:Symbol {id: $symbolId})
     MATCH ${pattern}
     WHERE t.id <> s.id AND m.id <> s.id
     MATCH (g:File)-[:CONTAINS]->(t)
     MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(g)
     RETURN ${SYMBOL_RETURN}, m.qualifiedName AS via, c2.line AS line,
            c1.resolution AS r1, c2.resolution AS r2, c1.confidence AS c1, c2.confidence AS c2
     ORDER BY qualifiedName ASC
     LIMIT $limit`,
    { repoId, symbolId, limit },
  );
  return rows.map((row) => ({
    symbolId: row.symbolId,
    name: row.name,
    qualifiedName: row.qualifiedName,
    kind: row.kind,
    signature: row.signature,
    path: row.path,
    startLine: row.startLine,
    endLine: row.endLine,
    hops: 2,
    via: row.via,
    line: row.line,
    resolution: row.r1 === "heuristic" || row.r2 === "heuristic" ? "heuristic" : "resolved",
    confidence: Number((row.c1 * row.c2).toFixed(4)),
  }));
}

function rank(neighbors: CallNeighbor[], limit: number): CallNeighbor[] {
  return [...neighbors]
    .sort((a, b) => a.hops - b.hops || b.confidence - a.confidence || a.qualifiedName.localeCompare(b.qualifiedName))
    .slice(0, limit);
}

export async function getSymbolContext(
  client: GraphClient,
  repoId: string,
  symbolId: string,
  options: ContextOptions,
): Promise<SymbolContext | undefined> {
  assertBounds(options);
  const symbol = await getSymbolRef(client, repoId, symbolId);
  if (!symbol) {
    return undefined;
  }

  const imports = await client.query<{ path: string; specifier: string }>(
    `MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(f:File)-[:CONTAINS]->(:Symbol {id: $symbolId})
     MATCH (f)-[i:IMPORTS]->(g:File)
     RETURN DISTINCT g.path AS path, i.specifier AS specifier
     ORDER BY path ASC
     LIMIT $limit`,
    { repoId, symbolId, limit: options.limit },
  );

  const callees = await directNeighbors(client, repoId, symbolId, "callees", options.limit);
  const callers = await directNeighbors(client, repoId, symbolId, "callers", options.limit);
  if (options.depth === 2) {
    callees.push(...(await twoHopNeighbors(client, repoId, symbolId, "callees", options.limit)));
    callers.push(...(await twoHopNeighbors(client, repoId, symbolId, "callers", options.limit)));
  }

  return {
    symbol,
    imports,
    callees: rank(callees, options.limit),
    callers: rank(callers, options.limit),
  };
}
