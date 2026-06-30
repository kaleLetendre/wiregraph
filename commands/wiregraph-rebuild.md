---
description: Full from-scratch rebuild of this project's wiregraph (the correctness backstop)
argument-hint: "[target-dir] (defaults to the active project)"
allowed-tools: Bash
---

Rebuild the project's graph from scratch. Incremental updates are approximate for
*incoming* call edges to renamed/removed symbols; a full rebuild is the clean
backstop. Use after big refactors, renames, or whenever a trace looks wrong.

**Target:** `$1` if provided, else the active project (`${CLAUDE_PROJECT_DIR}` or
cwd). Call it `<TARGET>`.

Preferred: **call the `update_graph` MCP tool with `{ "full": true }`** — it does a
project-scoped reset + rebuild and refreshes the state. Report the new stats.

If the MCP tool is unavailable, run the build directly (this only deletes and
rebuilds THIS project's graph in its own `.wiregraph/graph.db`), then reseed state:

```
node ${CLAUDE_PLUGIN_ROOT}/src/build.js "<TARGET>" --reset
node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs seed "<TARGET>"
```

Report the final graph stats (repos, files, symbols, contracts, edges).
