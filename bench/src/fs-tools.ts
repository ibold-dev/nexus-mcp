import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { jsonSchema, tool, type Tool } from "ai";

/**
 * The tools an agent has when it has no context layer: list a directory, search
 * the text, and read files. This is the honest baseline — it is how a coding
 * agent finds callers without a graph, and it is what the benchmark measures
 * against.
 */

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".nexus", "out", "vendor"]);
const MAX_FILE_CHARS = 20_000;

export interface FsToolStats {
  /** Files whose contents were read. */
  filesOpened: number;
  /** Bytes of file contents handed to the model. */
  bytesRead: number;
}

export function createFsToolStats(): FsToolStats {
  return { filesOpened: 0, bytesRead: 0 };
}

export function fsTools(root: string, stats: FsToolStats): Record<string, Tool> {
  const absoluteRoot = path.resolve(root);

  const resolve = (relative: string): string => {
    const absolute = path.resolve(absoluteRoot, relative);
    if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
      throw new Error(`"${relative}" is outside the repository root.`);
    }
    return absolute;
  };

  return {
    list_dir: tool({
      description: "List the entries of a directory, relative to the repository root.",
      inputSchema: jsonSchema<{ path?: string }>({
        type: "object",
        properties: { path: { type: "string", description: "Directory, relative to the root. Defaults to the root." } },
        additionalProperties: false,
      }),
      execute: async ({ path: relative }) => {
        const entries = await readdir(resolve(relative ?? "."), { withFileTypes: true });
        return entries
          .filter((entry) => !SKIP_DIRECTORIES.has(entry.name))
          .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
          .sort();
      },
    }),

    search_text: tool({
      description:
        "Search every source file for a case-insensitive regular expression. Returns file paths with matching line numbers, but not the file contents.",
      inputSchema: jsonSchema<{ pattern: string }>({
        type: "object",
        properties: { pattern: { type: "string", description: "A JavaScript regular expression." } },
        required: ["pattern"],
        additionalProperties: false,
      }),
      execute: async ({ pattern }) => {
        let matcher: RegExp;
        try {
          matcher = new RegExp(pattern, "i");
        } catch {
          return { ok: false, error: `"${pattern}" is not a valid regular expression.` };
        }
        const hits: { path: string; line: number; text: string }[] = [];
        const files = await walk(absoluteRoot);
        for (const relative of files) {
          const content = await readFile(path.join(absoluteRoot, relative), "utf8");
          const lines = content.split("\n");
          for (const [index, line] of lines.entries()) {
            if (matcher.test(line)) {
              hits.push({ path: relative, line: index + 1, text: line.trim().slice(0, 200) });
            }
          }
        }
        return { matches: hits.length, files: [...new Set(hits.map((hit) => hit.path))], hits };
      },
    }),

    read_file: tool({
      description: "Read a file's contents, relative to the repository root.",
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: { path: { type: "string", description: "File path relative to the repository root." } },
        required: ["path"],
        additionalProperties: false,
      }),
      execute: async ({ path: relative }) => {
        const content = await readFile(resolve(relative), "utf8");
        stats.filesOpened += 1;
        stats.bytesRead += Buffer.byteLength(content, "utf8");
        return content.length <= MAX_FILE_CHARS
          ? content
          : `${content.slice(0, MAX_FILE_CHARS)}\n… ${content.length - MAX_FILE_CHARS} characters trimmed …`;
      },
    }),
  };
}

/** Every source file under the root, ignoring the directories a build owns. */
export async function sourceFiles(root: string): Promise<string[]> {
  return await walk(path.resolve(root));
}

/**
 * The work an agent without a graph has to do first: find every file that even
 * mentions the name. A mention is not a call, so each of these still has to be
 * opened and judged.
 */
export async function scanText(
  root: string,
  pattern: string,
): Promise<{ matches: number; files: string[]; hits: { path: string; line: number; text: string }[] }> {
  const absoluteRoot = path.resolve(root);
  const matcher = new RegExp(pattern, "i");
  const hits: { path: string; line: number; text: string }[] = [];

  for (const relative of await walk(absoluteRoot)) {
    const content = await readFile(path.join(absoluteRoot, relative), "utf8");
    for (const [index, line] of content.split("\n").entries()) {
      if (matcher.test(line)) {
        hits.push({ path: relative, line: index + 1, text: line.trim().slice(0, 200) });
      }
    }
  }

  return { matches: hits.length, files: [...new Set(hits.map((hit) => hit.path))], hits };
}

/** Every source file under the root, ignoring the directories a build owns. */
async function walk(absoluteRoot: string): Promise<string[]> {
  const found: string[] = [];

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) {
          await visit(path.join(directory, entry.name), prefix === "" ? entry.name : `${prefix}/${entry.name}`);
        }
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        found.push(prefix === "" ? entry.name : `${prefix}/${entry.name}`);
      }
    }
  };

  await visit(absoluteRoot, "");
  return found.sort();
}
