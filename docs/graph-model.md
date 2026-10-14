# NEXUS graph model (sketch)

Status: schema diagram. This file is the reference for the graph model.

Edges that come from parsing are solid. Inferred edges carry `resolution` and `confidence` and are drawn dashed.

## Code layer

```mermaid
flowchart LR
    R["Repository<br/>id, root, indexedRevision, schemaVersion"]
    F["File<br/>id, path, hash, language, lineCount, indexedAt"]
    S["Symbol<br/>id, name, qualifiedName, kind, signature, startLine, endLine, doc"]

    R -- "HAS_FILE" --> F
    F -- "CONTAINS {ordinal}" --> S
    F -- "IMPORTS {specifier, resolution, confidence}" --> F
    S -. "POSSIBLY_CALLS {line, resolution, confidence}" .-> S
```

Resolution values for `IMPORTS` and `POSSIBLY_CALLS`:
- `resolved`: the type checker confirmed the target.
- `heuristic`: matched by name only.
- Unresolved references are stored as raw names on the caller and get no edge.

## Memory layer (Track 02)

```mermaid
flowchart LR
    U["User<br/>userId"]
    SE["Session<br/>id, agentId, userId, startedAt, summary"]
    T["Turn<br/>id, role, text, at"]
    FA["Fact<br/>id, text, scope, confidence, createdAt, updatedAt"]
    P["Procedure<br/>id, name, steps, usedCount"]
    H["Handoff<br/>id, fromAgent, toAgent, taskRef, createdAt"]

    U -- "OWNS" --> SE
    SE -- "HAS_TURN" --> T
    T -- "NEXT" --> T
    T -. "QUERIED {tool, args, graphVersion}" .-> S2["Symbol (code layer)"]
    T -- "TOUCHES" --> F2["File (code layer)"]
    SE -- "LEARNED" --> FA
    SE -- "USED" --> P
    H -- "FROM_SESSION" --> SE
    H -- "EVIDENCE" --> T
```

## Links between the layers

```mermaid
flowchart LR
    R2["Repository"] -- "SCOPES" --> SE2["Session"]
    FA2["Fact"] -. "ABOUT" .-> S3["Symbol"]
    P2["Procedure"] -. "APPLIES_TO" .-> F3["File"]
```

Every memory node carries `userId` and `repoId`. Every memory query filters on both.

## Indexes

| Target | Index | Used by |
|---|---|---|
| `File.path`, `Symbol.id` | range (unique lookup) | all traversals |
| `Symbol.name`, `Symbol.signature`, `Symbol.doc` | full-text | `nexus_locate` |
| `Fact.text`, `Turn.text` | full-text | `nexus_recall` |
| `Session.userId`, `Fact.userId`, `Turn.userId` | range | per-user isolation |

Vectors are deferred (first to be cut).
