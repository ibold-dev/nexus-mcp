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
