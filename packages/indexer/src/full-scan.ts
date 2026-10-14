import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  contentHash,
  GraphRepository,
  normalizeRootPath,
  repositoryId,
  type FileRecord,
  type GraphClient,
  type ImportRecord,
} from "@nexus/core";
import { extractFile, extractImports, type FileImports } from "@nexus/parser-ts";
import { collectSourceFiles, SOURCE_EXTENSIONS } from "./walk.js";

export const SCHEMA_VERSION = 1;

export interface FullScanOptions {
  client: GraphClient;
  root: string;
  projectSalt: string;
  now?: () => Date;
}

export interface ScanFailure {
  path: string;
  error: string;
}

export interface ScanResult {
  repoId: string;
  scanned: number;
  unchanged: number;
  filesWritten: number;
  importsWritten: number;
  failures: ScanFailure[];
}

interface SourceEntry {
  relativePath: string;
  content: string;
  hash: string;
}

const JAVASCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".jsx", ".mjs", ".cjs"]);

function languageOf(relativePath: string): string {
  return JAVASCRIPT_EXTENSIONS.has(path.extname(relativePath)) ? "javascript" : "typescript";
}

function importsDigest(entry: FileImports): string {
  return contentHash(
    JSON.stringify({
      edges: entry.edges.map((edge) => [
        edge.toFileId,
        edge.specifier,
        edge.typeOnly,
        edge.resolution,
        edge.confidence,
      ]),
      unresolved: entry.unresolved,
    }),
  );
}

export async function fullScan(options: FullScanOptions): Promise<ScanResult> {
  const root = normalizeRootPath(options.root);
  const repoId = repositoryId(root, options.projectSalt);
  const repository = new GraphRepository(options.client);
  const indexedAt = (options.now ?? (() => new Date()))().toISOString();

  await repository.ensureIndexes();
  await repository.upsertRepository({
    id: repoId,
    root,
    schemaVersion: SCHEMA_VERSION,
    indexedRevision: null,
  });

  const sources: SourceEntry[] = [];
  for (const relativePath of await collectSourceFiles(root)) {
    if (!SOURCE_EXTENSIONS.has(path.extname(relativePath))) {
      continue;
    }
    const content = await readFile(path.join(root, relativePath), "utf8");
    sources.push({ relativePath, content, hash: contentHash(content) });
  }

  const failures: ScanFailure[] = [];
  const failed = new Set<string>();
  const changed = new Set<string>();
  const storedDigest = new Map<string, string | null>();
  const fileIds = new Map<string, string>();
  let unchanged = 0;
  let filesWritten = 0;

  for (const source of sources) {
    const state = await repository.getFileState(repoId, source.relativePath);
    if (state && state.hash === source.hash) {
      unchanged += 1;
      storedDigest.set(source.relativePath, state.importsDigest);
      fileIds.set(source.relativePath, state.id);
      continue;
    }

    let extracted;
    try {
      extracted = extractFile({ repoId, relativePath: source.relativePath, content: source.content });
    } catch (error) {
      failures.push({ path: source.relativePath, error: (error as Error).message });
      failed.add(source.relativePath);
      continue;
    }

    const record: FileRecord = {
      id: extracted.fileId,
      repoId,
      path: extracted.relativePath,
      hash: source.hash,
      language: languageOf(source.relativePath),
      lineCount: extracted.lineCount,
      indexedAt,
    };
    await repository.replaceFileSymbols(repoId, record, extracted.symbols);
    filesWritten += 1;
    changed.add(source.relativePath);
    storedDigest.set(source.relativePath, null);
    fileIds.set(source.relativePath, extracted.fileId);
  }

  const imports = extractImports(
    repoId,
    sources.map(({ relativePath, content }) => ({ relativePath, content })),
  );
  const changedFileIds = new Set([...changed].map((relativePath) => fileIds.get(relativePath)));

  let importsWritten = 0;
  for (const entry of imports) {
    if (failed.has(entry.relativePath)) {
      continue;
    }
    const digest = importsDigest(entry);
    const targetChanged = entry.edges.some((edge) => changedFileIds.has(edge.toFileId));
    if (digest === storedDigest.get(entry.relativePath) && !targetChanged) {
      continue;
    }

    const records: ImportRecord[] = entry.edges.map((edge) => ({
      toFileId: edge.toFileId,
      specifier: edge.specifier,
      typeOnly: edge.typeOnly,
      resolution: edge.resolution,
      confidence: edge.confidence,
    }));
    await repository.replaceFileImports(entry.fileId, digest, entry.unresolved, records);
    importsWritten += 1;
  }

  return {
    repoId,
    scanned: sources.length,
    unchanged,
    filesWritten,
    importsWritten,
    failures,
  };
}
