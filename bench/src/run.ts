#!/usr/bin/env node
/**
 * Runs the benchmark: three tasks, each answered twice — once with the Nexus
 * tools, once with only the filesystem tools an agent would otherwise use.
 *
 * The model is scripted in both conditions, so the numbers compare the work the
 * tools require, not one model against another. The cost of building the index
 * is measured and reported alongside, because a context layer that is cheap to
 * query is not a context layer that is free.
 *
 *   node bench/dist/run.js --root /path/to/repo [--runs 2] [--baseline-cap 25]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNexusServer } from "@nexus/mcp";
import { connectGraph, type GraphClient } from "@nexus/core";
import { connectNexusTools, createStubModel, runAgent, type NexusConnection } from "@nexus/agent";
import { createFsToolStats, fsTools, scanText, type FsToolStats } from "./fs-tools.js";
import { benchTasks, type BenchTask } from "./tasks.js";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    graph: { type: "string" },
    runs: { type: "string" },
    out: { type: "string" },
    cap: { type: "string" },
    "max-steps": { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const root = values.root ?? process.env.NEXUS_ROOT;
if (!root) {
  process.stderr.write("Pass --root, or set NEXUS_ROOT to the repository to benchmark.\n");
  process.exit(2);
}

const runs = Number.parseInt(values.runs ?? "2", 10);
const maxSteps = Number.parseInt(values["max-steps"] ?? "6", 10);
/** How many mentioning files the baseline is allowed to open before giving up. */
const baselineCap = Number.parseInt(values.cap ?? "25", 10);
const outDir = values.out ?? "bench/results";
const graphName = values.graph ?? `nexus_bench_${Date.now()}`;
const graphUrl = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const salt = process.env.NEXUS_SALT ?? "bench";
const userId = "bench-user";
const projectRoot = root as string;

interface Measurement {
  taskId: string;
  condition: "with-graph" | "without-graph";
  run: number;
  steps: number;
  toolCalls: string[];
  /** Files that mention the name at all, which the baseline has to consider. */
  candidates: number;
  filesOpened: number;
  bytesReadFromDisk: number;
  bytesReturnedToModel: number;
  approxTokensReturned: number;
  durationMs: number;
  answer: string;
}

interface IndexCost {
  filesIndexed: number;
  symbols: number;
  callEdges: number;
  resolvedImportEdges: number;
  coldSyncMs: number;
  warmSyncMs: number;
  seededFacts: number;
}

async function main(): Promise<void> {
  const graph: GraphClient = await connectGraph(graphUrl, graphName);
  const server = createNexusServer({
    client: graph,
    root: projectRoot,
    projectSalt: salt,
    userId,
    agentId: "bench-agent",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const connection: NexusConnection = await connectNexusTools({ root: projectRoot, transport: clientTransport });

  try {
    const index = await measureIndex(connection, graph);
    process.stderr.write(
      `[bench] indexed ${index.filesIndexed} file(s): ${index.symbols} symbol(s), ${index.callEdges} resolved call edge(s), ` +
        `${index.resolvedImportEdges} resolved import edge(s). Cold sync ${index.coldSyncMs} ms, no-op sync ${index.warmSyncMs} ms, ` +
        `memory seeded with ${index.seededFacts} fact(s)\n`,
    );

    const measurements: Measurement[] = [];
    for (const task of benchTasks()) {
      // What the baseline is up against: every file that mentions the name.
      const scan = await scanText(projectRoot, task.searchPattern);
      const candidates = scan.files.slice(0, baselineCap);
      process.stderr.write(
        `[bench] ${task.id}: "${task.searchPattern}" appears ${scan.matches} time(s) in ${scan.files.length} file(s); ` +
          `the baseline will read ${candidates.length}\n`,
      );

      for (const condition of ["with-graph", "without-graph"] as const) {
        for (let run = 1; run <= runs; run += 1) {
          const measurement = await measureTask(task, condition, run, candidates, scan.files.length);
          measurements.push(measurement);
          process.stderr.write(
            `[bench]   ${condition} run ${run}: ${measurement.toolCalls.length} call(s), ${measurement.filesOpened} file(s) opened, ` +
              `${measurement.bytesReturnedToModel} B returned (~${measurement.approxTokensReturned} tokens), ${measurement.durationMs} ms\n`,
          );
        }
      }
    }

    const report = {
      runId: new Date().toISOString(),
      repository: projectRoot,
      graph: graphName,
      runsPerCondition: runs,
      baselineCap,
      model: "scripted stub (no network)",
      index,
      summary: summarise(measurements),
      measurements,
    };

    const directory = path.isAbsolute(outDir) ? outDir : path.join(repoRoot(), outDir);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${report.runId.replace(/[:.]/g, "-")}.json`);
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    if (values.json === true) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${markdown(report)}\n`);
    }
    process.stderr.write(`[bench] wrote ${file}\n`);
  } finally {
    await connection.close();
    await graph.deleteGraph().catch(() => undefined);
    await graph.close();
  }

  async function measureTask(
    task: BenchTask,
    condition: "with-graph" | "without-graph",
    run: number,
    candidates: string[],
    totalCandidates: number,
  ): Promise<Measurement> {
    const stats: FsToolStats = createFsToolStats();
    const tools = condition === "with-graph" ? connection.tools : fsTools(projectRoot, stats);
    const script = condition === "with-graph" ? task.withGraph : task.withoutGraph(candidates);
    const model = createStubModel(script);
    // The baseline is allowed one search plus one read per candidate: the step
    // budget must not be what stops it, or the comparison measures the budget.
    const stepBudget = condition === "with-graph" ? maxSteps : candidates.length + 3;
    const startedAt = Date.now();

    const result = await runAgent(task.question, { model, tools, maxSteps: stepBudget });
    const durationMs = Date.now() - startedAt;
    const bytesReturnedToModel = result.toolCalls.reduce(
      (total, call) => total + Buffer.byteLength(call.output, "utf8"),
      0,
    );

    return {
      taskId: task.id,
      condition,
      run,
      steps: result.steps,
      toolCalls: result.toolCalls.map((call) => call.toolName),
      candidates: totalCandidates,
      filesOpened: stats.filesOpened,
      bytesReadFromDisk: stats.bytesRead,
      bytesReturnedToModel,
      approxTokensReturned: Math.round(bytesReturnedToModel / 4),
      durationMs,
      answer: result.text,
    };
  }

  async function measureIndex(connection: NexusConnection, graph: GraphClient): Promise<IndexCost> {
    const coldStarted = Date.now();
    await connection.callTool("nexus_sync");
    const coldSyncMs = Date.now() - coldStarted;

    const warmStarted = Date.now();
    await connection.callTool("nexus_sync");
    const warmSyncMs = Date.now() - warmStarted;

    const count = async (cypher: string): Promise<number> => {
      const rows = await graph.query<{ count: number }>(cypher);
      return rows[0]?.count ?? 0;
    };

    const filesIndexed = await count("MATCH (f:File) RETURN count(f) AS count");
    const symbols = await count("MATCH (s:Symbol) RETURN count(s) AS count");
    const callEdges = await count(
      "MATCH ()-[r:POSSIBLY_CALLS]->() WHERE r.resolution = 'resolved' RETURN count(r) AS count",
    );
    const resolvedImportEdges = await count(
      "MATCH ()-[r:IMPORTS]->() WHERE r.resolution = 'resolved' RETURN count(r) AS count",
    );

    // A previous session, writing down what it found before it stopped. This is
    // what the memory task recalls; it was not written by the run being measured.
    const located = await connection.callTool("nexus_locate", { query: "normalizeParams" });
    const hit = (located.body as { results?: { symbolId?: string }[] } | undefined)?.results?.[0];
    const remembered = await connection.callTool("nexus_remember", {
      text: "normalizeParams is the shared argument normaliser; changing it reaches every schema type constructor.",
      scope: "symbol",
      confidence: 0.7,
      ...(hit?.symbolId === undefined ? {} : { aboutSymbolId: hit.symbolId }),
    });
    await connection.callTool("nexus_remember", {
      kind: "procedure",
      name: "Check a change to normalizeParams",
      steps: ["Call nexus_impact on normalizeParams", "Run the tests for every file it returns"],
    });

    return {
      filesIndexed,
      symbols,
      callEdges,
      resolvedImportEdges,
      coldSyncMs,
      warmSyncMs,
      seededFacts: remembered.ok ? 1 : 0,
    };
  }
}

interface SummaryRow {
  taskId: string;
  condition: string;
  runs: number;
  steps: number;
  toolCalls: number;
  candidates: number;
  filesOpened: number;
  bytesReadFromDisk: number;
  bytesReturnedToModel: number;
  approxTokensReturned: number;
  durationMs: number;
}

function summarise(measurements: Measurement[]): SummaryRow[] {
  const groups = new Map<string, Measurement[]>();
  for (const measurement of measurements) {
    const key = `${measurement.taskId}|${measurement.condition}`;
    groups.set(key, [...(groups.get(key) ?? []), measurement]);
  }

  return [...groups.entries()].map(([key, group]) => {
    const [taskId, condition] = key.split("|");
    const mean = (pick: (measurement: Measurement) => number): number =>
      Math.round(group.reduce((total, measurement) => total + pick(measurement), 0) / group.length);
    return {
      taskId: taskId ?? "",
      condition: condition ?? "",
      runs: group.length,
      steps: mean((measurement) => measurement.steps),
      toolCalls: mean((measurement) => measurement.toolCalls.length),
      candidates: group[0]?.candidates ?? 0,
      filesOpened: mean((measurement) => measurement.filesOpened),
      bytesReadFromDisk: mean((measurement) => measurement.bytesReadFromDisk),
      bytesReturnedToModel: mean((measurement) => measurement.bytesReturnedToModel),
      approxTokensReturned: mean((measurement) => measurement.approxTokensReturned),
      durationMs: mean((measurement) => measurement.durationMs),
    };
  });
}

function markdown(report: {
  repository: string | undefined;
  graph: string;
  runsPerCondition: number;
  baselineCap: number;
  index: IndexCost;
  summary: SummaryRow[];
}): string {
  const lines = [
    "# Nexus benchmark",
    "",
    `Repository \`${report.repository}\`, graph \`${report.graph}\`, ${report.runsPerCondition} run(s) per condition, scripted model.`,
    "",
    `**Index:** ${report.index.filesIndexed} files, ${report.index.symbols} symbols, ${report.index.callEdges} resolved call edges, ${report.index.resolvedImportEdges} resolved import edges. ` +
      `Cold sync ${report.index.coldSyncMs} ms. No-op sync ${report.index.warmSyncMs} ms.`,
    "",
    "| Task | Tools | Calls | Files mentioning the name | Files opened | Bytes from disk | Tokens returned | Wall clock |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const row of report.summary) {
    lines.push(
      `| ${row.taskId} | ${row.condition === "with-graph" ? "nexus" : "filesystem"} | ${row.toolCalls} | ` +
        `${row.candidates} | ${row.filesOpened} | ${row.bytesReadFromDisk} | ${row.approxTokensReturned} | ${row.durationMs} ms |`,
    );
  }

  lines.push(
    "",
    `The baseline reads every file that mentions the name, up to ${report.baselineCap}, because a mention is not a call. ` +
      "The scripted model is identical in both conditions, so the difference is what the tooling makes an agent do.",
    "",
    "What the table does not show: the graph cannot be queried until it has been built, and the cold sync above is that bill. " +
      "It is paid once per repository and re-paid incrementally, not once per question.",
    "",
  );
  return lines.join("\n");
}

function repoRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

await main();
