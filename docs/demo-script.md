# Demo video script

Three minutes. The gate is in the plan: *the graph is necessary, the update is live, and
the agent's actions are explainable.* Every shot below is a command that runs, with the
output to expect, so the recording can be done in one pass.

## Pre-flight

```bash
cd nexus-mcp
pnpm build
docker compose up -d falkordb

# Warm the index so the recording does not spend 30 s on a cold sync.
export NEXUS_ROOT=/path/to/a/typescript/repo
export NEXUS_SYMBOL=normalizeParams
export NEXUS_PROVIDER=stub          # swap for anthropic if you are recording a live run
```

Then, in a second terminal, warm the graph and check the numbers you are about to quote:

```bash
node packages/agent/dist/main.js --symbol "$NEXUS_SYMBOL" >/dev/null
```

If the live model is slow or the network is unreliable, record with `NEXUS_PROVIDER=stub`.
Say so on camera — the scripted provider is the same harness, and pretending otherwise is
the one thing that would make this dishonest.

## The shots

### 1. The problem (0:00–0:25)

**Show:** a terminal, no slides.

**Say:** a coding agent starts every session with no memory and finds out what code does by
reading files. Here is a question it is asked constantly — *what breaks if I change this?*
— and here is what the honest answer costs: 145 files mention `ZodError`; reading them is
60,000 tokens, and reading them still does not say which one defines it.

**Show:** `bench/results/*.json`, the raw numbers.

### 2. The graph (0:25–0:50)

**Show:** the FalkorDB Browser at <http://localhost:3000>, query:

```cypher
MATCH (s:Symbol)-[c:POSSIBLY_CALLS]->(t:Symbol)
RETURN s.qualifiedName, t.qualifiedName, c.resolution, c.confidence
LIMIT 25
```

**Say:** this is the repository, parsed — not grepped. Nodes are files and symbols; edges
are imports and calls. Each call edge says how it was established: `resolved` when the
type checker confirmed it, `heuristic` when only the name matched. Nothing was guessed
into an edge.

### 3. Change impact, with citations (0:50–1:35)

**Show:**

```bash
node packages/agent/dist/main.js --symbol "$NEXUS_SYMBOL"
```

**Expected:** a report naming the defining file, and the callers with file, hop count and
edge resolution — for zod's `normalizeParams`, 12 callers in 1 file, all one hop away,
all `resolved`.

**Say:** every line of that report came from a traversal, and it says how it knows. The
agent did not read a file to answer this. It asked the graph once.

**Show:** the tool trace on stderr (`step 1: nexus_sync`, `step 2: nexus_locate`,
`step 3: nexus_impact`, …).

**Say:** that is the whole run — sync, locate, impact, recall, remember. Five calls, and
you can see each one.

### 4. The handoff (1:35–2:15) — the shot that matters

**Show:** two separate processes.

```bash
node apps/demo/dist/handoff.js write
node apps/demo/dist/handoff.js read
```

**Expected:** the first prints the sync, the callers it found, and that it remembered a
fact, a procedure and a handoff. The second prints what it recalled — the same fact, the
procedure's steps, the handoff with its evidence turns — and exits 0 only if it found
them.

**Say:** two processes, no shared memory, one graph. The second run is a different
process with an empty context, and it knows what the first one worked out. That is the
whole of the second track, and it is not a diagram — that is the exit code.

### 5. What it costs (2:15–2:50)

**Show:** the table from the README, or:

```bash
node bench/dist/run.js --root "$NEXUS_ROOT" --runs 2
```

**Say:** three tasks, both conditions, same scripted model — the only difference is the
toolset. The baseline is not a straw man: it reads every file that mentions the name. And
the table says what it does not show: the graph cannot be queried until it is built, and
building it cost about 30 seconds. It is paid once per repository, not once per question.

### 6. Where it plugs in (2:50–3:00)

**Show:** `examples/opencode.json`, and the same eight tools inside OpenCode's tool list.

**Say:** it is an MCP server, so OpenCode, Claude Code and Cursor get the same tools, and
they share one graph. Nothing here is a bespoke integration.

## If something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| "The repository has not been indexed" | the sync was skipped | run `nexus_sync`, or just rerun the command |
| Locate returns nothing on a repository that has the symbol | a cold sync was cut off at the client's old 60 s default | fixed in `484ebf0`; if it recurs, raise `SYNC_TIMEOUT_MS` |
| The live model stalls | network | rerecord with `NEXUS_PROVIDER=stub` and say so |

## Do not claim on camera

- Do not call the impact list a guarantee. It is a map of likely impact built from edges
  the index could resolve, and the report says so.
- Do not present a heuristic edge as certain. The report labels every hop.
- Do not imply the benchmark measures a model. It measures what the tooling requires.
