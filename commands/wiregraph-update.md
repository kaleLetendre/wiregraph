---
description: Incrementally refresh the wiregraph for this project (re-index files changed since the last index)
argument-hint: "(no args — refreshes the active project)"
allowed-tools: Bash
---

Bring the wiregraph up to date with the current code, cheaply. This re-indexes
only the source files that changed since the last index (git diff + uncommitted
edits) — it does not rebuild the whole graph.

Preferred: **call the `update_graph` MCP tool with no arguments.** It auto-detects
changed files for the active project, re-indexes them, and advances the stored
git shas. Report what it re-indexed.

If the MCP tool is unavailable, fall back to the background worker against the
active project:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/refresh.mjs
```

When to use this vs `/wiregraph-rebuild`: incremental update is right after normal
edits. After large refactors or renames (where incoming call edges to a renamed
symbol may dangle), use `/wiregraph-rebuild` for a clean from-scratch graph.
