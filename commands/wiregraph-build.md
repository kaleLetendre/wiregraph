---
description: Build/refresh the wiregraph call+association graph for a folder into its embedded SQLite db
argument-hint: "[target-dir] (defaults to the current directory)"
allowed-tools: Bash
---

Build the wiregraph graph for the target folder into `<target>/.wiregraph/graph.db`
so the `wiregraph` MCP tools can query it. No daemon required.

Target directory: `$1` (if empty, use the current working directory).

Steps:

1. Build and load the graph (use `--reset` to replace the previous graph rather
   than merge into it):

   ```
   node ${CLAUDE_PLUGIN_ROOT}/src/build.js "<target>" --reset
   ```

   If it reports a missing native module, install dependencies first:
   `npm install --prefix ${CLAUDE_PLUGIN_ROOT} --legacy-peer-deps`.

2. Report the final graph stats (repos, files, symbols, contracts, edge counts)
   back to the user, and remind them the `wiregraph` MCP tools (graph_stats,
   find_symbol, get_source, trace_callees, trace_callers, trace_contract,
   path_between, query_sql) are now queryable.

Note: cross-compartment edges are discovered through an AsyncAPI contracts directory
under the target (a `contracts`, `asyncapi`, or `*-contracts` dir), if present.
CALLS edges are within-compartment by design; cross-compartment links flow through
Contract nodes (see `trace_contract` / `path_between`).
