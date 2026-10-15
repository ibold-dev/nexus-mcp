#!/usr/bin/env node
/**
 * Two-process handoff, over the real MCP stdio transport.
 *
 * `handoff.ts write` starts one server process, indexes the repository, works
 * out the likely impact of one symbol, remembers what it found, and writes a
 * handoff. It then exits.
 *
 * `handoff.ts read` starts a second, completely fresh server process and
 * recalls what the first one left behind. Nothing is shared between them except
 * the graph in FalkorDB.
 *
 *   NEXUS_ROOT=/path/to/repo NEXUS_GRAPH=demo \
 *     node apps/demo/src/handoff.ts write
 *   NEXUS_ROOT=/path/to/repo NEXUS_GRAPH=demo \
 *     node apps/demo/src/handoff.ts read
 *
 * The read phase exits non-zero when it recalls nothing, so the pair can be
 * used as a gate.
 */
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("../../../packages/mcp/dist/main.js", import.meta.url));
const SERVER_CWD = fileURLToPath(new URL("../../..", import.meta.url));

const phase = process.argv[2];
if (phase !== "write" && phase !== "read") {
  process.stderr.write("usage: handoff.ts write|read\n");
  process.exit(2);
}

const rootSetting = process.env.NEXUS_ROOT;
if (!rootSetting) {
  process.stderr.write("NEXUS_ROOT must point at the repository to index.\n");
  process.exit(2);
}
const root: string = rootSetting;

const symbolName = process.env.NEXUS_DEMO_SYMBOL ?? "run";
const taskRef = process.env.NEXUS_TASK ?? "handoff-demo";

async function withServer<T>(agentId: string, work: (client: Client) => Promise<T>): Promise<T> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.NEXUS_ROOT = root;
  env.NEXUS_AGENT = agentId;
  env.NEXUS_USER = process.env.NEXUS_USER ?? "demo-user";

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: SERVER_CWD,
    env,
    stderr: "inherit",
  });
  const client = new Client({ name: `nexus-demo-${agentId}`, version: "0.1.0" });
  await client.connect(transport);
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}

/**
 * The MCP SDK abandons a request after 60 seconds by default, and a cold index
 * of a real repository takes longer than that. Raising it for the sync is what
 * keeps the demo honest: without it the client gives up while the server is
 * still indexing, and the read that follows reports an empty graph.
 *
 * The same reasoning lives in `packages/agent/src/mcp-tools.ts`, which is where
 * an agent's calls go. It is repeated here rather than imported so that this
 * demo keeps depending on nothing but the server's protocol.
 */
const SYNC_TIMEOUT_MS = 30 * 60 * 1000;

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    name === "nexus_sync" ? { timeout: SYNC_TIMEOUT_MS } : {},
  );
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  if (result.isError === true) {
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function firstHit(body: Record<string, unknown>): { symbolId: string; qualifiedName: string; path: string } | undefined {
  return (body.results as { symbolId: string; qualifiedName: string; path: string }[] | undefined)?.[0];
}

const write = async (client: Client): Promise<void> => {
  const sync = await call(client, "nexus_sync");
  process.stdout.write(
    `[write] synced ${String(sync.changedPaths ? (sync.changedPaths as string[]).length : 0)} changed files, graphVersion ${String(sync.graphVersion)}\n`,
  );

  const located = await call(client, "nexus_locate", { query: symbolName });
  const symbol = firstHit(located);
  if (!symbol) {
    process.stdout.write(`[write] no symbol matched "${symbolName}"; remembering a repository fact instead\n`);
    await call(client, "nexus_remember", {
      text: `The graph for this repository was last built at version ${String(sync.graphVersion)} by the demo agent.`,
    });
    await call(client, "nexus_handoff", { summary: "Index is warm. No symbol was picked for impact.", taskRef });
    return;
  }

  const impact = await call(client, "nexus_impact", { symbolId: symbol.symbolId, maxDepth: 3 });
  const callers = (impact.callers as { qualifiedName: string }[] | undefined) ?? [];
  const files = (impact.files as string[] | undefined) ?? [];
  // The tool pages its answer, so a page must not be printed as a total.
  const total = (impact.totalCallers as number | undefined) ?? callers.length;
  const scope = callers.length < total ? `${total} (first ${callers.length} shown)` : `${total}`;
  process.stdout.write(
    `[write] ${symbol.qualifiedName} (${symbol.path}) has ${scope} likely callers in ${files.length} files\n`,
  );

  const impactLine =
    callers.length === 0
      ? `Nothing in the indexed graph calls ${symbol.qualifiedName} yet.`
      : `Changing ${symbol.qualifiedName} in ${symbol.path} likely reaches ${scope} caller(s) across ${files.length} file(s): ${callers
          .slice(0, 3)
          .map((caller) => caller.qualifiedName)
          .join(", ")}.`;
  const filesLine = files.length === 0 ? "" : ` Files to test: ${files.slice(0, 5).join(", ")}.`;

  await call(client, "nexus_remember", {
    text: impactLine,
    scope: "symbol",
    confidence: 0.7,
    aboutSymbolId: symbol.symbolId,
  });
  await call(client, "nexus_remember", {
    kind: "procedure",
    name: "Check a change to a symbol",
    steps: [
      `Call nexus_locate on the symbol name to get its symbolId`,
      `Call nexus_impact with that symbolId to list likely callers`,
      `Run the tests for the files nexus_impact returns`,
      `Call nexus_sync after editing, then re-check with nexus_impact`,
    ],
    appliesToPath: symbol.path,
  });
  const handoff = await call(client, "nexus_handoff", {
    summary: `${impactLine}${filesLine}`,
    taskRef,
    toAgent: "demo-agent-b",
  });
  process.stdout.write(
    `[write] remembered a fact and a procedure, handoff ${String(handoff.handoffId).slice(0, 12)} with ${String(handoff.evidenceTurns)} evidence turn(s)\n`,
  );
};

const read = async (client: Client): Promise<void> => {
  const recalled = await call(client, "nexus_recall", { include: ["fact", "procedure", "handoff"] });
  const totals = recalled.totals as { facts: number; procedures: number; handoffs: number };
  process.stdout.write(
    `[read] graphVersion ${String(recalled.graphVersion)}, graph holds ${totals.facts} fact(s), ${totals.procedures} procedure(s), ${totals.handoffs} handoff(s)\n`,
  );

  for (const fact of (recalled.facts as { text: string; usedCount: number }[] | undefined) ?? []) {
    process.stdout.write(`[read] fact (used ${fact.usedCount}x): ${fact.text}\n`);
  }
  for (const procedure of (recalled.procedures as { name: string; steps: string[] }[] | undefined) ?? []) {
    process.stdout.write(`[read] procedure "${procedure.name}":\n`);
    procedure.steps.forEach((step, index) => process.stdout.write(`[read]   ${index + 1}. ${step}\n`));
  }
  for (const handoff of (recalled.handoffs as { fromAgent: string; summary: string; evidenceCount: number }[] | undefined) ?? []) {
    process.stdout.write(`[read] handoff from ${handoff.fromAgent} (${handoff.evidenceCount} turns): ${handoff.summary}\n`);
  }

  const matched = await call(client, "nexus_recall", { query: symbolName });
  const matchedFacts = (matched.facts as unknown[] | undefined) ?? [];
  process.stdout.write(`[read] a second recall for "${symbolName}" matched ${matchedFacts.length} fact(s)\n`);

  if (totals.facts === 0 || totals.procedures === 0 || totals.handoffs === 0) {
    process.stderr.write("[read] FAILED: the second process did not recall the first process's memory\n");
    process.exit(1);
  }
  process.stdout.write("[read] OK: the second process recalled the first process's memory from the graph\n");
};

await withServer(phase === "write" ? "demo-agent-a" : "demo-agent-b", phase === "write" ? write : read);
