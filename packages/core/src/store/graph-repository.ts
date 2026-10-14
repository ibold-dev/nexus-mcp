import type { GraphClient } from "./graph-client.js";
import type { Resolution, SymbolKind } from "../schema.js";
import { symbolSearchText, toFullTextQuery } from "./search.js";

export interface SymbolSearchHit {
  symbolId: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  path: string;
  startLine: number;
  endLine: number;
  signature: string;
  score: number;
}

export interface SymbolRecord {
  id: string;
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  signature: string;
  doc: string;
  startOffset: number;
  startLine: number;
  endLine: number;
  ordinal: number;
}

export interface ImportRecord {
  toFileId: string;
  specifier: string;
  typeOnly: boolean;
  resolution: Resolution;
  confidence: number;
}

export interface FileState {
  id: string;
  hash: string;
  importsDigest: string | null;
}

export interface RepositoryRecord {
  id: string;
  root: string;
  schemaVersion: number;
  indexedRevision: string | null;
}

export interface FileRecord {
  id: string;
  repoId: string;
  path: string;
  hash: string;
  language: string;
  lineCount: number;
  indexedAt: string;
}

export class GraphRepository {
  constructor(private readonly client: GraphClient) {}

  async ensureIndexes(): Promise<void> {
    await this.client.createRangeIndex("Repository", "id");
    await this.client.createRangeIndex("File", "id");
    await this.client.createRangeIndex("File", "path");
    await this.client.createFullTextIndex("Symbol", ["name", "searchText", "signature", "doc"]);
  }

  async searchSymbols(repoId: string, query: string, limit: number): Promise<SymbolSearchHit[]> {
    const fullText = toFullTextQuery(query);
    if (fullText === undefined) {
      return [];
    }
    return this.client.query<SymbolSearchHit>(
      `CALL db.idx.fulltext.queryNodes('Symbol', $query) YIELD node, score
       MATCH (f:File)-[:CONTAINS]->(node)
       MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(f)
       RETURN node.id AS symbolId,
              node.name AS name,
              node.qualifiedName AS qualifiedName,
              node.kind AS kind,
              f.path AS path,
              node.startLine AS startLine,
              node.endLine AS endLine,
              node.signature AS signature,
              score
       ORDER BY score DESC, qualifiedName ASC
       LIMIT $limit`,
      { repoId, query: fullText, limit },
    );
  }

  async upsertRepository(record: RepositoryRecord): Promise<void> {
    await this.client.query(
      `MERGE (r:Repository {id: $id})
       SET r.root = $root,
           r.schemaVersion = $schemaVersion,
           r.indexedRevision = $indexedRevision`,
      {
        id: record.id,
        root: record.root,
        schemaVersion: record.schemaVersion,
        indexedRevision: record.indexedRevision,
      },
    );
  }

  async upsertFile(record: FileRecord): Promise<void> {
    const rows = await this.client.query<{ id: string }>(
      `MATCH (r:Repository {id: $repoId})
       MERGE (f:File {id: $id})
       SET f.path = $path,
           f.hash = $hash,
           f.language = $language,
           f.lineCount = $lineCount,
           f.indexedAt = $indexedAt
       MERGE (r)-[:HAS_FILE]->(f)
       RETURN f.id AS id`,
      {
        repoId: record.repoId,
        id: record.id,
        path: record.path,
        hash: record.hash,
        language: record.language,
        lineCount: record.lineCount,
        indexedAt: record.indexedAt,
      },
    );
    if (rows.length === 0) {
      throw new Error(`Repository not found for file: ${record.path}`);
    }
  }

  async getFileHash(repoId: string, path: string): Promise<string | undefined> {
    const rows = await this.client.query<{ hash: string }>(
      `MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(f:File {path: $path})
       RETURN f.hash AS hash
       LIMIT 1`,
      { repoId, path },
    );
    return rows[0]?.hash;
  }

  async getFileState(repoId: string, path: string): Promise<FileState | undefined> {
    const rows = await this.client.query<FileState>(
      `MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(f:File {path: $path})
       RETURN f.id AS id, f.hash AS hash, f.importsDigest AS importsDigest
       LIMIT 1`,
      { repoId, path },
    );
    return rows[0];
  }

  async replaceFileSymbols(
    repoId: string,
    file: FileRecord,
    symbols: readonly SymbolRecord[],
  ): Promise<void> {
    const rows = await this.client.query<{ id: string }>(
      `MATCH (r:Repository {id: $repoId})
       MERGE (f:File {id: $fileId})
       SET f.path = $path,
           f.hash = $hash,
           f.language = $language,
           f.lineCount = $lineCount,
           f.indexedAt = $indexedAt,
           f.importsDigest = NULL
       MERGE (r)-[:HAS_FILE]->(f)
       WITH f
       OPTIONAL MATCH (f)-[:CONTAINS]->(old:Symbol)
       WITH f, collect(old) AS olds
       FOREACH (o IN olds | DETACH DELETE o)
       FOREACH (s IN $symbols |
         CREATE (sym:Symbol {
           id: s.id,
           kind: s.kind,
           name: s.name,
           searchText: s.searchText,
           qualifiedName: s.qualifiedName,
           signature: s.signature,
           doc: s.doc,
           startOffset: s.startOffset,
           startLine: s.startLine,
           endLine: s.endLine
         })
         CREATE (f)-[:CONTAINS {ordinal: s.ordinal}]->(sym)
       )
       RETURN f.id AS id`,
      {
        repoId,
        fileId: file.id,
        path: file.path,
        hash: file.hash,
        language: file.language,
        lineCount: file.lineCount,
        indexedAt: file.indexedAt,
        symbols: symbols.map((symbol) => ({
          ...symbol,
          searchText: symbolSearchText(symbol.name),
        })),
      },
    );
    if (rows.length === 0) {
      throw new Error(`Repository not found for file: ${file.path}`);
    }
  }

  async replaceFileImports(
    fileIdValue: string,
    importsDigest: string,
    unresolved: readonly string[],
    imports: readonly ImportRecord[],
  ): Promise<void> {
    await this.client.query(
      `MATCH (f:File {id: $fileId})
       OPTIONAL MATCH (f)-[old:IMPORTS]->(:File)
       WITH f, collect(old) AS olds
       FOREACH (o IN olds | DELETE o)
       SET f.importsDigest = $importsDigest,
           f.unresolvedImports = $unresolved
       WITH f
       UNWIND $imports AS i
       MATCH (t:File {id: i.toFileId})
       CREATE (f)-[:IMPORTS {
         specifier: i.specifier,
         typeOnly: i.typeOnly,
         resolution: i.resolution,
         confidence: i.confidence
       }]->(t)`,
      {
        fileId: fileIdValue,
        importsDigest,
        unresolved: [...unresolved],
        imports: imports.map((entry) => ({ ...entry })),
      },
    );
  }

  async listFilePaths(repoId: string): Promise<string[]> {
    const rows = await this.client.query<{ path: string }>(
      `MATCH (:Repository {id: $repoId})-[:HAS_FILE]->(f:File)
       RETURN f.path AS path
       ORDER BY f.path`,
      { repoId },
    );
    return rows.map((row) => row.path);
  }
}
