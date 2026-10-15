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
  occurrence: number,
): string {
  if (!Number.isInteger(occurrence) || occurrence < 0) {
    throw new Error(`Invalid occurrence: ${occurrence}`);
  }
  return sha256(["symbol", fileIdValue, kind, qualifiedName, String(occurrence)]);
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** One session per agent process start, per user and repository. */
export function sessionId(repoId: string, userId: string, agentId: string, startedAt: string): string {
  return sha256(["session", repoId, userId, agentId, startedAt]);
}

/** Turn ids are readable because they double as the session's activity log. */
export function turnId(sessionIdValue: string, ordinal: number): string {
  return `${sessionIdValue}#${ordinal}`;
}

/** Facts are keyed by their text, so remembering the same fact again updates it. */
export function factId(repoId: string, userId: string, text: string): string {
  return sha256(["fact", repoId, userId, text.trim()]);
}

/** Procedures are keyed by name, so a better version of a procedure replaces the old one. */
export function procedureId(repoId: string, userId: string, name: string): string {
  return sha256(["procedure", repoId, userId, name.trim().toLowerCase()]);
}

/** One handoff per task per session; writing it again revises it. */
export function handoffId(sessionIdValue: string, taskRef: string | undefined): string {
  return sha256(["handoff", sessionIdValue, taskRef?.trim() || "default"]);
}
