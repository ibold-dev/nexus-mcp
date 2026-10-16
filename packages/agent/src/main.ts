#!/usr/bin/env node
/**
 * Runs the change-impact agent against a repository, through the real MCP server.
 *
 *   NEXUS_PROVIDER=ollama NEXUS_ROOT=/path/to/repo \
 *     node packages/agent/dist/main.js --symbol normalizeParams
 *
 * The report goes to stdout. Everything else — which provider is in use, every
 * tool call, every error — goes to stderr, so the report stays pipeable.
 */
import { parseArgs } from "node:util";
import { DEFAULT_MAX_STEPS, runAgent, testRunnerTool } from "./agent.js";
import { connectNexusTools } from "./mcp-tools.js";
import { createModel, DEFAULT_PROVIDER, parseProvider, PROVIDER_BASE_URL_ENV, ProviderConfigError } from "./model.js";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    symbol: { type: "string" },
    task: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    "base-url": { type: "string" },
    "max-steps": { type: "string" },
    "allow-tests": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help === true) {
  process.stdout.write(
    [
      "Usage: nexus-agent --symbol <name> [options]",
      "",
      "  --root <path>       Repository to index (default: NEXUS_ROOT)",
      "  --symbol <name>     Symbol to analyse (default: NEXUS_SYMBOL)",
      "  --task <text>       What to ask, instead of the default impact question",
      `  --provider <name>   Model provider (default: ${DEFAULT_PROVIDER})`,
      "  --model <id>        Model id for that provider",
      "  --base-url <url>    Endpoint for the provider (or for openai-compatible, if none is named)",
      "  --max-steps <n>     Model turns to allow (default: 10)",
      "  --allow-tests       Let the agent run test files it names",
      "  --json              Print the whole run as JSON",
      "",
      `Providers: anthropic, openai, google, ollama, openai-compatible, stub`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const root = values.root ?? process.env.NEXUS_ROOT;
if (!root) {
  process.stderr.write("Pass --root, or set NEXUS_ROOT to the repository to index.\n");
  process.exit(2);
}

const symbol = values.symbol ?? process.env.NEXUS_SYMBOL;
const task =
  values.task ??
  (symbol === undefined
    ? undefined
    : `Work out what changing ${symbol} would affect, and report it with evidence.`);
if (task === undefined) {
  process.stderr.write("Pass --task, or --symbol to ask the default impact question.\n");
  process.exit(2);
}

const env: NodeJS.ProcessEnv = { ...process.env };
if (values.provider !== undefined) {
  env.NEXUS_PROVIDER = values.provider;
}
if (values.model !== undefined) {
  env.NEXUS_MODEL = values.model;
}
if (values["base-url"] !== undefined) {
  // A URL with no provider named means an OpenAI-shaped server, the same rule
  // the environment variables follow. With a provider named — here or in the
  // environment — the flag aims at that provider's own variable.
  const named = values.provider ?? env.NEXUS_PROVIDER;
  const provider =
    named === undefined || named.trim() === "" ? "openai-compatible" : parseProvider(named, env);
  const name = PROVIDER_BASE_URL_ENV[provider];
  if (name === null) {
    process.stderr.write(`--base-url does not apply to the ${provider} provider.\n`);
    process.exit(2);
  }
  env[name] = values["base-url"];
}
if (env.NEXUS_STUB_SYMBOL === undefined && symbol !== undefined) {
  env.NEXUS_STUB_SYMBOL = symbol;
}

const maxSteps = Number.parseInt(values["max-steps"] ?? "", 10);
if (values["max-steps"] !== undefined && (!Number.isFinite(maxSteps) || maxSteps < 1)) {
  process.stderr.write("--max-steps must be a positive integer.\n");
  process.exit(2);
}

const allowTests = values["allow-tests"] === true || process.env.NEXUS_ALLOW_TESTS === "1";
const graphName = process.env.NEXUS_GRAPH ?? "nexus";
const agentId = process.env.NEXUS_AGENT ?? "nexus-agent";

try {
  const choice = createModel(env);
  process.stderr.write(
    `[agent] ${choice.provider}/${choice.modelId}, graph ${graphName}, root ${root}\n`,
  );
  for (const warning of choice.warnings) {
    process.stderr.write(`[agent] warning: ${warning}\n`);
  }

  const connection = await connectNexusTools({
    root,
    agentId,
    ...(process.env.FALKORDB_URL === undefined ? {} : { graphUrl: process.env.FALKORDB_URL }),
    ...(process.env.NEXUS_GRAPH === undefined ? {} : { graphName: process.env.NEXUS_GRAPH }),
    ...(process.env.NEXUS_SALT === undefined ? {} : { salt: process.env.NEXUS_SALT }),
    ...(process.env.NEXUS_USER === undefined ? {} : { userId: process.env.NEXUS_USER }),
  });
  process.stderr.write(`[agent] tools: ${connection.toolNames.join(", ")}\n`);

  const tools = { ...connection.tools };
  if (allowTests) {
    tools.run_tests = testRunnerTool({ root, enabled: true });
    process.stderr.write("[agent] test runner enabled (allowlisted, repository-relative test files only)\n");
  }

  try {
    const run = await runAgent(task, {
      model: choice.model,
      tools,
      ...(values["max-steps"] === undefined ? {} : { maxSteps }),
      onStep: ({ index, toolCalls, text }) => {
        const names = toolCalls.map((call) => `${call.toolName}${call.ok ? "" : " (failed)"}`).join(", ");
        process.stderr.write(`[agent] step ${index}: ${names || "no tool call"}${text ? ` — ${excerpt(text)}` : ""}\n`);
      },
    });

    if (values.json === true) {
      process.stdout.write(
        `${JSON.stringify(
          {
            provider: choice.provider,
            modelId: choice.modelId,
            graph: graphName,
            root,
            task,
            maxSteps: values["max-steps"] === undefined ? DEFAULT_MAX_STEPS : maxSteps,
            ...run,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(`${run.text}\n`);
      process.stderr.write(
        `[agent] done in ${run.steps} step(s), ${run.toolCalls.length} tool call(s), finish ${run.finishReason}\n`,
      );
    }
  } finally {
    await connection.close();
  }
} catch (error) {
  if (error instanceof ProviderConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`Agent run failed: ${(error as Error).message}\n`);
  process.exit(1);
}

function excerpt(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= 120 ? single : `${single.slice(0, 119)}…`;
}
