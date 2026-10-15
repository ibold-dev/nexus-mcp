import { Node, SyntaxKind, type Symbol as TsSymbol, type SourceFile } from "ts-morph";
import { RESOLUTIONS, type Resolution } from "@nexus/core";

export interface CallEdge {
  fromSymbolId: string;
  toSymbolId: string;
  line: number;
  resolution: Resolution;
  confidence: number;
}

export const HEURISTIC_CALL_CONFIDENCE = 0.5;

interface Target {
  toSymbolId: string;
  resolution: Resolution;
  confidence: number;
}

export interface CallCollection {
  edges: CallEdge[];
  errors: number;
  heuristicNames: Set<string>;
}

/**
 * The identity of a declaration by file and start offset. Shared with symbol
 * indexing, which keys its declaration map the same way.
 */
export function declarationKey(absolutePath: string, start: number): string {
  return `${absolutePath}\u0000${start}`;
}

export function isCallable(kind: string): boolean {
  return kind === "function" || kind === "method";
}

function resolveCalleeSymbol(callee: Node): TsSymbol | undefined {
  const symbol = callee.getSymbol();
  if (symbol?.isAlias()) {
    return symbol.getAliasedSymbol() ?? symbol;
  }
  return symbol;
}

/**
 * The symbol a call is attributed to: the nearest enclosing function when there
 * is one, otherwise the nearest enclosing symbol of any kind.
 *
 * The preference matters for the question the graph exists to answer. In
 * `function run() { const total = add(1, 2); }` the nearest symbol to the call
 * is the local `total`, and reporting that as the caller of `add` names a
 * variable instead of the function a reader would have to change. The nearest
 * *callable* ancestor is walked for first, and a local is used only when there
 * is no enclosing function to name.
 */
function enclosingSymbolId(
  call: Node,
  absolutePath: string,
  symbolByDeclaration: ReadonlyMap<string, string>,
  callableDeclarations: ReadonlySet<string>,
): string | undefined {
  let nearest: string | undefined;
  let current: Node | undefined = call.getParent();
  while (current && !Node.isSourceFile(current)) {
    const key = declarationKey(absolutePath, current.getStart());
    const id = symbolByDeclaration.get(key);
    if (id !== undefined) {
      if (callableDeclarations.has(key)) {
        return id;
      }
      nearest ??= id;
    }
    current = current.getParent();
  }
  return nearest;
}

/**
 * Prefers a type-checker resolved target. Falls back to a heuristic edge only
 * when the method name identifies exactly one symbol in the repository.
 */
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

/**
 * Extracts call edges from one file. A target the type checker cannot resolve
 * without throwing is counted in `errors`; the rest of the file is still read.
 */
export function collectCalls(
  file: SourceFile,
  absolutePath: string,
  symbolByDeclaration: ReadonlyMap<string, string>,
  callableIdsByName: ReadonlyMap<string, readonly string[]>,
  callableDeclarations: ReadonlySet<string> = new Set(),
): CallCollection {
  const seen = new Set<string>();
  const edges: CallEdge[] = [];
  const heuristicNames = new Set<string>();
  let errors = 0;

  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const fromSymbolId = enclosingSymbolId(call, absolutePath, symbolByDeclaration, callableDeclarations);
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
