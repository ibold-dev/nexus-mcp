# Wiring Nexus into an MCP client

Every file here points at the same server:

```
node <repo>/packages/mcp/dist/main.js
```

It speaks MCP over stdio, and it needs `NEXUS_ROOT` to know which repository to
index. Replace the `/absolute/path/to/...` placeholders before using a file.

| File | Goes | Notes |
| --- | --- | --- |
| `opencode.json` | your project root as `opencode.json`, or merge the `mcp` block into the one you have | OpenCode supports Nexus out of the box, no plugin needed |
| `claude-code.mcp.json` | your project root as `.mcp.json` | Claude Code prompts to approve the server the first time |
| `cursor.mcp.json` | `<project>/.cursor/mcp.json`, or `~/.cursor/mcp.json` for every project | Cursor reloads the server when the file changes |

Build first — the configs point at `dist/`:

```bash
pnpm install && pnpm build
docker compose up -d falkordb
```

## What the client gets

Eight tools. Reads never index: an empty graph is reported as empty, with a hint
pointing at `nexus_sync`, so an agent syncs rather than concluding the symbol does
not exist.

1. `nexus_sync` — index or re-index the repository; incremental after the first run.
2. `nexus_locate` — find a symbol by name, doc, or signature.
3. `nexus_context` — a symbol's source, signature, and its neighbours.
4. `nexus_path` — how one symbol reaches another, with each hop's confidence.
5. `nexus_impact` — who depends on a symbol, nearest first.
6. `nexus_remember` — write down a fact or a procedure.
7. `nexus_recall` — ask what earlier sessions learned.
8. `nexus_handoff` — summarise a session for whoever picks it up next.

`NEXUS_USER` and `NEXUS_GRAPH` decide whose memory is whose: recall only returns
what the same user stored in the same repository, so two people sharing a graph
never see each other's notes.

## Sharing one graph between clients

Point every client at the same `FALKORDB_URL` and `NEXUS_GRAPH`. The clients stay
independent — each is its own process — but they read and write one graph, so a
note written from OpenCode is recalled from Claude Code, and the change-impact
answer is computed once instead of once per client.
