#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connectGraph } from "@nexus/core";
import { createNexusServer } from "./server.js";

const root = process.env.NEXUS_ROOT;
if (!root) {
  process.stderr.write("NEXUS_ROOT must point at the repository to index.\n");
  process.exit(1);
}

const graphUrl = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const graphName = process.env.NEXUS_GRAPH ?? "nexus";
const projectSalt = process.env.NEXUS_SALT ?? "default";

let client;
try {
  client = await connectGraph(graphUrl, graphName);
} catch (error) {
  process.stderr.write(`Cannot connect to FalkorDB at ${graphUrl}: ${(error as Error).message}\n`);
  process.exit(1);
}

const server = createNexusServer({ client, root, projectSalt });

const shutdown = async (): Promise<void> => {
  await server.close();
  await client.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
process.stderr.write(`nexus MCP server ready for ${root} (graph ${graphName})\n`);
