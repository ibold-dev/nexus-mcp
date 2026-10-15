import type { StubScript, StubContext } from "@nexus/agent";
import { lastResult, locatedSymbol } from "@nexus/agent";

/**
 * Three tasks, each answered twice: once with the Nexus tools, once with only
 * the filesystem tools an agent would otherwise use.
 *
 * The model is scripted in both conditions, so what the numbers compare is the
 * work the tools require — files opened, bytes read, calls made — and not one
 * model's cleverness against another's.
 *
 * The baseline is the honest minimum, not a straw man: it searches for the name,
 * then reads every file that mentions it, because a mention is not a call and
 * every candidate has to be judged. The runner caps how many it reads and says
 * so in the results.
 */

export interface BenchTask {
  id: string;
  question: string;
  /** What an answer has to contain, in the graph's terms. */
  groundTruth: string;
  /** What the baseline has to search for first. */
  searchPattern: string;
  withGraph: StubScript;
  /** Built per run, from the files that actually mention the name. */
  withoutGraph: (candidateFiles: string[]) => StubScript;
}

function reportFrom(context: StubContext, toolName: string): Record<string, unknown> | undefined {
  return lastResult(context, toolName) as Record<string, unknown> | undefined;
}

export function benchTasks(): BenchTask[] {
  return [
    {
      id: "impact-normalizeParams",
      question: "Which symbols call normalizeParams, and which files are they in?",
      groundTruth: "The caller set of normalizeParams, from the graph's POSSIBLY_CALLS edges.",
      searchPattern: "normalizeParams",
      withGraph: {
        steps: [
          { toolName: "nexus_locate", input: () => ({ query: "normalizeParams" }) },
          {
            toolName: "nexus_impact",
            input: (context) => ({ symbolId: locatedSymbol(context, "normalizeParams").symbolId, maxDepth: 1 }),
          },
        ],
        report: (context) => {
          const impact = reportFrom(context, "nexus_impact") as
            | { callers?: { qualifiedName: string }[]; files?: string[]; totalCallers?: number }
            | undefined;
          const callers = impact?.callers ?? [];
          const files = impact?.files ?? [];
          const total = impact?.totalCallers ?? callers.length;
          // The impact tool pages its answer. Printing the page as the total is
          // the one way this task could quietly overstate what the graph said.
          const headline =
            total > callers.length
              ? `${total} caller(s), ${callers.length} shown, in ${files.length} file(s).`
              : `${total} caller(s) in ${files.length} file(s).`;
          return [
            headline,
            `Files: ${files.join(", ")}`,
            `Callers: ${callers.map((caller) => caller.qualifiedName).join(", ")}`,
          ].join("\n");
        },
      },
      withoutGraph: (candidates) => ({
        steps: [
          { toolName: "search_text", input: () => ({ pattern: "normalizeParams" }) },
          ...candidates.map((file) => ({ toolName: "read_file", input: () => ({ path: file }) })),
        ],
        report: (context) => {
          const search = reportFrom(context, "search_text");
          const files = (search?.files as string[] | undefined) ?? [];
          return [
            `"normalizeParams" appears ${String(search?.matches ?? 0)} time(s) in ${files.length} file(s).`,
            `Read ${candidates.length} of them.`,
            "A mention is not a call: each file had to be read to tell the difference.",
          ].join("\n");
        },
      }),
    },

    {
      id: "define-ZodError",
      question: "Where is ZodError defined?",
      groundTruth: "The defining file and its line range, from the graph's Symbol nodes.",
      searchPattern: "ZodError",
      withGraph: {
        steps: [
          { toolName: "nexus_locate", input: () => ({ query: "ZodError" }) },
          {
            toolName: "nexus_context",
            input: (context) => ({ symbolId: locatedSymbol(context, "ZodError").symbolId, depth: 1 }),
          },
        ],
        report: (context) => {
          const symbol = locatedSymbol(context, "ZodError");
          return `${symbol.qualifiedName} is defined in ${symbol.path}.`;
        },
      },
      withoutGraph: (candidates) => ({
        steps: [
          { toolName: "search_text", input: () => ({ pattern: "ZodError" }) },
          ...candidates.map((file) => ({ toolName: "read_file", input: () => ({ path: file }) })),
        ],
        report: (context) => {
          const search = reportFrom(context, "search_text");
          const files = (search?.files as string[] | undefined) ?? [];
          return [
            `"ZodError" appears ${String(search?.matches ?? 0)} time(s) across ${files.length} file(s).`,
            `Read ${candidates.length} of them to look for the definition.`,
            "Nothing in the search result distinguishes a definition from a use.",
          ].join("\n");
        },
      }),
    },

    {
      id: "memory-normalizeParams",
      question: "What did earlier sessions learn about normalizeParams?",
      groundTruth: "The fact and procedure an earlier session stored about normalizeParams.",
      searchPattern: "normalizeParams",
      withGraph: {
        steps: [{ toolName: "nexus_recall", input: () => ({ query: "normalizeParams" }) }],
        report: (context) => {
          const recalled = reportFrom(context, "nexus_recall") as
            | { facts?: { text: string }[]; procedures?: { name: string }[] }
            | undefined;
          const facts = recalled?.facts ?? [];
          return [`${facts.length} fact(s) recalled from an earlier session.`, ...facts.map((fact) => `- ${fact.text}`)].join(
            "\n",
          );
        },
      },
      withoutGraph: (candidates) => ({
        steps: [
          { toolName: "search_text", input: () => ({ pattern: "normalizeParams" }) },
          ...candidates.map((file) => ({ toolName: "read_file", input: () => ({ path: file }) })),
        ],
        report: () =>
          [
            "The repository records what the code does, not what a previous session concluded about it.",
            "No number of file reads answers this: the conclusion has to be reached again from scratch.",
          ].join("\n"),
      }),
    },
  ];
}
