import type { JSONSchema7 } from "@ai-sdk/provider";
import { generateText, jsonSchema, stepCountIs, tool, type LanguageModel, type Tool } from "ai";
import { CHANGE_IMPACT_SYSTEM_PROMPT } from "./prompt.js";
import { runTests, type TestRunResult, type TestRunnerOptions } from "./test-runner.js";

/**
 * The reference agent: a model, the Nexus MCP tools, and a step budget.
 *
 * There is nothing bespoke here about the graph. The agent is a plain tool loop
 * over the tools the MCP server advertised, which is the point: the same loop
 * runs with Claude, with a local Ollama model, or with the scripted model in the
 * tests, and any client that speaks MCP can drive the same tools.
 */

/**
 * Upper bound on model turns.
 *
 * Ten was enough for the scripted model, which replays a fixed six-step script,
 * but not for a real one: a live run against a 522-file repository spent
 * thirteen steps gathering evidence before it wrote anything. The budget is a
 * ceiling and not a target — a model that finishes early stops early — so it is
 * set above what the shipped demo is known to need with a real model behind it.
 */
export const DEFAULT_MAX_STEPS = 20;

export interface ToolCallRecord {
  toolName: string;
  input: unknown;
  /** False when the tool refused or reported a failure. */
  ok: boolean;
  output: string;
}

export interface AgentOptions {
  model: LanguageModel;
  tools: Record<string, Tool>;
  /** Defaults to the change-impact instructions. */
  system?: string;
  /** Upper bound on model turns. Defaults to {@link DEFAULT_MAX_STEPS}. */
  maxSteps?: number;
  /** Called after each model turn, for logging a run as it happens. */
  onStep?: (step: { index: number; toolCalls: ToolCallRecord[]; text: string }) => void;
}

export interface AgentRun {
  text: string;
  steps: number;
  toolCalls: ToolCallRecord[];
  finishReason: string;
  /**
   * False unless the model decided it was finished. A run stopped by its budget
   * returns the text it was saying alongside the tool call it was in the middle
   * of, which is mid-loop narration — and narration reads exactly like a report,
   * which makes it the most dangerous possible thing to print as one. The finish
   * reason is the only trustworthy signal, so that is what this reads.
   */
  reported: boolean;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export async function runAgent(task: string, options: AgentOptions): Promise<AgentRun> {
  const result = await generateText({
    model: options.model,
    system: options.system ?? CHANGE_IMPACT_SYSTEM_PROMPT,
    prompt: task,
    tools: options.tools,
    stopWhen: stepCountIs(options.maxSteps ?? DEFAULT_MAX_STEPS),
  });

  const toolCalls: ToolCallRecord[] = [];
  result.steps.forEach((step, index) => {
    const records = readStep(step);
    toolCalls.push(...records);
    options.onStep?.({ index: index + 1, toolCalls: records, text: step.text });
  });

  const finishReason = String(result.finishReason);

  return {
    text: result.text,
    steps: result.steps.length,
    toolCalls,
    finishReason,
    reported: finishReason === "stop",
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      totalTokens: result.usage.totalTokens ?? 0,
    },
  };
}

/**
 * Exposes the allowlisted test runner as a tool. The model can ask for test
 * files by path; it cannot ask for a command.
 */
export function testRunnerTool(options: TestRunnerOptions): Tool {
  return tool({
    description:
      "Run test files and read the result. Give repository-relative paths of test files (.test.ts or .spec.ts). Only that command is run, and only inside this repository.",
    inputSchema: jsonSchema<{ paths: string[] }>({
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
          description: "Repository-relative paths of the test files to run.",
        },
      },
      required: ["paths"],
      additionalProperties: false,
    } as JSONSchema7),
    execute: async ({ paths }): Promise<TestRunResult | { ok: false; error: string }> => {
      try {
        return await runTests(options, { paths });
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  });
}

/**
 * The SDK types tool results against the tool set, which is deliberately
 * dynamic here: the tools come from the server at runtime. This reads the step
 * structurally, which is all the harness needs.
 */
interface StepLike {
  text?: string;
  toolCalls?: { toolCallId: string; toolName: string; input?: unknown }[];
  toolResults?: { toolCallId: string; toolName: string; output?: unknown }[];
}

function readStep(step: unknown): ToolCallRecord[] {
  const { toolCalls = [], toolResults = [] } = step as StepLike;
  const inputs = new Map(toolCalls.map((call) => [call.toolCallId, call.input]));

  return toolResults.map((result) => ({
    toolName: result.toolName,
    input: inputs.get(result.toolCallId),
    ok: !isFailure(result.output),
    output: describeOutput(result.output),
  }));
}

/** The tool bridge returns `{ ok: false, error }` when a tool refuses. */
function isFailure(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "ok" in output &&
    (output as { ok?: unknown }).ok === false
  );
}

function describeOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}
