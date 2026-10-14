# NEXUS: working rules for agents

These rules apply to every session in this repository.

## Commit discipline (mandatory)

- One commit per milestone. Never batch milestones.
- A milestone is complete only when its tests pass and its gate check is verified.
- Message format: `type(scope): summary` where type is feat, fix, test, docs, chore, or refactor. Put what was verified in the body.
- Stage files explicitly. No `git add -A` or `git add .`.
- Never commit `.env*`, keys, credentials, lock files, or generated `graphify-out/` artifacts unless intended.
- Push to the public remote after each gate day.

## Architecture rules

- TypeScript throughout (Node 22+). FalkorDB is the source of truth for code graph, retrieval, algorithms, and memory.
- Parser: ts-morph. Every inferred edge carries `resolution` and `confidence`. Never fabricate an edge to a guessed target.
- Re-resolve inbound edges when a file changes.
- Memory queries always filter on `userId` and `repoId`.
- Agents do not get raw Cypher. Only the MCP tool contracts.
- Secrets (`.env*`, `*.pem`, `*.key`) are never indexed.

## Scope rules

- Track 01 is primary. Track 02 is secondary and requires persistence across separate runs.
- Cut order: vectors, hosted deploy, watcher, procedural memory, second agent role. Never cut the core MVP: graph-backed locate and context, one explainable path, verified incremental update, the cited agent report, and local setup.
