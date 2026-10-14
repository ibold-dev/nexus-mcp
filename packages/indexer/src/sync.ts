import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  contentHash,
  GraphRepository,
  normalizeRootPath,
  repositoryId,
  type CallRecord,
  type FileRecord,
  type GraphClient,
  type ImportRecord,
} from "@nexus/core";
import { RepositoryAnalyzer, type CallEdge, type FileAnalysis, type FileImports, type SourceUpdate } from "@nexus/parser-ts";
import { withRepositoryLock } from "./lock.js";
import { collectSourceFiles, SOURCE_EXTENSIONS } from "./walk.js";

export const SCHEMA_VERSION = 1;

export interface SyncOptions {
  client: GraphClient;
  root: string;
  projectSalt: string;
  analyzer?: RepositoryAnalyzer;
  now?: () => Date;
}

export interface ScanFailure {
  path: string;
  error: string;
}

export interface SyncResult {
  repoId: string;
  scanned: number;
  unchanged: number;
  filesWritten: number;
  removedPaths: string[];
  importsWritten: number;
  callsWritten: number;
  recomputedCalls: number;
  changedPaths: string[];
  failures: ScanFailure[];
}

const JAVASCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".jsx", ".mjs", ".cjs"]);

function languageOf(relativePath: string): string {
  return JAVASCRIPT_EXTENSIONS.has(path.extname(relativePath)) ? "javascript" : "typescript";
}

function importsDigest(entry: FileImports): string {
  return contentHash(
    JSON.stringify({
      edges: entry.edges.map((edge) => [edge.toFileId, edge.specifier, edge.typeOnly, edge.resolution, edge.confidence]),
      unresolved: entry.unresolved,
    }),
  );
}

function callsDigest(calls: readonly CallEdge[]): string {
  return contentHash(
    JSON.stringify(calls.map((call) => [call.fromSymbolId, call.toSymbolId, call.line, call.resolution, call.confidence])),
  );
}

async function readSources(root: string): Promise<{ sources: SourceUpdate[]; failures: ScanFailure[] }> {
  const sources: SourceUpdate[] = [];
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
  return { sources, failures };
}

/**
 * Brings the graph in line with the repository on disk.
 *
 * Pass a long-lived `analyzer` (for example from a running service) to make
 * repeated syncs incremental. Without one, the first sync analyzes the whole
 * repository. A sync with no changes against the graph returns without
 * analyzing anything.
 */
export async function syncRepository(options: SyncOptions): Promise<SyncResult> {
  const root = normalizeRootPath(options.root);
  const repoId = repositoryId(root, options.projectSalt);
  return withRepositoryLock(root, () => runSync(options, root, repoId));
}

async function runSync(options: SyncOptions, root: string, repoId: string): Promise<SyncResult> {
  const repository = new GraphRepository(options.client);
  const indexedAt = (options.now ?? (() => new Date()))().toISOString();

  await repository.ensureIndexes();
  await repository.upsertRepository({ id: repoId, root, schemaVersion: SCHEMA_VERSION, indexedRevision: null });

  const { sources, failures } = await readSources(root);
  const stored = await repository.listFileStates(repoId);
  const onDisk = new Set(sources.map((source) => source.relativePath));

  const changedOnDisk = new Set(
    sources
      .filter((source) => stored.get(source.relativePath)?.hash !== source.hash)
      .map((source) => source.relativePath),
  );
  const removedPaths = [...stored.keys()].filter((relativePath) => !onDisk.has(relativePath)).sort();

  if (changedOnDisk.size === 0 && removedPaths.length === 0) {
    return {
      repoId,
      scanned: sources.length,
      unchanged: sources.length,
      filesWritten: 0,
      removedPaths: [],
      importsWritten: 0,
      callsWritten: 0,
      recomputedCalls: 0,
      changedPaths: [],
      failures,
    };
  }

  for (const relativePath of removedPaths) {
    await repository.removeFile(repoId, relativePath);
  }

  const analyzer = options.analyzer ?? new RepositoryAnalyzer(repoId);
  const update = analyzer.update(sources);
  const analyses: FileAnalysis[] = update.analyses;

  const hashByPath = new Map(sources.map((source) => [source.relativePath, source.hash]));
  const changedFileIds = new Set<string>();
  for (const analysis of analyses) {
    if (!changedOnDisk.has(analysis.relativePath)) {
      continue;
    }
    changedFileIds.add(analysis.fileId);
    const record: FileRecord = {
      id: analysis.fileId,
      repoId,
      path: analysis.relativePath,
      hash: hashByPath.get(analysis.relativePath) ?? "",
      language: languageOf(analysis.relativePath),
      lineCount: analysis.lineCount,
      indexedAt,
    };
    await repository.replaceFileSymbols(repoId, record, analysis.symbols);
  }

  const symbolFileId = new Map<string, string>();
  for (const analysis of analyses) {
    for (const symbol of analysis.symbols) {
      symbolFileId.set(symbol.id, analysis.fileId);
    }
  }

  const storedDigest = (analysis: FileAnalysis, field: "importsDigest" | "callsDigest"): string | null | undefined =>
    changedFileIds.has(analysis.fileId) ? null : stored.get(analysis.relativePath)?.[field];

  let importsWritten = 0;
  for (const analysis of analyses) {
    const digest = importsDigest(analysis.imports);
    const targetChanged = analysis.imports.edges.some((edge) => changedFileIds.has(edge.toFileId));
    if (digest === storedDigest(analysis, "importsDigest") && !targetChanged) {
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
      return targetFile !== undefined && changedFileIds.has(targetFile);
    });
    if (digest === storedDigest(analysis, "callsDigest") && !targetChanged) {
      continue;
    }
    const records: CallRecord[] = analysis.calls.map((call) => ({ ...call }));
    await repository.replaceFileCalls(analysis.fileId, digest, records);
    callsWritten += 1;
  }

  for (const analysis of analyses) {
    if (analysis.callErrors > 0) {
      failures.push({
        path: analysis.relativePath,
        error: `${analysis.callErrors} call(s) could not be resolved by the type checker`,
      });
    }
  }

  return {
    repoId,
    scanned: sources.length,
    unchanged: sources.length - changedOnDisk.size,
    filesWritten: changedFileIds.size,
    removedPaths,
    importsWritten,
    callsWritten,
    recomputedCalls: update.recomputedCalls.length,
    changedPaths: [...changedOnDisk].sort(),
    failures,
  };
}
