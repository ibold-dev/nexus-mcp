import { createHash } from "node:crypto";
import path from "node:path";

const SEPARATOR = "\u0000";

function sha256(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join(SEPARATOR), "utf8").digest("hex");
}

export function normalizeRootPath(root: string): string {
  const resolved = path.resolve(root);
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, "") : resolved;
}

export function normalizeRelativePath(relativePath: string): string {
  const posix = relativePath.replace(/\\/g, "/");
  const normalized = path.posix.normalize(posix);
  if (normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }
  return normalized.replace(/^\.\//, "");
}

export function repositoryId(root: string, projectSalt: string): string {
  return sha256(["repository", normalizeRootPath(root), projectSalt]);
}

export function fileId(repoId: string, relativePath: string): string {
  return sha256(["file", repoId, normalizeRelativePath(relativePath)]);
}

export function symbolId(
  fileIdValue: string,
  kind: string,
  qualifiedName: string,
  startOffset: number,
): string {
  if (!Number.isInteger(startOffset) || startOffset < 0) {
    throw new Error(`Invalid start offset: ${startOffset}`);
  }
  return sha256(["symbol", fileIdValue, kind, qualifiedName, String(startOffset)]);
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
