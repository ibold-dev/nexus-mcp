import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const DEFAULT_IGNORED_DIRECTORIES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
  "out",
  ".next",
  ".turbo",
];

const SECRET_PATTERNS = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*"];

export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  ...DEFAULT_IGNORED_DIRECTORIES.map((dir) => `${dir}/`),
  ...SECRET_PATTERNS,
];

export function isSecretFileName(fileName: string): boolean {
  return ignore().add(SECRET_PATTERNS).ignores(fileName);
}

async function loadIgnoreFile(root: string, name: string): Promise<string[]> {
  try {
    const text = await readFile(path.join(root, name), "utf8");
    return text.split(/\r?\n/);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function createIgnoreMatcher(root: string): Promise<Ignore> {
  const matcher = ignore().add([...DEFAULT_IGNORE_PATTERNS]);
  matcher.add(await loadIgnoreFile(root, ".gitignore"));
  matcher.add(await loadIgnoreFile(root, ".nexusignore"));
  return matcher;
}

export async function collectSourceFiles(root: string): Promise<string[]> {
  const matcher = await createIgnoreMatcher(root);
  const results: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!matcher.ignores(`${relative}/`)) {
          await walk(relative);
        }
        continue;
      }
      if (!entry.isFile() || matcher.ignores(relative) || isSecretFileName(entry.name)) {
        continue;
      }
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(relative);
      }
    }
  }

  await walk("");
  return results.sort();
}
