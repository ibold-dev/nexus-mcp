import { Project, ts, type SourceFile } from "ts-morph";
import { fileId, normalizeRelativePath, RESOLUTIONS } from "@nexus/core";

export interface SourceInput {
  relativePath: string;
  content: string;
}

export interface ImportEdge {
  fromFileId: string;
  toFileId: string;
  specifier: string;
  typeOnly: boolean;
  resolution: typeof RESOLUTIONS.resolved;
  confidence: number;
}

export interface FileImports {
  fileId: string;
  relativePath: string;
  edges: ImportEdge[];
  unresolved: string[];
}

export const REPOSITORY_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: false,
  noEmit: true,
};

export function createRepositoryProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: REPOSITORY_COMPILER_OPTIONS,
  });
}

export function collectFileImports(
  file: SourceFile,
  repoId: string,
  relativePath: string,
  relativeByAbsolute: ReadonlyMap<string, string>,
): { edges: ImportEdge[]; unresolved: string[] } {
  const fromFileId = fileId(repoId, relativePath);
  const seenEdges = new Set<string>();
  const unresolved = new Set<string>();
  const edges: ImportEdge[] = [];

  const declarations = [...file.getImportDeclarations(), ...file.getExportDeclarations()];
  for (const declaration of declarations) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier === undefined) {
      continue;
    }
    const typeOnly = declaration.isTypeOnly();
    const target = declaration.getModuleSpecifierSourceFile();
    const targetRelative = target ? relativeByAbsolute.get(target.getFilePath()) : undefined;

    if (targetRelative === undefined) {
      unresolved.add(specifier);
      continue;
    }

    const toFileId = fileId(repoId, targetRelative);
    const key = `${toFileId}\u0000${specifier}\u0000${typeOnly}`;
    if (seenEdges.has(key)) {
      continue;
    }
    seenEdges.add(key);
    edges.push({
      fromFileId,
      toFileId,
      specifier,
      typeOnly,
      resolution: RESOLUTIONS.resolved,
      confidence: 1,
    });
  }

  return { edges, unresolved: [...unresolved].sort() };
}

export function extractImports(repoId: string, sources: readonly SourceInput[]): FileImports[] {
  const project = createRepositoryProject();
  const relativeByAbsolute = new Map<string, string>();
  const sourceFiles = sources.map((source) => {
    const relativePath = normalizeRelativePath(source.relativePath);
    const absolutePath = `/${relativePath}`;
    relativeByAbsolute.set(absolutePath, relativePath);
    return { relativePath, file: project.createSourceFile(absolutePath, source.content, { overwrite: true }) };
  });

  return sourceFiles.map(({ relativePath, file }) => {
    const { edges, unresolved } = collectFileImports(file, repoId, relativePath, relativeByAbsolute);
    return { fileId: fileId(repoId, relativePath), relativePath, edges, unresolved };
  });
}
