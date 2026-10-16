import {
  UnsupportedFunctionalityError,
  type LanguageModelV2,
  type LanguageModelV2CallOptions,
  type LanguageModelV2Prompt,
  type LanguageModelV2ToolResultOutput,
  type LanguageModelV2Usage,
} from "@ai-sdk/provider";

/**
 * A model that replays a script instead of calling anyone.
 *
 * The agent harness, the benchmarks, and the tests all have to run without an
 * API key and, in CI, without a model server. A scripted model keeps the whole
 * tool loop — arguments in, results back, next step — under test, and it makes
 * a run reproducible down to the tool arguments, which is what a benchmark
 * needs. It never reaches the network.
 */

/** One scripted tool call. `input` sees everything the conversation holds so far. */
export interface StubStep {
  toolName: string;
  input: (context: StubContext) => unknown;
  /**
   * Text the model says alongside the tool call. Real models narrate while they
   * work, and that narration is what a run stopped mid-loop returns as its text
   * — which is how a run can have a non-empty answer and no report at all.
   */
  text?: string;
}

export interface StubToolResult {
  toolName: string;
  /** The result parsed from JSON when it was JSON, otherwise the raw text. */
  value: unknown;
  /** True when the tool itself reported an error. */
  error: boolean;
}

export interface StubContext {
  /** The results of the steps that have already run, in order. */
  results: StubToolResult[];
  /** How many steps have run, which is the index of the step about to run. */
  stepIndex: number;
  prompt: LanguageModelV2Prompt;
}

export interface StubScript {
  /** Tool calls, one per step, in order. Once these run out, the model reports. */
  steps: StubStep[];
  /** The text the model produces once every step has run. */
  report: (context: StubContext) => string;
}

export function createStubModel(script: StubScript, options: { modelId?: string } = {}): LanguageModelV2 {
  let calls = 0;

  return {
    specificationVersion: "v2",
    provider: "nexus-stub",
    modelId: options.modelId ?? "stub-1",
    supportedUrls: {},
    doGenerate: async (callOptions: LanguageModelV2CallOptions): Promise<StubGenerateResult> => {
      calls += 1;
      const results = readToolResults(callOptions.prompt);
      const context: StubContext = { results, stepIndex: results.length, prompt: callOptions.prompt };
      const usage: LanguageModelV2Usage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      const step = script.steps[context.stepIndex];

      if (step !== undefined) {
        const content: StubGenerateResult["content"] = [];
        if (step.text !== undefined) {
          content.push({ type: "text", text: step.text });
        }
        content.push({
          type: "tool-call",
          toolCallId: `stub-call-${calls}`,
          toolName: step.toolName,
          input: JSON.stringify(step.input(context) ?? {}),
        });
        return {
          content,
          finishReason: "tool-calls",
          usage,
          warnings: [],
        };
      }

      return {
        content: [{ type: "text", text: script.report(context) }],
        finishReason: "stop",
        usage,
        warnings: [],
      };
    },
    // The stub exists to exercise the tool loop, which is a generate call.
    doStream: async () => {
      throw new UnsupportedFunctionalityError({ functionality: "streaming from the stub model" });
    },
  };
}

type StubGenerateResult = Awaited<ReturnType<LanguageModelV2["doGenerate"]>>;

/** Reads every tool result out of the prompt, oldest first. */
function readToolResults(prompt: LanguageModelV2Prompt): StubToolResult[] {
  const results: StubToolResult[] = [];
  for (const message of prompt) {
    if (message.role !== "tool" && message.role !== "assistant") {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "tool-result") {
        continue;
      }
      results.push({ toolName: part.toolName, ...readOutput(part.output) });
    }
  }
  return results;
}

function readOutput(output: LanguageModelV2ToolResultOutput): { value: unknown; error: boolean } {
  switch (output.type) {
    case "json":
      return { value: output.value, error: false };
    case "error-json":
      return { value: output.value, error: true };
    case "text":
      return { value: parseJson(output.value), error: false };
    case "error-text":
      return { value: parseJson(output.value), error: true };
    case "content":
      return {
        value: parseJson(
          output.value.map((part) => (part.type === "text" ? part.text : "[media]")).join(""),
        ),
        error: false,
      };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The most recent result of a given tool, or undefined when it never ran. */
export function lastResult(context: StubContext, toolName: string): unknown {
  for (let index = context.results.length - 1; index >= 0; index -= 1) {
    const result = context.results[index];
    if (result?.toolName === toolName) {
      return result.value;
    }
  }
  return undefined;
}

interface LocatedSymbol {
  symbolId: string;
  qualifiedName: string;
  path: string;
}

/**
 * The symbol the script is working on: whatever nexus_locate found, or a
 * placeholder that the tools will politely refuse, so the script still runs to
 * the end on a repository where the name does not appear.
 */
export function locatedSymbol(context: StubContext, fallbackName: string): LocatedSymbol {
  const located = lastResult(context, "nexus_locate") as
    | { results?: { symbolId?: string; qualifiedName?: string; path?: string }[] }
    | undefined;
  const hit = located?.results?.[0];
  if (hit?.symbolId !== undefined && hit.qualifiedName !== undefined && hit.path !== undefined) {
    return { symbolId: hit.symbolId, qualifiedName: hit.qualifiedName, path: hit.path };
  }
  return { symbolId: "unknown-symbol", qualifiedName: fallbackName, path: "" };
}

/**
 * The script the tests and the offline demo replay: sync the repository, find
 * the symbol, walk its likely callers, check what earlier sessions learned,
 * remember what this one found, then report. Every step goes through the same
 * MCP tools a real model would call.
 */
export function defaultStubScript(symbolName: string): StubScript {
  return {
    steps: [
      { toolName: "nexus_sync", input: () => ({}) },
      { toolName: "nexus_locate", input: () => ({ query: symbolName }) },
      {
        toolName: "nexus_impact",
        input: (context) => ({ symbolId: locatedSymbol(context, symbolName).symbolId, maxDepth: 3 }),
      },
      { toolName: "nexus_recall", input: () => ({ query: symbolName }) },
      {
        toolName: "nexus_remember",
        input: (context) => ({
          text: impactSentence(context, symbolName),
          scope: "symbol",
          confidence: 0.6,
          aboutSymbolId: locatedSymbol(context, symbolName).symbolId,
        }),
      },
    ],
    report: (context) => reportText(context, symbolName),
  };
}

function impact(context: StubContext): {
  callers: { qualifiedName: string; path: string; hops: number; resolution: string }[];
  files: string[];
  total: number;
  truncated: boolean;
} {
  const value = lastResult(context, "nexus_impact") as
    | {
        callers?: { qualifiedName?: string; path?: string; hops?: number; resolution?: string }[];
        files?: string[];
        totalCallers?: number;
        truncated?: boolean;
      }
    | undefined;
  const callers = (value?.callers ?? []).map((caller) => ({
    qualifiedName: caller.qualifiedName ?? "(unknown)",
    path: caller.path ?? "(unknown)",
    hops: caller.hops ?? 0,
    resolution: caller.resolution ?? "unknown",
  }));
  const total = value?.totalCallers ?? callers.length;
  return {
    callers,
    files: value?.files ?? [],
    total,
    // The tool pages its answer. A count that is a page must not read as a total.
    truncated: value?.truncated === true || callers.length < total,
  };
}

function impactSentence(context: StubContext, fallbackName: string): string {
  const symbol = locatedSymbol(context, fallbackName);
  const { callers, files, total, truncated } = impact(context);
  if (callers.length === 0) {
    return `Nothing in the indexed graph calls ${symbol.qualifiedName} yet.`;
  }
  const names = callers
    .slice(0, 3)
    .map((caller) => caller.qualifiedName)
    .join(", ");
  const scope = truncated ? `${total} caller(s), ${callers.length} shown` : `${total} caller(s)`;
  return `Changing ${symbol.qualifiedName} (${symbol.path}) likely reaches ${scope} in ${files.length} file(s): ${names}.`;
}

function reportText(context: StubContext, fallbackName: string): string {
  const symbol = locatedSymbol(context, fallbackName);
  const { callers, files, total, truncated } = impact(context);
  const remembered = lastResult(context, "nexus_recall") as
    | { totals?: { facts?: number; procedures?: number; handoffs?: number } }
    | undefined;
  const totals = remembered?.totals ?? {};

  return [
    `## Change impact: ${symbol.qualifiedName}`,
    "",
    symbol.path === "" ? `No indexed symbol matched \`${fallbackName}\`.` : `Defined in \`${symbol.path}\`.`,
    "",
    "### Likely affected",
    "",
    callers.length === 0
      ? "Nothing in the indexed graph calls this symbol, so the graph offers no callers to inspect."
      : [
          truncated
            ? `Showing ${callers.length} of ${total} likely caller(s), across ${files.length} file(s) in this list:`
            : `${total} likely caller(s) in ${files.length} file(s):`,
          "",
          ...callers.map(
            (caller) =>
              `- \`${caller.qualifiedName}\` in \`${caller.path}\`, ${caller.hops} hop(s) away, reached through a ${caller.resolution} edge`,
          ),
        ].join("\n"),
    "",
    "### Evidence",
    "",
    `Call edges come from the graph's \`POSSIBLY_CALLS\` edges, which are labelled \`resolved\` or \`heuristic\`.`,
    `Memory at the start of this run: ${totals.facts ?? 0} fact(s), ${totals.procedures ?? 0} procedure(s), ${totals.handoffs ?? 0} handoff(s).`,
    "",
    "### Unknowns",
    "",
    "Call edges do not cross into dependencies, so anything reached through a third-party package is invisible here.",
    ...(truncated
      ? [`The impact list is paged, so the ${total - callers.length} caller(s) beyond this list are not shown.`]
      : []),
  ].join("\n");
}
