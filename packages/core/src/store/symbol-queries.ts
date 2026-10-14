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
