import type { SourceFile } from "ts-morph";
import { contentHash, fileId, normalizeRelativePath } from "@nexus/core";
import { collectCalls, declarationKey, isCallable, type CallEdge } from "./calls.js";
import { collectSymbolDrafts, toExtractedSymbols, type ExtractedSymbol, type SymbolDraft } from "./extract.js";
import {
  collectFileImports,
  createModuleResolver,
  createRepositoryProject,
  type FileImports,
  type SourceInput,
} from "./imports.js";

export interface FileAnalysis {
  fileId: string;
  relativePath: string;
  lineCount: number;
  symbols: ExtractedSymbol[];
  imports: FileImports;
  calls: CallEdge[];
  callErrors: number;
}

export interface SourceUpdate {
  relativePath: string;
  content: string;
  hash: string;
}

/** A file whose analysis threw, named with the stage that failed. */
export interface AnalysisFailure {
  path: string;
  error: string;
}

export interface AnalysisUpdate {
  analyses: FileAnalysis[];
  addedOrChanged: string[];
  removed: string[];
  recomputedCalls: string[];
  failures: AnalysisFailure[];
}

type Stage = "symbols" | "imports" | "calls";

interface CachedFile {
  relativePath: string;
  absolutePath: string;
  hash: string;
  file: SourceFile;
  fileIdValue: string;
  drafts: SymbolDraft[];
  symbols: ExtractedSymbol[];
  imports: FileImports;
  importsSignature: string;
  calls: CallEdge[];
  callErrors: number;
  heuristicNames: Set<string>;
}

/**
 * Keeps one ts-morph project alive across syncs. Each update re-parses only
 * changed files and recomputes call edges only where a change can affect them.
 *
 * Analysis is isolated per file. If any stage throws, the failure is reported
 * and the file is left out of `analyses` entirely, so nothing half-parsed is
 * written and the next sync retries it from scratch.
 */
export class RepositoryAnalyzer {
  private readonly project = createRepositoryProject();
  private readonly cache = new Map<string, CachedFile>();

  constructor(private readonly repoId: string) {}

  update(sources: readonly SourceUpdate[]): AnalysisUpdate {
    const incoming = new Map<string, SourceUpdate>();
    for (const source of sources) {
      const relativePath = normalizeRelativePath(source.relativePath);
      incoming.set(relativePath, { ...source, relativePath });
    }

    const addedOrChanged = [...incoming.values()]
      .filter((source) => this.cache.get(source.relativePath)?.hash !== source.hash)
      .map((source) => source.relativePath)
      .sort();
    const removed = [...this.cache.keys()].filter((relativePath) => !incoming.has(relativePath)).sort();

    const failures = new Map<string, string>();
    const failed = new Set<string>();
    const fail = (relativePath: string, stage: Stage, error: unknown): void => {
      failed.add(relativePath);
      if (failures.has(relativePath)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      failures.set(relativePath, `${stage}: ${message}`);
    };

    const touchedSymbolIds = new Set<string>();
    const touchedNames = new Set<string>();
    const touch = (symbols: readonly ExtractedSymbol[]): void => {
      for (const symbol of symbols) {
        touchedSymbolIds.add(symbol.id);
        if (isCallable(symbol.kind)) {
          touchedNames.add(symbol.name);
        }
      }
    };

    for (const relativePath of [...addedOrChanged, ...removed]) {
      const previous = this.cache.get(relativePath);
      if (previous) {
        touch(previous.symbols);
      }
    }

    for (const relativePath of removed) {
      const previous = this.cache.get(relativePath);
      if (previous) {
        this.project.removeSourceFile(previous.file);
        this.cache.delete(relativePath);
      }
    }

    for (const relativePath of addedOrChanged) {
      const source = incoming.get(relativePath);
      if (!source) {
        continue;
      }
      const fileIdValue = fileId(this.repoId, relativePath);
      const absolutePath = `/${relativePath}`;
      let entry: CachedFile;
      try {
        const file = this.project.createSourceFile(absolutePath, source.content, { overwrite: true });
        const drafts = collectSymbolDrafts(file);
        entry = {
          relativePath,
          absolutePath,
          hash: source.hash,
          file,
          fileIdValue,
          drafts,
          symbols: toExtractedSymbols(fileIdValue, drafts),
          imports: { fileId: fileIdValue, relativePath, edges: [], unresolved: [] },
          importsSignature: "",
          calls: [],
          callErrors: 0,
          heuristicNames: new Set(),
        };
      } catch (error) {
        fail(relativePath, "symbols", error);
        continue;
      }
      touch(entry.symbols);
      this.cache.set(relativePath, entry);
    }

    const symbolByDeclaration = new Map<string, string>();
    const callableDeclarations = new Set<string>();
    const callableIdsByName = new Map<string, string[]>();
    const relativeByAbsolute = new Map<string, string>();
    for (const entry of this.cache.values()) {
      relativeByAbsolute.set(entry.absolutePath, entry.relativePath);
      entry.drafts.forEach((draft, index) => {
        const symbol = entry.symbols[index];
        if (!symbol) {
          return;
        }
        const key = declarationKey(entry.absolutePath, draft.node.getStart());
        symbolByDeclaration.set(key, symbol.id);
        if (isCallable(draft.kind)) {
          callableDeclarations.add(key);
          const bucket = callableIdsByName.get(draft.name) ?? [];
          bucket.push(symbol.id);
          callableIdsByName.set(draft.name, bucket);
        }
      });
    }

    const resolve = createModuleResolver(relativeByAbsolute.keys());
    const importsChanged = new Set<string>();
    for (const entry of this.cache.values()) {
      let imports: FileImports;
      try {
        imports = {
          fileId: entry.fileIdValue,
          relativePath: entry.relativePath,
          ...collectFileImports(entry.file, this.repoId, entry.relativePath, resolve, relativeByAbsolute),
        };
      } catch (error) {
        fail(entry.relativePath, "imports", error);
        continue;
      }
      const signature = JSON.stringify(imports);
      if (signature !== entry.importsSignature) {
        importsChanged.add(entry.relativePath);
      }
      entry.imports = imports;
      entry.importsSignature = signature;
    }

    const dirty = new Set<string>([...addedOrChanged, ...importsChanged]);
    for (const entry of this.cache.values()) {
      if (dirty.has(entry.relativePath)) {
        continue;
      }
      const callsTouched = entry.calls.some((call) => touchedSymbolIds.has(call.toSymbolId));
      const namesTouched = [...entry.heuristicNames].some((name) => touchedNames.has(name));
      if (callsTouched || namesTouched) {
        dirty.add(entry.relativePath);
      }
    }

    const recomputed = new Set<string>();
    for (const relativePath of dirty) {
      const entry = this.cache.get(relativePath);
      if (!entry || failed.has(relativePath)) {
        continue;
      }
      try {
        const result = collectCalls(
          entry.file,
          entry.absolutePath,
          symbolByDeclaration,
          callableIdsByName,
          callableDeclarations,
        );
        entry.calls = result.edges;
        entry.callErrors = result.errors;
        entry.heuristicNames = result.heuristicNames;
        recomputed.add(relativePath);
      } catch (error) {
        fail(relativePath, "calls", error);
      }
    }

    // A file that failed any stage is dropped, so the next update re-analyzes
    // it from scratch rather than trusting a half-built entry.
    for (const relativePath of failed) {
      this.cache.delete(relativePath);
    }

    const analyses: FileAnalysis[] = [...this.cache.values()]
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .map((entry) => ({
        fileId: entry.fileIdValue,
        relativePath: entry.relativePath,
        lineCount: entry.file.getEndLineNumber(),
        symbols: entry.symbols,
        imports: entry.imports,
        calls: entry.calls,
        callErrors: entry.callErrors,
      }));

    return {
      analyses,
      addedOrChanged,
      removed,
      recomputedCalls: [...recomputed].sort(),
      failures: [...failures]
        .map(([path, error]) => ({ path, error }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  }
}

export function analyzeRepository(repoId: string, sources: readonly SourceInput[]): FileAnalysis[] {
  return new RepositoryAnalyzer(repoId).update(
    sources.map((source) => ({ ...source, hash: contentHash(source.content) })),
  ).analyses;
}
