import { describe, expect, it } from "vitest";
import {
  defaultStubScript,
  type StubContext,
  type StubToolResult,
} from "../src/stub-model.js";

/**
 * The scripted model's report is what the benchmark and the demo show, so its
 * wording is a claim about the graph, not decoration. The one that matters here
 * is a paged list: `nexus_impact` returns a page and its total, and a page
 * printed as a total would overstate what was actually found.
 */

const caller = (index: number) => ({
  qualifiedName: `caller${String(index)}`,
  path: "src/api.ts",
  hops: 1,
  resolution: "resolved",
});

function contextWith(impact: Record<string, unknown>): StubContext {
  const results: StubToolResult[] = [
    {
      toolName: "nexus_locate",
      error: false,
      value: { results: [{ symbolId: "s1", qualifiedName: "normalizeParams", path: "src/util.ts" }] },
    },
    { toolName: "nexus_impact", error: false, value: impact },
    { toolName: "nexus_recall", error: false, value: { totals: { facts: 1, procedures: 0, handoffs: 0 } } },
  ];
  return { results, stepIndex: results.length, prompt: [] };
}

describe("the scripted report", () => {
  it("says when the caller list is a page rather than the whole answer", () => {
    const script = defaultStubScript("normalizeParams");
    const text = script.report(
      contextWith({
        callers: Array.from({ length: 12 }, (_, index) => caller(index)),
        files: ["src/api.ts"],
        totalCallers: 20,
        truncated: true,
      }),
    );

    expect(text).toContain("Showing 12 of 20 likely caller(s)");
    expect(text).toContain("8 caller(s) beyond this list are not shown");
  });

  it("states a count as a total when it is one", () => {
    const script = defaultStubScript("normalizeParams");
    const text = script.report(
      contextWith({
        callers: [caller(1), caller(2)],
        files: ["src/api.ts"],
        totalCallers: 2,
        truncated: false,
      }),
    );

    expect(text).toContain("2 likely caller(s) in 1 file(s)");
    expect(text).not.toContain("Showing");
    expect(text).not.toContain("beyond this list");
  });

  it("does not invent a total when the tool did not report one", () => {
    const script = defaultStubScript("normalizeParams");
    const text = script.report(
      contextWith({ callers: [caller(1)], files: ["src/api.ts"] }),
    );

    expect(text).toContain("1 likely caller(s) in 1 file(s)");
    expect(text).not.toContain("Showing");
  });

  it("says so plainly when nothing calls the symbol", () => {
    const script = defaultStubScript("normalizeParams");
    const text = script.report(contextWith({ callers: [], files: [], totalCallers: 0 }));

    expect(text).toContain("Nothing in the indexed graph calls this symbol");
  });
});
