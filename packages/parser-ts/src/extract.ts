import { Node, Project, type SourceFile } from "ts-morph";
import { fileId, normalizeRelativePath, symbolId, type SymbolKind } from "@nexus/core";

export interface ExtractedSymbol {
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

export interface ContainsEdge {
  fileId: string;
  symbolId: string;
  ordinal: number;
}

export interface ExtractedFile {
  fileId: string;
  relativePath: string;
  lineCount: number;
  symbols: ExtractedSymbol[];
  contains: ContainsEdge[];
}

export interface ExtractInput {
  repoId: string;
  relativePath: string;
  content: string;
}

export interface SymbolDraft {
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  signature: string;
  doc: string;
  startOffset: number;
  startLine: number;
  endLine: number;
  occurrence: number;
  node: Node;
}

const MAX_SIGNATURE_LENGTH = 200;

const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });

interface Declaration {
  kind: SymbolKind;
  name: string;
  docSource: Node | undefined;
}

function describe(node: Node): Declaration | undefined {
  if (Node.isFunctionDeclaration(node)) {
    const name = node.getName();
    return name ? { kind: "function", name, docSource: node } : undefined;
  }
  if (Node.isClassDeclaration(node)) {
    const name = node.getName();
    return name ? { kind: "class", name, docSource: node } : undefined;
  }
  if (Node.isMethodDeclaration(node)) {
    return { kind: "method", name: node.getName(), docSource: node };
  }
  if (Node.isInterfaceDeclaration(node)) {
    return { kind: "interface", name: node.getName(), docSource: node };
  }
  if (Node.isTypeAliasDeclaration(node)) {
    return { kind: "typeAlias", name: node.getName(), docSource: node };
  }
  if (Node.isEnumDeclaration(node)) {
    return { kind: "enum", name: node.getName(), docSource: node };
  }
  if (Node.isModuleDeclaration(node)) {
    return { kind: "module", name: node.getName(), docSource: node };
  }
  if (Node.isVariableDeclaration(node)) {
    const nameNode = node.getNameNode();
    if (!Node.isIdentifier(nameNode)) {
      return undefined;
    }
    const initializer = node.getInitializer();
    const isFunctionValue =
      initializer !== undefined &&
      (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer));
    return {
      kind: isFunctionValue ? "function" : "variable",
      name: nameNode.getText(),
      docSource: node.getVariableStatement() ?? node,
    };
  }
  return undefined;
}

function signatureOf(node: Node): string {
  const text = node.getText();
  const cut = text.search(/\{|=>/);
  const head = cut > 0 ? text.slice(0, cut) : text;
  return head.replace(/\s+/g, " ").trim().slice(0, MAX_SIGNATURE_LENGTH);
}

function docOf(node: Node | undefined): string {
  if (!node || !Node.isJSDocable(node)) {
    return "";
  }
  return node
    .getJsDocs()
    .map((doc) => doc.getDescription().trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function visit(node: Node, scope: readonly string[], out: SymbolDraft[]): void {
  const declaration = describe(node);
  if (!declaration) {
    node.forEachChild((child) => visit(child, scope, out));
    return;
  }

  const childScope = [...scope, declaration.name];
  const qualifiedName = childScope.join(".");
  const occurrence = out.filter((draft) => draft.kind === declaration.kind && draft.qualifiedName === qualifiedName).length;
  out.push({
    kind: declaration.kind,
    name: declaration.name,
    qualifiedName,
    signature: signatureOf(node),
    doc: docOf(declaration.docSource),
    startOffset: node.getStart(),
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
    occurrence,
    node,
  });
  node.forEachChild((child) => visit(child, childScope, out));
}

export function collectSymbolDrafts(sourceFile: SourceFile): SymbolDraft[] {
  const drafts: SymbolDraft[] = [];
  sourceFile.forEachChild((child) => visit(child, [], drafts));
  return drafts;
}

export function toExtractedSymbols(file: string, drafts: readonly SymbolDraft[]): ExtractedSymbol[] {
  return drafts.map((draft, ordinal) => ({
    id: symbolId(file, draft.kind, draft.qualifiedName, draft.occurrence),
    kind: draft.kind,
    name: draft.name,
    qualifiedName: draft.qualifiedName,
    signature: draft.signature,
    doc: draft.doc,
    startOffset: draft.startOffset,
    startLine: draft.startLine,
    endLine: draft.endLine,
    ordinal,
  }));
}

export function extractFile(input: ExtractInput): ExtractedFile {
  const relativePath = normalizeRelativePath(input.relativePath);
  const sourceFile = project.createSourceFile(`/${relativePath}`, input.content, {
    overwrite: true,
  });

  try {
    const file = fileId(input.repoId, relativePath);
    const symbols = toExtractedSymbols(file, collectSymbolDrafts(sourceFile));

    return {
      fileId: file,
      relativePath,
      lineCount: sourceFile.getEndLineNumber(),
      symbols,
      contains: symbols.map((symbol) => ({
        fileId: file,
        symbolId: symbol.id,
        ordinal: symbol.ordinal,
      })),
    };
  } finally {
    project.removeSourceFile(sourceFile);
  }
}
