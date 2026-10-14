import { Node, SyntaxKind, type Symbol as TsSymbol, type SourceFile } from "ts-morph";
import { contentHash, fileId, normalizeRelativePath, RESOLUTIONS, type Resolution } from "@nexus/core";
import { collectSymbolDrafts, toExtractedSymbols, type ExtractedSymbol, type SymbolDraft } from "./extract.js";
import {
  collectFileImports,
  createModuleResolver,
  createRepositoryProject,
  type FileImports,
  type SourceInput,
} from "./imports.js";

export interface CallEdge {
  fromSymbolId: string;
  toSymbolId: string;
  line: number;
  resolution: Resolution;
  confidence: number;
}

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

export interface AnalysisUpdate {
  analyses: FileAnalysis[];
  addedOrChanged: string[];
  removed: string[];
  recomputedCalls: string[];
}

export const HEURISTIC_CALL_CONFIDENCE = 0.5;

interface Target {
  toSymbolId: string;
  resolution: Resolution;
  confidence: number;
}

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

function declarationKey(absolutePath: string, start: number): string {
  return `${absolutePath}\u0000${start}`;
}

function resolveCalleeSymbol(callee: Node): TsSymbol | undefined {
  const symbol = callee.getSymbol();
  if (symbol?.isAlias()) {
    return symbol.getAliasedSymbol() ?? symbol;
  }
  return symbol;
}

function isCallable(kind: string): boolean {
  return kind === "function" || kind === "method";
}

/**
 * Keeps one ts-morph project alive across syncs. Each update re-parses only
 * changed files and recomputes call edges only where a change can affect them.
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
      const previous = this.cache.get(relativePath);
      if (previous) {
        this.project.removeSourceFile(previous.file);
      }
      const absolutePath = `/${relativePath}`;
      const file = this.project.createSourceFile(absolutePath, source.content, { overwrite: true });
      const fileIdValue = fileId(this.repoId, relativePath);
      const drafts = collectSymbolDrafts(file);
      const symbols = toExtractedSymbols(fileIdValue, drafts);
      touch(symbols);
      this.cache.set(relativePath, {
        relativePath,
        absolutePath,
        hash: source.hash,
        file,
        fileIdValue,
        drafts,
        symbols,
        imports: { fileId: fileIdValue, relativePath, edges: [], unresolved: [] },
        importsSignature: "",
        calls: [],
        callErrors: 0,
        heuristicNames: new Set(),
      });
    }

    const symbolByDeclaration = new Map<string, string>();
    const callableIdsByName = new Map<string, string[]>();
    const relativeByAbsolute = new Map<string, string>();
    for (const entry of this.cache.values()) {
      relativeByAbsolute.set(entry.absolutePath, entry.relativePath);
      entry.drafts.forEach((draft, index) => {
        const symbol = entry.symbols[index];
        if (!symbol) {
          return;
        }
        symbolByDeclaration.set(declarationKey(entry.absolutePath, draft.node.getStart()), symbol.id);
        if (isCallable(draft.kind)) {
          const bucket = callableIdsByName.get(draft.name) ?? [];
          bucket.push(symbol.id);
          callableIdsByName.set(draft.name, bucket);
        }
      });
    }

    const resolve = createModuleResolver(relativeByAbsolute.keys());
    const importsChanged = new Set<string>();
    for (const entry of this.cache.values()) {
      const imports = collectFileImports(entry.file, this.repoId, entry.relativePath, resolve, relativeByAbsolute);
      const signature = JSON.stringify(imports);
      if (signature !== entry.importsSignature) {
        importsChanged.add(entry.relativePath);
      }
      entry.imports = { fileId: entry.fileIdValue, relativePath: entry.relativePath, ...imports };
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

    for (const relativePath of dirty) {
      const entry = this.cache.get(relativePath);
      if (!entry) {
        continue;
      }
      const result = collectCalls(entry.file, entry.absolutePath, symbolByDeclaration, callableIdsByName);
      entry.calls = result.edges;
      entry.callErrors = result.errors;
      entry.heuristicNames = result.heuristicNames;
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
      recomputedCalls: [...dirty].sort(),
    };
  }
}

export function analyzeRepository(repoId: string, sources: readonly SourceInput[]): FileAnalysis[] {
  return new RepositoryAnalyzer(repoId).update(
    sources.map((source) => ({ ...source, hash: contentHash(source.content) })),
  ).analyses;
}

function enclosingSymbolId(
  call: Node,
  absolutePath: string,
  symbolByDeclaration: ReadonlyMap<string, string>,
): string | undefined {
  let current: Node | undefined = call.getParent();
  while (current && !Node.isSourceFile(current)) {
    const id = symbolByDeclaration.get(declarationKey(absolutePath, current.getStart()));
    if (id !== undefined) {
      return id;
    }
    current = current.getParent();
  }
  return undefined;
}

function resolveTarget(
  callee: Node,
  symbolByDeclaration: ReadonlyMap<string, string>,
  callableIdsByName: ReadonlyMap<string, readonly string[]>,
): Target | undefined {
  const symbol = resolveCalleeSymbol(callee);
  if (symbol) {
    for (const declaration of symbol.getDeclarations()) {
      const id = symbolByDeclaration.get(
        declarationKey(declaration.getSourceFile().getFilePath(), declaration.getStart()),
      );
      if (id !== undefined) {
        return { toSymbolId: id, resolution: RESOLUTIONS.resolved, confidence: 1 };
      }
    }
    return undefined;
  }

  if (!Node.isPropertyAccessExpression(callee)) {
    return undefined;
  }
  const candidates = [...new Set(callableIdsByName.get(callee.getName()) ?? [])];
  const [only] = candidates;
  if (candidates.length !== 1 || only === undefined) {
    return undefined;
  }
  return { toSymbolId: only, resolution: RESOLUTIONS.heuristic, confidence: HEURISTIC_CALL_CONFIDENCE };
}

interface CallCollection {
  edges: CallEdge[];
  errors: number;
  heuristicNames: Set<string>;
}

function collectCalls(
  file: SourceFile,
  absolutePath: string,
  symbolByDeclaration: ReadonlyMap<string, string>,
  callableIdsByName: ReadonlyMap<string, readonly string[]>,
): CallCollection {
  const seen = new Set<string>();
  const edges: CallEdge[] = [];
  const heuristicNames = new Set<string>();
  let errors = 0;

  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const fromSymbolId = enclosingSymbolId(call, absolutePath, symbolByDeclaration);
    if (fromSymbolId === undefined) {
      continue;
    }
    const line = call.getStartLineNumber();
    const callee = call.getExpression();
    let target: Target | undefined;
    try {
      target = resolveTarget(callee, symbolByDeclaration, callableIdsByName);
    } catch {
      errors += 1;
      continue;
    }
    if (target === undefined) {
      continue;
    }
    if (target.resolution === RESOLUTIONS.heuristic && Node.isPropertyAccessExpression(callee)) {
      heuristicNames.add(callee.getName());
    }
    const key = `${fromSymbolId}\u0000${target.toSymbolId}\u0000${line}\u0000${target.resolution}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    edges.push({
      fromSymbolId,
      toSymbolId: target.toSymbolId,
      line,
      resolution: target.resolution,
      confidence: target.confidence,
    });
  }

  return { edges, errors, heuristicNames };
}
