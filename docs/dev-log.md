# Development log

Dated record of build work. AI assistance (Claude via OpenCode) was used throughout; every change was run through typecheck, lint, and tests before committing, and each milestone is its own commit.

## 2026-10-15

- 00:08 IST: coding window opened. Repository initialized as `nexus-mcp`.
- Workspace (pnpm, TypeScript 5.9, Vitest, ESLint), Docker Compose with FalkorDB.
- Graph schema constants and stable ID functions.
- Parameterized repository and file writes, verified against a live FalkorDB container.
- Symbol extraction with ts-morph; IMPORTS edges with resolution labels.
- Full scan with atomic per-file writes; idempotent re-index verified on zod (MIT, commit 680d19f): second scan writes nothing.
- Full-text symbol search, scoped by repository; camelCase split for search terms; OR-ed prefix terms.
- Symbol IDs changed to exclude source position, so edits above a symbol keep its ID.
- Call extraction with `resolved` and `heuristic` labels; inbound re-resolution when a callee changes.
- Known costs: each sync re-analyzes the whole repository for type resolution (about 32s on zod, even when nothing changed). A checker crash on one file in zod is caught per call and reported as a failure, not a scan abort.

## Decisions made during the build

- Full-text search uses OR between terms, ranked by score, instead of RediSearch's default AND.
- Symbol IDs drop the source offset (see the ID commit message).
- Call edges come from a repository-wide type-checker pass. Member calls on untyped receivers get a heuristic edge only when the method name is unique in the repository.

## 2026-10-15 (later)

- Sync speed: the analyzer now keeps one type-checker project alive across syncs. Only changed files are re-parsed, and calls are recomputed only where a change can affect them. Imports resolve through TypeScript's module resolver over the repository's own file list, which avoids building a program.
- Sync fast path: a sync that finds nothing changed against the graph returns without analysis (about 0.26s on zod).
- Index fix: call-edge writes look up symbols by id, so `Symbol.id` now has a range index. Without it, each lookup scanned every symbol.
- Deletions: files removed from disk are removed from the graph with their symbols and edges, and their dependents are rewritten.
- Repo lock: `.nexus/sync.lock` holds the owning PID. A live owner blocks the sync; a stale lock is replaced.
- Measured on zod (522 files): cold sync 39s, no-op 0.26s, warm single-file edit 4.5s.
- Known limits: the warm edit cost is mostly TypeScript rebuilding its program. Analysis is repository-wide, so one file that throws would abort the sync; per-file isolation is not in place yet. A few `.mjs` files in zod produce unresolved calls, which are reported as failures, not silently dropped.

## 2026-10-15 (Day 2)

- Repository `graphVersion` and `indexedAt`: every write bumps the version; no-op syncs report the current value.
- Context queries: a symbol's callers and callees at depth 1, and through one intermediate symbol at depth 2. Two-hop confidence is the product of the edge confidences, and a path is heuristic if either edge is.
- MCP server (`@nexus/mcp`, stdio): `nexus_locate`, `nexus_context`, and `nexus_sync`. Every response carries `graphVersion` and `indexedAt`. Results are capped at 8 per list. Syncs within one server run one at a time.
- Smoke test of the built server against zod: cold sync 37s; locate and context each respond in under 100ms, with responses under 2 KB.
- Found and fixed: the locate reason said "signature or doc matches" for a name that matched a camelCase query. The match now compares compacted, lowercased text.
- Still open: the watcher (stretch), per-file isolation when the analyzer throws (a failure aborts the sync and returns an error), and the warm-edit cost of about 4.5s.

## 2026-10-15 (Day 3)

- **Per-file isolation.** A file now either indexes completely or is left untouched and retried on the next sync. The call extractor moved out of `analysis.ts` into `calls.ts`, so the orchestration reads as orchestration. One bad file can no longer leave the graph half-written or abort a sync of the other 500.
- **`nexus_path`.** Call paths between two symbols, via FalkorDB's `algo.SPpaths`. Two things needed care: the hop direction is derived by comparing `startNode(r).id` with the hop's own starting symbol, so a path can mix "calls into" and "is called by" without confusing them; and a path's confidence is the product of its hops', so a path is only `resolved` if every hop is.
- **`nexus_impact`.** The change-impact question: walk `POSSIBLY_CALLS` backwards, nearest first. Every path is returned and then reduced to the shortest one to each caller, and `via` names the symbol the caller actually calls, so a direct caller is distinguishable from a symbol three hops up. A symbol is never its own caller. The answer is a map of likely impact, not a guarantee, and it says so in the response.
- **Memory (Track 02).** `Session`, `Turn`, `Fact`, `Procedure`, `Handoff`, scoped by `userId` and `repoId` on every read. `nexus_remember` / `nexus_recall` / `nexus_handoff`. Two decisions worth recording: turns are ordered by an `ordinal` property rather than a `NEXT` chain, because appending to a linked list means rewriting its tail; and recall raises `usedCount` and `lastUsedAt` on what it surfaces and reports the counts after the call, so the number in the reply agrees with the graph.
- Writing memory is idempotent by construction: facts are keyed by their text, procedures by their name, and every edge is a relationship `MERGE` guarded by
  `OPTIONAL MATCH ... FOREACH (_ IN CASE WHEN x IS NULL THEN [] ELSE [1] END | MERGE ...)` — the only way to create an edge conditionally in one round trip.
- **The handoff gate.** `apps/demo` runs the two-process demo. Verified on a fresh zod clone: process one synced, found `normalizeParams` had 12 callers in one file, wrote a fact, a procedure and a handoff with two evidence turns; process two, a separate run and a separate server, recalled all three and matched the fact by query. That is the whole of Track 02 in one command.
- **The reference agent.** `packages/agent` drives the real MCP server as any client would: it asks for the tool list, converts it, and runs the loop. The provider is a switch — Claude by default, plus OpenAI, Google, Ollama and any OpenAI-compatible endpoint, each failing fast by naming the missing environment variable rather than silently falling back. Tests run against a scripted `LanguageModelV2`, so the whole loop is asserted without a network or a key. The test runner the agent may reach is allowlisted, off by default, one fixed command, no shell, paths that must stay inside the repository.
- **The benchmark.** `bench/` measures what the context layer removes rather than how clever a model is: three tasks, each run twice, identical scripted model in both conditions, the only difference being the toolset. On a 522-file zod checkout: impact of `normalizeParams` costs 1,165 tokens and no file reads against 23,568 tokens and four files; locating `ZodError`'s definition costs 834 tokens against 60,217, across 25 of the 145 files that mention it. The third task is a capability gap rather than a cost gap, and is labelled as one.
- The first version of that benchmark was wrong in a way worth recording: the step budget silently capped the baseline at five file reads, so it looked *faster* than the graph. The budget is now sized from the candidate count, because otherwise the comparison measures the budget.
- **Deployment.** One image, two entry points: the MCP server by default, the agent by command. Compose runs FalkorDB and the agent against a mounted repository. Same code path as running it locally, and the same code path against a hosted graph — the URL is the only difference.
- 174 tests across 18 files, typecheck and lint clean. Verified counts at this point: 522 files indexed, 14,162 symbols, 5,184 resolved call edges, 647 resolved import edges; cold sync about 30 s, no-op sync about 0.2 s.
- Still open: the warm-edit cost (~4.5 s, mostly TypeScript rebuilding its program), the watcher, and `QUERIED` / `TOUCHES` edges from a turn to the symbols and files it looked at — the data is already on the turn, the edges are not.

## 2026-10-15 (Day 4): the verification pass, and what it caught

The repository was pushed to <https://github.com/ibold-dev/nexus-mcp> and then cloned into a directory with no history, no `node_modules`, and no `.env`, and everything below was run from that clone. Six things were wrong. None of them were visible by reading the code, and each one is now a test.

- **The MCP client's 60-second default cut off a cold sync.** A cold index of a 522-file repository runs for about 30 s on a warm machine and longer on a cold one. When the client gives up, the server carries on indexing — so the *next* call is answered by a graph that is still being written, and a locate that should have matched reports nothing. The graph was populated, the answer was empty, and nothing in the output said why. Syncs now get thirty minutes, other calls five. This is the one that worried me most: it presented as "the symbol does not exist".
- **The agent's test runner used a reporter that Vitest 5 had removed.** `--reporter=basic` is treated as a module path, so the run died before a single test executed. Every test of the runner passed a custom command, so the one command that ships was the only one never run. There is now a test that runs the default command over a test file that touches no database.
- **The Compose stack hardcoded its container names.** The clone's `docker compose up -d falkordb` conflicted with the first checkout's container — which was stopped, but a stopped container still owns its name. Names are now scoped to the project directory, and the published ports are overridable.
- **The impact list was a page printed as a total.** `nexus_impact` returns at most `limit` callers, default 12, and its `truncated` flag only meant "the path enumeration hit its own ceiling". So the report said "12 likely caller(s)" for `normalizeParams`, which has **615** distinct callers at depth 3 and 131 direct ones. The number was not fabricated, but it was a page, and nothing said so. `truncated` now means what every consumer assumes it means — the list is not the whole answer — and the agent's report, the demo's summary line, and the benchmark's task headline all disclose it, in the same way the filesystem baseline already disclosed "Read 12 of 25".
- **A call was attributed to a local variable instead of the function containing it.** In `function run() { const total = add(1, 2); }` the nearest symbol to the call is `total`, so `nexus_impact` named `total` as a caller of `add`. It now walks for the nearest enclosing *callable*, and falls back to a local only when no function encloses the call — which is what happens inside an anonymous callback, so callers inside `it(...)` callbacks are still named after their locals. That is a known imprecision, not a fixed one.
- **Search buried the symbol the name belonged to.** A full-text query is a set of prefixes OR-ed across name, search text, signature, and doc, ordered by score. Asking a real repository for `ZodError` returned `$ZodErrorTree` first with a score of 12, `$ZodErrorMap` and `ZodErrorMap` next at 10, and the class actually named `ZodError` sixth with 7 — the search had found the right symbol and then ranked a longer name that merely contained it above it. An exact name now ranks first, and the tokenised name second, before score. Found because the benchmark's second task, "where is `ZodError` defined", kept answering `$ZodErrorTree`, and the temptation was to rename the task. The task was right.

Rehearsed end to end from the clone: `pnpm install --frozen-lockfile`, `pnpm build`, `docker compose up -d falkordb`, 186 tests across 20 files passing, the keyless quick start producing a cited report, and `docker compose up agent` with no environment at all indexing this repository and answering for `syncRepository`.

Numbers worth stating plainly, since they are the ones the benchmark rests on: a symbol can have hundreds of callers, one page is 12, and the graph knows the difference.

## 2026-10-16 (Day 5): pointing any provider at a gateway

The agent could be pointed at an OpenAI-compatible endpoint, but nothing else could be pointed anywhere: routing Claude through a proxy, or an OpenAI key through a company gateway, meant editing the source. Every provider now has an optional endpoint variable, named the same as the one its own SDK uses — `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GEMINI_BASE_URL`, `OLLAMA_BASE_URL` — and `NEXUS_BASE_URL` keeps its existing meaning as the `openai-compatible` endpoint.

- **The override has to be passed in, because nothing else reads it.** `@ai-sdk/anthropic` compiles `api.anthropic.com/v1` into its bundle and `@ai-sdk/openai` compiles `api.openai.com/v1`; neither looks at its vendor environment variable. A base URL that is read from the environment and then not handed to the constructor would type-check, start, and quietly send requests to the public API — the exact failure that is hardest to notice from the outside. So each provider's URL is read explicitly and passed explicitly, and there is a test that proves it is *used* rather than merely accepted: a `node:http` server on `127.0.0.1:0` answers 401 and records what it was asked for, and each provider has to arrive there under its own version prefix (`/v1`, `/v1beta`). A test asserting only that `createModel` returned a model would have passed against the bug.
- **One choice is inferred, and only one.** `NEXUS_PROVIDER` always wins when it is set. With no provider named, a base URL on its own selects `openai-compatible`, because a bare URL says nothing about which vendor's API is behind it — that is what "OpenAI-compatible" means. The inference fills in a provider and never a model: a run that still needs `NEXUS_MODEL` fails fast and says so, so it cannot quietly pick one.
- **A URL for the wrong provider warns.** Setting `OPENAI_BASE_URL` while running Claude used to do nothing, silently, which is how an afternoon gets lost to a variable that was exported in a shell profile. `createModel` now returns those warnings on the `ModelChoice` instead of printing them, so the library stays quiet and the CLI decides — one line to stderr, naming the variable and the provider it belongs to. It is a warning and not an error on purpose: a shared environment that sets several URLs is not a mistake.
- **`.env.example` would have broken the default.** It shipped `NEXUS_BASE_URL=http://localhost:11434/v1` uncommented. Under the new rule, a judge copying that file and setting an Anthropic key would have had `openai-compatible` inferred from a line they never looked at, then failed on the missing `NEXUS_MODEL`. It is commented out now, next to the three new overrides.
- `--base-url <url>` sets the variable belonging to the selected provider, and implies `openai-compatible` when no provider is named — the same rule, spelled the same way, for the command line.

194 tests across 21 files, typecheck and lint clean.

## 2026-10-16 (Day 5, later): a real model, and the two things it broke

Every run of the agent so far went through the scripted model. A real one was owed — the graph layer is only worth anything if an actual model, choosing its own tools, gets better answers out of it — so the agent was pointed at a live OpenAI-shaped gateway (DeepSeek) through the new base-URL override, against the same 522-file zod checkout. It worked, and it cost me two findings.

**The `openai` provider speaks the Responses API, and that is not a free choice.** `@ai-sdk/openai`'s `languageModel` is `createLanguageModel`, whose body is `return createResponsesModel(modelId)` — every request goes to `$OPENAI_BASE_URL/responses`, not `/chat/completions`. Turning the agent to DeepSeek with `NEXUS_PROVIDER=openai` indexed all 522 files (14,685 nodes, so the model had already called `nexus_sync` and got a result) and then died on the next turn:

```
Agent run failed: No tool call found for tool output with call_id call_00_KDp4cPqwkDe8ojWoazw87425.
```

DeepSeek does implement `/responses` — an empty body gets `422 missing field \`model\``, which is a real handler and not a 404, and a minimal call returns a complete `response` object — but its tool-result round trip rejects what the SDK sends back. The same server on `openai-compatible` (`/chat/completions`) ran the whole loop without complaint. So the working configuration is the generic provider, and the lesson is worth more than the run: a URL and a vendor name do not tell you which wire protocol is on the other end, and when they disagree the failure lands on the second request, not the first. Both this and the run contract below are now in the README.

**A stopped run printed its narration as the report, and exited 0.** The first live attempt was given twelve steps and needed thirteen. It ended with `finishReason: tool-calls` and the CLI printed *this* as the answer, with a success exit code:

```
Confirmed the symbol: a leaf with a wide fan-in. Now let me measure the impact breadth and verify a concrete public chain.
```

That is the sentence the model was saying as it reached for its last tool. `result.text` is the last step's text, so it is non-empty precisely when the run is unfinished, and worth nothing. My first guard checked whether the text was empty, which is the wrong test; the second run showed it printing 123 bytes of narration and passing that guard. What actually distinguishes the cases is the finish reason: `stop` means the model decided it was finished, `tool-calls` means it was stopped. `AgentRun.reported` is now that test and nothing else, the CLI writes to stdout only when a run is reported, quotes the narration on stderr otherwise, and exits non-zero. `DEFAULT_MAX_STEPS` went from 10 to 20, because 10 was chosen when the only evidence was a scripted six-step script.

**What the report was worth when it did finish.** Eleven steps, 25 tool calls, 6,605 bytes. It found 131 direct callers of `normalizeParams` and 461/646 at depths 2 and 3 — each figure labelled truncated rather than presented as a total — and verified individual two-hop chains (`mini string` → `_string` → `normalizeParams`) with `nexus_path` instead of asserting them. It recalled the memory left by the previous session and **re-verified it rather than trusting it**, which is what the prompt asks for and is the first time that instruction has been tested against a model that did not write it. And it surfaced something no earlier run had: `mini string` has 22 resolved callers including four test files, while `classic string` has 0, because classic call sites reach the factory through the namespace object (`z.string()`) and the indexer does not bind those. It reported that as a blind spot rather than as "nothing calls this".

The clearest evidence that the memory layer is doing something came from the two runs side by side: thirteen steps to reconstruct the picture from nothing, eleven when earlier sessions had left facts to check against. Track 02, observed rather than asserted.

197 tests across 22 files, typecheck and lint clean.
