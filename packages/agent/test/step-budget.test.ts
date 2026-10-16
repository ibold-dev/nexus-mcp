import type { JSONSchema7 } from "@ai-sdk/provider";
import { jsonSchema, tool, type Tool } from "ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_STEPS, runAgent } from "../src/agent.js";
import { createStubModel, type StubScript } from "../src/stub-model.js";

/**
 * A run that is stopped by its budget returns no report — and, with a real model,
 * an empty string is not what it returns. Real models narrate while they work, so
 * the text a stopped run carries is the sentence the model was saying as it
 * reached for its last tool: "Confirmed the symbol. Now let me measure the impact
 * breadth." That reads exactly like an answer, which is why the finish reason and
 * not the text is what decides whether a run has a report.
 *
 * A live run found this the expensive way: against a 522-file repository, a
 * thirteen-step question was given twelve steps, and the agent's stdout was 123
 * bytes of mid-loop narration printed as the report, with exit code 0. The CLI now
 * prints nothing to stdout in that case, quotes the narration on stderr, and exits
 * non-zero.
 */

const tools: Record<string, Tool> = {
  ping: tool({
    description: "A tool that does nothing, so the budget is the only thing that can stop the loop.",
    inputSchema: jsonSchema<{ n: number }>({
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    } as JSONSchema7),
    execute: async () => ({ ok: true, pong: true }),
  }),
};

const NARRATION = "Confirmed the symbol. Now let me measure the impact breadth.";

/** A script that calls `ping` forever, and would report if it ever got the chance. */
function pingForever(steps: number, narration?: string): StubScript {
  return {
    steps: Array.from({ length: steps }, () => ({
      toolName: "ping",
      input: () => ({ n: 1 }),
      ...(narration === undefined ? {} : { text: narration }),
    })),
    report: () => "the report",
  };
}

describe("the step budget", () => {
  it("reports no report when the budget runs out, even though the text is not empty", async () => {
    const run = await runAgent("do something", {
      model: createStubModel(pingForever(9, NARRATION)),
      tools,
      maxSteps: 3,
    });

    expect(run.steps).toBe(3);
    expect(run.finishReason).toBe("tool-calls");
    // The trap: there is text, and it is not a report.
    expect(run.text).toContain("Now let me measure");
    expect(run.reported).toBe(false);
  });

  it("flags a run that reached its report", async () => {
    const run = await runAgent("do something", {
      model: createStubModel(pingForever(2, NARRATION)),
      tools,
      maxSteps: 8,
    });

    expect(run.steps).toBe(3);
    expect(run.finishReason).toBe("stop");
    expect(run.text).toBe("the report");
    expect(run.reported).toBe(true);
  });

  it("defaults to a budget a real model's tool loop can finish inside", () => {
    // The live run needed thirteen steps before it wrote anything. Below that,
    // the shipped demo stops mid-question whenever the model is real.
    expect(DEFAULT_MAX_STEPS).toBeGreaterThanOrEqual(13);
  });
});
