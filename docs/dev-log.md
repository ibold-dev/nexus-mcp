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
