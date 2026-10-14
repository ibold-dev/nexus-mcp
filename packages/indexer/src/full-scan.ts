import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  contentHash,
  GraphRepository,
  normalizeRootPath,
  repositoryId,
  type CallRecord,
  type FileRecord,
  type FileState,
  type GraphClient,
  type ImportRecord,
} from "@nexus/core";
import { analyzeRepository, type CallEdge, type FileImports } from "@nexus/parser-ts";
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
  callsWritten: number;
  changedPaths: string[];
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

function callsDigest(calls: readonly CallEdge[]): string {
  return contentHash(
    JSON.stringify(
      calls.map((call) => [call.fromSymbolId, call.toSymbolId, call.line, call.resolution, call.confidence]),
    ),
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
  const failures: ScanFailure[] = [];
  for (const relativePath of await collectSourceFiles(root)) {
    if (!SOURCE_EXTENSIONS.has(path.extname(relativePath))) {
      continue;
    }
    try {
      const content = await readFile(path.join(root, relativePath), "utf8");
      sources.push({ relativePath, content, hash: contentHash(content) });
    } catch (error) {
      failures.push({ path: relativePath, error: (error as Error).message });
    }
  }

  const analyses = analyzeRepository(
    repoId,
    sources.map(({ relativePath, content }) => ({ relativePath, content })),
  );
  for (const analysis of analyses) {
    if (analysis.callErrors > 0) {
      failures.push({
        path: analysis.relativePath,
        error: `${analysis.callErrors} call(s) could not be resolved by the type checker`,
      });
    }
  }
  const hashByPath = new Map(sources.map((source) => [source.relativePath, source.hash]));
  const symbolFileId = new Map<string, string>();
  for (const analysis of analyses) {
    for (const symbol of analysis.symbols) {
      symbolFileId.set(symbol.id, analysis.fileId);
    }
  }

  const changed = new Set<string>();
  const changedPaths: string[] = [];
  const stored = new Map<string, FileState | null>();
  let unchanged = 0;
  let filesWritten = 0;

  for (const analysis of analyses) {
    const hash = hashByPath.get(analysis.relativePath) ?? "";
    const state = await repository.getFileState(repoId, analysis.relativePath);
    if (state && state.hash === hash) {
      unchanged += 1;
      stored.set(analysis.fileId, state);
      continue;
    }

    const record: FileRecord = {
      id: analysis.fileId,
      repoId,
      path: analysis.relativePath,
      hash,
      language: languageOf(analysis.relativePath),
      lineCount: analysis.lineCount,
      indexedAt,
    };
    await repository.replaceFileSymbols(repoId, record, analysis.symbols);
    filesWritten += 1;
    changed.add(analysis.fileId);
    changedPaths.push(analysis.relativePath);
    stored.set(analysis.fileId, null);
  }

  let importsWritten = 0;
  for (const analysis of analyses) {
    const digest = importsDigest(analysis.imports);
    const targetChanged = analysis.imports.edges.some((edge) => changed.has(edge.toFileId));
    if (digest === stored.get(analysis.fileId)?.importsDigest && !targetChanged) {
      continue;
    }
    const records: ImportRecord[] = analysis.imports.edges.map((edge) => ({
      toFileId: edge.toFileId,
      specifier: edge.specifier,
      typeOnly: edge.typeOnly,
      resolution: edge.resolution,
      confidence: edge.confidence,
    }));
    await repository.replaceFileImports(analysis.fileId, digest, analysis.imports.unresolved, records);
    importsWritten += 1;
  }

  let callsWritten = 0;
  for (const analysis of analyses) {
    const digest = callsDigest(analysis.calls);
    const targetChanged = analysis.calls.some((call) => {
      const targetFile = symbolFileId.get(call.toSymbolId);
      return targetFile !== undefined && changed.has(targetFile);
    });
    if (digest === stored.get(analysis.fileId)?.callsDigest && !targetChanged) {
      continue;
    }
    const records: CallRecord[] = analysis.calls.map((call) => ({ ...call }));
    await repository.replaceFileCalls(analysis.fileId, digest, records);
    callsWritten += 1;
  }

  return {
    repoId,
    scanned: sources.length,
    unchanged,
    filesWritten,
    importsWritten,
    callsWritten,
    changedPaths,
    failures,
  };
}
