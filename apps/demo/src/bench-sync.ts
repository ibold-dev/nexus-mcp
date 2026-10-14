import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { connectGraph, normalizeRootPath, repositoryId } from "@nexus/core";
import { RepositoryAnalyzer } from "@nexus/parser-ts";
import { syncRepository } from "@nexus/indexer";

const root = normalizeRootPath(process.argv[2] ?? "");
const touched = process.argv[3];
if (!root || !touched) {
  console.error("usage: node apps/demo/src/bench-sync.ts <repo-root> <relative-file-to-touch>");
  process.exit(1);
}

const projectSalt = process.env.NEXUS_SALT ?? "demo";
const graphName = process.env.NEXUS_GRAPH ?? "nexus-bench";
const client = await connectGraph(process.env.FALKORDB_URL ?? "redis://localhost:6379", graphName);
const analyzer = new RepositoryAnalyzer(repositoryId(root, projectSalt));

async function timed(label: string, work: () => Promise<unknown>): Promise<void> {
  const started = performance.now();
  const result = await work();
  const ms = Math.round(performance.now() - started);
  console.log(JSON.stringify({ step: label, ms, result }));
}

const target = path.join(root, touched);
const original = await readFile(target, "utf8");

try {
  await timed("cold sync", () => syncRepository({ client, root, projectSalt, analyzer }));
  await timed("no-op sync", () => syncRepository({ client, root, projectSalt, analyzer }));
  await writeFile(target, `// bench edit\n${original}`, "utf8");
  await timed("warm sync after one edit", () => syncRepository({ client, root, projectSalt, analyzer }));
  await writeFile(target, original, "utf8");
  await timed("warm sync after restoring the file", () => syncRepository({ client, root, projectSalt, analyzer }));
} finally {
  await writeFile(target, original, "utf8");
  await client.close();
}
