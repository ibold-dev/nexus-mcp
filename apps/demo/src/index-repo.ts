import { connectGraph } from "@nexus/core";
import { fullScan } from "@nexus/indexer";

const root = process.argv[2];
if (!root) {
  console.error("usage: pnpm --filter @nexus/demo index <repo-root>");
  process.exit(1);
}

const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const graphName = process.env.NEXUS_GRAPH ?? "nexus-demo";
const projectSalt = process.env.NEXUS_SALT ?? "demo";

const client = await connectGraph(url, graphName);
try {
  const started = performance.now();
  const result = await fullScan({ client, root, projectSalt });
  const durationMs = Math.round(performance.now() - started);
  console.log(JSON.stringify({ graph: graphName, durationMs, ...result, failures: result.failures.length }, null, 2));
  if (result.failures.length > 0) {
    console.log(JSON.stringify(result.failures.slice(0, 20), null, 2));
  }
} finally {
  await client.close();
}
