# codegraph

codegraph indexes your codebase into a structured graph of its symbols and how they
connect. Instead of grepping and reading whole files, Claude reads the exact slice it
needs from that graph — answering the same questions just as accurately for **about half
the tokens** (40–60% fewer in held-out A/B tests). Less to read also means **faster
answers and lower cost**. Embedded, no daemon, nothing to compile. **Set it up once and
forget it.**

```mermaid
flowchart LR
  Q(["a code question"]) --> a1
  Q --> b1
  subgraph WO["Without codegraph"]
    direction TB
    a1["grep the whole tree"] --> a2["read whole files"] --> a3["answer<br/><b>full token cost</b>"]
  end
  subgraph WI["With codegraph"]
    direction TB
    b1["query the graph"] --> b2["read just the symbol"] --> b3["same answer<br/><b>~half the cost · faster</b>"]
  end
```

## Contents
- [Install](#install)
- [Index a repo (once)](#index-a-repo-once)
- [What Claude can do](#what-claude-can-do)
- [Languages](#languages)
- [How it works](#how-it-works)

## Install

Three lines, nothing compiles:

```
/plugin marketplace add kaleLetendre/codegraph
/plugin install codegraph@codegraph
/reload-plugins
```

## Index a repo (once)

One time per repo, run:

```
/codegraph-init
```

That's the whole job — **once per repo, never again**. It builds the graph, points Claude
at it, and keeps itself current as you edit (set and forget). From then on just talk to
Claude normally ("where is X", "what calls Y", "what breaks if I change Z", "how does A
reach B") and it answers from the graph — cheaper and faster. Nothing else to run, ever.

Rarely needed: `/codegraph-status` (health), `/codegraph-rebuild` (after a big refactor),
`/codegraph-remove` (uninstall from a repo).

## What Claude can do

| Tool | Answers |
|---|---|
| `find_symbol` | where something is defined |
| `get_source` | one symbol's body (not the whole file) |
| `trace_callees` / `trace_callers` | what it calls / who calls it — whole tree, one query |
| `trace_contract` / `path_between` | how code connects, across repos, via shared contracts |
| `query_sql` | read-only SQL for anything else |
| `graph_status` / `update_graph` | check freshness / refresh |

You don't call these — Claude does, automatically.

## Languages

**C** and **TypeScript / JavaScript** today. Adding Python, Java, etc. is small: drop in
the tree-sitter grammar plus two short rules (what counts as a definition, what counts as
a call). Everything downstream is language-agnostic.

## How it works

```mermaid
flowchart LR
  src["your code<br/>C · TS/JS"] --> ts["tree-sitter<br/>parse"] --> db[("graph.db<br/>symbols + how<br/>they connect")]
  db --> mcp["codegraph<br/>MCP tools"] --> claude(["Claude reads<br/>only what it needs"])
  edit["you edit code"] -. auto re-index .-> db
```

Tree-sitter parses your files into symbols and call sites and stores them in one
per-project SQLite file (`<project>/.codegraph/graph.db`). Calls resolve within a repo;
cross-repo links flow through shared API/contract nodes. Edits re-index a file at a time
via hooks, so the graph stays fresh without you touching it.
