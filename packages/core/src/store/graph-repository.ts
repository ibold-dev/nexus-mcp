import type { GraphClient } from "./graph-client.js";

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
