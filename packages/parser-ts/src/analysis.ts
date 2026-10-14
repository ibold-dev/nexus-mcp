import { Node, SyntaxKind, type Symbol as TsSymbol, type SourceFile } from "ts-morph";
import { fileId, normalizeRelativePath, RESOLUTIONS, type Resolution } from "@nexus/core";
import { collectSymbolDrafts, toExtractedSymbols, type ExtractedSymbol, type SymbolDraft } from "./extract.js";
import { collectFileImports, createRepositoryProject, type FileImports, type SourceInput } from "./imports.js";

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

export const HEURISTIC_CALL_CONFIDENCE = 0.5;

interface Target {
  toSymbolId: string;
  resolution: Resolution;
  confidence: number;
}

interface ParsedFile {
  relativePath: string;
  absolutePath: string;
  file: SourceFile;
  fileIdValue: string;
  drafts: SymbolDraft[];
  symbols: ExtractedSymbol[];
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

export function analyzeRepository(repoId: string, sources: readonly SourceInput[]): FileAnalysis[] {
  const project = createRepositoryProject();
  const relativeByAbsolute = new Map<string, string>();

  const parsed: ParsedFile[] = sources.map((source) => {
    const relativePath = normalizeRelativePath(source.relativePath);
    const absolutePath = `/${relativePath}`;
    relativeByAbsolute.set(absolutePath, relativePath);
    const file = project.createSourceFile(absolutePath, source.content, { overwrite: true });
    const fileIdValue = fileId(repoId, relativePath);
    const drafts = collectSymbolDrafts(file);
    return {
      relativePath,
      absolutePath,
      file,
      fileIdValue,
      drafts,
      symbols: toExtractedSymbols(fileIdValue, drafts),
    };
  });

  const symbolByDeclaration = new Map<string, string>();
  const callableIdsByName = new Map<string, string[]>();
  for (const entry of parsed) {
    entry.drafts.forEach((draft, index) => {
      const symbol = entry.symbols[index];
      if (!symbol) {
        return;
      }
      symbolByDeclaration.set(declarationKey(entry.absolutePath, draft.node.getStart()), symbol.id);
      if (draft.kind === "function" || draft.kind === "method") {
        const bucket = callableIdsByName.get(draft.name) ?? [];
        bucket.push(symbol.id);
        callableIdsByName.set(draft.name, bucket);
      }
    });
  }

  return parsed.map((entry) => {
    const imports = collectFileImports(entry.file, repoId, entry.relativePath, relativeByAbsolute);
    const calls = collectCalls(entry.file, entry.absolutePath, symbolByDeclaration, callableIdsByName);
    return {
      fileId: entry.fileIdValue,
      relativePath: entry.relativePath,
      lineCount: entry.file.getEndLineNumber(),
      symbols: entry.symbols,
      imports: { fileId: entry.fileIdValue, relativePath: entry.relativePath, ...imports },
      calls: calls.edges,
      callErrors: calls.errors,
    };
  });
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
}

function collectCalls(
  file: SourceFile,
  absolutePath: string,
  symbolByDeclaration: ReadonlyMap<string, string>,
  callableIdsByName: ReadonlyMap<string, readonly string[]>,
): CallCollection {
  const seen = new Set<string>();
  const edges: CallEdge[] = [];
  let errors = 0;

  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const fromSymbolId = enclosingSymbolId(call, absolutePath, symbolByDeclaration);
    if (fromSymbolId === undefined) {
      continue;
    }
    const line = call.getStartLineNumber();
    let target: Target | undefined;
    try {
      target = resolveTarget(call.getExpression(), symbolByDeclaration, callableIdsByName);
    } catch {
      errors += 1;
      continue;
    }
    if (target === undefined) {
      continue;
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

  return { edges, errors };
}
